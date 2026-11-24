import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import Worktree from "../../mods/worktree/main.js";

beforeEach(() => { host.reset(); localStorage.clear(); });

for (const name of ["로그인 오류를 수정한다", undefined]) {
  test(`worktree creates a space with ${name ? "the issue title" : "the default folder name when no title is supplied"}`, async () => {
    host.props = { folder: "/repo/basecamp", action: "new", branch: "feature/prd-10355", name };
    host.exec = async (_cmd, args) => ({ code: args.includes("show-ref") ? 1 : 0,
      stdout: args.includes("--git-common-dir") ? "/repo/basecamp/.git" : args.includes("--show-toplevel") ? "/repo/basecamp" : "", stderr: "" });
    const cx = makeCx();
    const v = new Worktree();
    v.init({}, cx);
    await cx.settle();
    const [space] = host.ran("space.new");
    assert.ok(space);
    assert.equal(space.name, name);
    assert.equal(space.folder, "/home/test/.herdr/worktrees/basecamp/feature-prd-10355");
    assert.ok(host.execs.some(([, args]) => args.includes("worktree") && args.includes("feature/prd-10355")));
  });
}
