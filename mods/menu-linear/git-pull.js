// Git operations are injected so the safety checks can run against disposable repos.
export async function inspectPull(git) {
  const top = await git(["rev-parse", "--show-toplevel"]);
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== "main") throw new Error("Pull은 main 브랜치에서만 실행할 수 있습니다.");
  const head = await git(["rev-parse", "HEAD"]);
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const remote = await git(["config", "--get", `branch.${branch}.remote`]);
  const ref = await git(["config", "--get", `branch.${branch}.merge`]);
  return { top, branch, head, upstream, remote, ref };
}

export async function safePull(git, expected, checkAgents) {
  const validate = async () => {
    const now = await inspectPull(git);
    if (["top", "branch", "head", "upstream", "remote", "ref"].some(k => now[k] !== expected[k]))
      throw new Error("브랜치나 원격 설정이 바뀌었습니다. 메뉴를 다시 열어 주세요.");
    if (await git(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]))
      throw new Error("커밋하지 않은 변경 파일이 있습니다. 커밋하거나 직접 정리한 뒤 다시 실행해 주세요.");
    // Git resolves these paths per worktree, including linked worktrees.
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"])
      if (await git(["rev-parse", "--git-path", name], { exists: true }))
        throw new Error("병합·리베이스 등 진행 중인 Git 작업을 먼저 마쳐 주세요.");
    await checkAgents(expected.top);
  };
  await validate();
  // A private ref prevents another terminal's fetch from replacing our target.
  const fetched = `refs/herdr/pull/${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await git(["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--", expected.remote, `${expected.ref}:${fetched}`]);
    const target = await git(["rev-parse", "--verify", `${fetched}^{commit}`]);
    // Fetch can take time: recheck before touching working files.
    await validate();
    await git(["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--no-autostash", "--no-edit", target]);
    return { upstream: expected.upstream, changed: (await git(["rev-parse", "HEAD"])) !== expected.head };
  } finally {
    await git(["update-ref", "-d", fetched]);
  }
}
