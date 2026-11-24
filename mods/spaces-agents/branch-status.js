// Read-only GitHub state; callers cache by machine, checkout, branch and commit.
export function githubRemote(value) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)\/?$/.exec(value.trim().replace(/\.git$/, ""));
  return match ? `${match[1]}/${match[2]}` : null;
}
const failures = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
export function describePull(pull) {
  const failed = (pull.statusCheckRollup ?? []).filter(c => failures.has(c.conclusion || c.state));
  const state = pull.state === "MERGED" ? "merged" : pull.state === "CLOSED" ? "closed" : pull.isDraft ? "draft" : "review";
  const label = { merged: "머지됨", closed: "PR 닫힘", draft: "Draft", review: "In Review" }[state];
  return { state, failed: state === "draft" || state === "review" ? failed.length : 0,
    label: `${label} · PR #${pull.number}${failed.length && (state === "draft" || state === "review") ? ` · CI 실패 ${failed.length}개` : ""}` };
}
export async function readBranchStatus(exec, cwd, on, branch, oid, requests = new Map()) {
  const ask = async (command, args) => {
    const r = await exec(command, args, { cwd, on, timeout: 15000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "조회 실패").trim().slice(0, 180));
    return r.stdout;
  };
  // Reuse repository deployment/status requests within one refresh batch.
  const api = path => {
    const key = JSON.stringify([on ?? null, repo, path]);
    if (!requests.has(key)) requests.set(key, ask("gh", ["api", path]).then(JSON.parse));
    return requests.get(key);
  };
  if (!branch || branch === "(detached)" || !oid || oid === "(initial)") return { state: "unknown", label: "브랜치 상태 확인 불가 · 브랜치 또는 커밋 없음" };
  const repo = githubRemote(await ask("git", ["remote", "get-url", "origin"]));
  if (!repo) return { state: "unknown", label: "브랜치 상태 확인 불가 · GitHub origin 없음" };
  const pulls = JSON.parse(await ask("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "30", "--json", "number,state,isDraft,headRefOid,headRepository,mergeCommit,statusCheckRollup,updatedAt"]));
  // A same-named branch from a fork or an old branch incarnation is not this checkout.
  const matching = pulls.filter(p => (p.state === "OPEN" || p.headRefOid === oid) && p.headRepository?.nameWithOwner?.toLowerCase() === repo.toLowerCase())
    .sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.updatedAt.localeCompare(a.updatedAt));
  const pull = matching[0];
  if (!pull) return { state: "none", label: "PR 없음" };
  const result = describePull(pull);
  if (pull.state === "OPEN" && pull.headRefOid !== oid) result.label += " · 로컬 커밋과 PR 커밋이 다름";
  if (result.state !== "merged" || !pull.mergeCommit?.oid) return result;
  try {
    const deployments = (await api(`repos/${repo}/deployments?per_page=100`))
      .filter(d => !d.transient_environment && (d.production_environment === true || /^(production|prod)$/i.test(d.environment)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    // Only the newest deployment per environment counts; an older success must
    // not hide a subsequent failure, rollback or deactivation.
    const seen = new Set();
    for (const d of deployments) {
      if (seen.has(d.environment)) continue;
      seen.add(d.environment);
      const statuses = await api(`repos/${repo}/deployments/${d.id}/statuses?per_page=1`);
      if (statuses[0]?.state !== "success") continue;
      let included = d.sha === pull.mergeCommit.oid;
      if (!included) {
        const comparison = await api(`repos/${repo}/compare/${pull.mergeCommit.oid}...${d.sha}`);
        included = comparison.status === "ahead" || comparison.status === "identical";
      }
      if (included) return { state: "deployed", label: `운영 배포 완료 · ${d.environment} · PR #${pull.number} · ${d.sha.slice(0, 7)}` };
    }
  } catch { return { ...result, deploymentUnknown: true, label: `${result.label} · 배포 상태 확인 불가` }; }
  return result;
}

export class BranchStatusCache {
  constructor() { this.entries = new Map(); this.running = false; }
  key(cwd, on, g) { return JSON.stringify([on ?? null, cwd, g.branch, g.oid]); }
  get(cwd, on, g) { return g ? this.entries.get(this.key(cwd, on, g))?.value : null; }
  async refresh(targets, exec, changed, now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const live = new Set(targets.map(x => this.key(x.cwd, x.on, x.g)));
      for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
      const requests = new Map();
      for (const { cwd, on, g } of targets) {
        const key = this.key(cwd, on, g);
        if (now - (this.entries.get(key)?.at ?? -Infinity) < 60000) continue;
        const previous = this.entries.get(key)?.value;
        // Refresh in the background without replacing a confirmed icon.
        this.entries.set(key, { at: now, value: previous ?? { state: "unknown", label: "브랜치 상태 확인 중" } });
        let value;
        try { value = await readBranchStatus(exec, cwd, on, g.branch, g.oid, requests); }
        catch (error) { value = { state: "unknown", label: `브랜치 상태 확인 불가 · ${String(error.message ?? error)}` }; }
        const unavailable = value.state === "unknown" || (value.deploymentUnknown && previous?.state === "deployed");
        if (unavailable && previous && previous.state !== "unknown") {
          value = { ...previous, stale: true, label: `${previous.confirmedLabel ?? previous.label} · 최신 조회 실패 (마지막 확인 상태)`, confirmedLabel: previous.confirmedLabel ?? previous.label };
        }
        this.entries.set(key, { at: Date.now(), value });
        changed();
      }
    } finally { this.running = false; }
  }
}
