// Resolve the clicked row, never the currently selected workspace or tab.
export function pullRequestTarget(p, spaces, panes) {
  if (!["space", "tab", "agent"].includes(p?.tab)) return null;
  const id = p.tab === "space" ? p.target?.id : p.target?.space;
  const space = spaces.find(s => s.id === id);
  if (!space) return null;
  const own = p.tab === "space"
    ? panes.filter(pane => (space.tabs ?? []).some(tab => tab.id === pane.tab))
    : panes.filter(pane => pane.tab === p.target?.id);
  const folder = own.find(pane => pane.terminal === p.target?.terminal && pane.cwd)?.cwd
    || own.find(pane => pane.cwd)?.cwd || space.folder;
  return folder ? { space, folder } : null;
}

export async function readPullRequest(exec, cwd, on) {
  const ask = async (command, args) => {
    const result = await exec(command, args, { cwd, on, timeout: 15000 });
    if (result.code !== 0) throw new Error("PR 조회 실패");
    return result.stdout.trim();
  };
  const branch = await ask("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return null;
  const origin = await ask("git", ["remote", "get-url", "origin"]);
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)\/?$/.exec(origin.replace(/\.git$/, ""));
  if (!match) return null;
  const repo = `${match[1]}/${match[2]}`;
  const oid = await ask("git", ["rev-parse", "HEAD"]);
  const pulls = JSON.parse(await ask("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "30", "--json", "url,number,state,headRefOid,headRepository,updatedAt"]));
  return pulls.filter(p => p.headRepository?.nameWithOwner?.toLowerCase() === repo.toLowerCase()
      && (p.state === "OPEN" || p.headRefOid === oid)
      && new RegExp(`^https://github\\.com/${repo}/pull/[0-9]+$`, "i").test(p.url))
    .sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}
