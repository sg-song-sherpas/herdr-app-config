import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { InlineRename as SidebarRename } from "../../mods/spaces-agents/inline-rename.js";
import { InlineRename as TabRename } from "../../mods/tabs-linear/inline-rename.js";

beforeEach(() => { host.reset(); localStorage.clear(); });

for (const [mod, Rename] of [["spaces-agents", SidebarRename], ["tabs-linear", TabRename]]) {
  test(`${mod}: saving a name also syncs only this tab's Codex sessions`, async () => {
    host.panes = [
      { tab: "t1", terminal: "a1", app: "codex" },
      { tab: "t1", terminal: "shell", program: { shell: true } },
      { tab: "t2", terminal: "a2", app: "codex" },
    ];
    const cx = makeCx(), rename = new Rename(cx);
    rename.begin("t1", "old", cx);
    rename.input.type("로그인 수정", cx);
    rename.input.submit(cx);
    // Blur after submit must not send a second rename.
    rename.finish(true, cx);
    await cx.settle();
    assert.deepEqual(host.ran("tab.rename"), [{ id: "t1", name: "로그인 수정" }]);
    assert.equal(host.execs.length, 1);
    assert.equal(host.execs[0][0], "python3");
    assert.equal(host.execs[0][1][0], `/app/mods/${mod}/codex-rename.py`);
    assert.deepEqual(JSON.parse(host.execs[0][1][1]), { terminals: ["a1"], name: "로그인 수정" });
  });

  test(`${mod}: cancel and non-Codex tabs never invoke the bridge`, async () => {
    const cx = makeCx(), rename = new Rename(cx);
    rename.begin("t1", "old", cx);
    rename.input.type("new", cx);
    rename.finish(false, cx);
    rename.begin("t1", "old", cx);
    rename.input.type("new", cx);
    rename.finish(true, cx);
    await cx.settle();
    assert.equal(host.execs.length, 0);
  });

  test(`${mod}: a bridge failure leaves the tab saved and reports the failed sync`, async () => {
    host.panes = [{ tab: "t1", terminal: "a1", app: "codex" }];
    host.exec = async () => ({ code: 1, stderr: "대화 이름이 중복됩니다." });
    const cx = makeCx(), rename = new Rename(cx);
    rename.begin("t1", "old", cx);
    rename.input.type("new", cx);
    rename.input.submit(cx);
    await cx.settle();
    assert.deepEqual(host.ran("tab.rename"), [{ id: "t1", name: "new" }]);
    assert.equal(host.notifications.length, 1);
    assert.match(host.notifications[0].body, /대화 이름이 중복됩니다/);
    assert.equal(cx.errors.length, 0);
  });

  test(`${mod}: confirming an existing tab name repairs an out-of-sync session`, async () => {
    host.panes = [{ tab: "t1", terminal: "a1", app: "codex" }];
    const cx = makeCx(), rename = new Rename(cx);
    rename.begin("t1", "이미 바꾼 탭 이름", cx);
    rename.input.submit(cx);
    await cx.settle();
    assert.deepEqual(host.ran("tab.rename"), []);
    assert.equal(host.execs.length, 1);
    assert.equal(JSON.parse(host.execs[0][1][1]).name, "이미 바꾼 탭 이름");
  });
}

test("both rename bridges stay identical", async () => {
  for (const file of ["codex-rename.py"]) {
    assert.equal(await readFile(new URL(`../../mods/spaces-agents/${file}`, import.meta.url), "utf8"),
      await readFile(new URL(`../../mods/tabs-linear/${file}`, import.meta.url), "utf8"));
  }
});
