// The tab bar's Sketch button against a fake host.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { walk, byId } from "../fakes/element.mjs";
import Tabs from "../../mods/tabs-linear/main.js";

beforeEach(() => {
  host.reset();
  localStorage.clear();
  host.spaces = [{ id: "s", active: true, folder: "/repo/worktree", machine: null, tabs: [{ id: "t", name: "1", active: true }] }];
  host.layout = { id: "root", children: [{ id: "panel", hidden: true, children: [{ id: "panel-body", type: "stack", active: "files" }] }] };
});

async function mount() {
  const cx = makeCx();
  const v = new Tabs();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}

test("the Sketch button sits right after Linear", async () => {
  const { v } = await mount();
  const order = [...walk(v.render())].map((e) => e.props.id).filter((id) => /^(panel|pane)-/.test(String(id)));
  assert.deepEqual(order.slice(-2), ["panel-linear", "pane-sketch"]);
  assert.ok(existsSync(new URL("../../mods/Sketch/sketch.svg", import.meta.url)), "its icon exists");
});

test("it opens a Sketch pane, or closes this tab's one", async () => {
  const { v, cx } = await mount();
  byId(v.render(), "pane-sketch").handlers.on_click({}, cx);
  assert.deepEqual(host.ran("pane.split"), [{ direction: "right", mod: "Sketch", props: { folder: "/repo/worktree", machine: null } }]);
  host.panes = [{ pane: "pz", mod: "Sketch", tab: "t" }];
  const button = byId(v.render(), "pane-sketch");
  assert.equal(button.props.bg, host.theme.selected, "lit while open");
  button.handlers.on_click({}, cx);
  assert.deepEqual(host.ran("pane.close"), [{ pane: "pz" }]);
});

test("a Sketch pane in another tab doesn't count", async () => {
  host.panes = [{ pane: "pz", mod: "Sketch", tab: "elsewhere" }];
  const { v, cx } = await mount();
  byId(v.render(), "pane-sketch").handlers.on_click({}, cx);
  assert.equal(host.ran("pane.split").length, 1);
});

test("numeric tabs show the same live task title as sidebar agents", async () => {
  host.panes = [{ pane: "p", terminal: "a", tab: "t", title: "✳ 검색 구현", program: { name: "Codex", key: "codex", agent: true } }];
  const { v } = await mount();
  const { text } = await import("../fakes/element.mjs");
  assert.equal(text(byId(v.render(), "tab-t")), "검색 구현");
});

test("explicit short task names stay visible when the agent title changes", async () => {
  host.spaces[0].tabs[0] = { id: "t", name: "테스트 검증", named: true, active: true };
  host.panes = [{ pane: "p", terminal: "a", tab: "t", title: "Codex", program: { name: "Codex", key: "codex", agent: true } }];
  const { v } = await mount();
  const { text } = await import("../fakes/element.mjs");
  assert.equal(text(byId(v.render(), "tab-t")), "테스트 검증");
});

for (const zoom of [1, 1.1]) {
  test(`double-click renames a tab in place at zoom ${zoom}`, async () => {
    host.settings.zoom = zoom;
    host.spaces[0].tabs[0] = { id: "t", name: "검색 구현", named: true, active: true };
    const { v, cx } = await mount();
    byId(v.render(), "tab-t").handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
    assert.deepEqual(host.ran("tab.rename"), []);
    const editor = byId(v.render(), "rename-t");
    assert.ok(editor);
    const input = [...walk(editor)].find(e => e.kind === "input");
    assert.equal(input.arg.value(), "검색 구현");
    input.arg.type("테스트 검증", cx);
    input.arg.submit(cx);
    assert.deepEqual(host.ran("tab.rename"), [{ id: "t", name: "테스트 검증" }]);
    assert.equal(byId(v.render(), "rename-t"), null);
  });
}

test("Escape discards an inline rename without opening a dialog or selecting the tab", async () => {
  const { v, cx } = await mount();
  byId(v.render(), "tab-t").handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
  const editor = byId(v.render(), "rename-t");
  const input = [...walk(editor)].find(e => e.kind === "input");
  input.arg.type("discard me", cx);
  editor.handlers.on_key_down({ keystroke: "escape" }, cx);
  assert.equal(byId(v.render(), "rename-t"), null);
  assert.deepEqual(host.ran("tab.rename"), []);
  assert.deepEqual(host.ran("tab.select"), []);
  assert.deepEqual(host.overlays, []);
});

test("a blank inline name is discarded instead of resetting the task title", async () => {
  const { v, cx } = await mount();
  byId(v.render(), "tab-t").handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
  const input = [...walk(byId(v.render(), "rename-t"))].find(e => e.kind === "input");
  input.arg.type("  ", cx);
  input.arg.submit(cx);
  assert.deepEqual(host.ran("tab.rename"), []);
  assert.equal(byId(v.render(), "rename-t"), null);
});

// The layout shortcut uses the same worktree-aware entry point as the button.
test("the Sketch command opens the current worktree board and toggles it closed", async () => {
  const { cx } = await mount();
  host.command("sketch");
  await cx.settle();
  assert.deepEqual(host.ran("pane.split"), [{ direction: "right", mod: "Sketch", props: { folder: "/repo/worktree", machine: null } }]);
  host.panes = [{ pane: "pz", mod: "Sketch", tab: "t" }];
  host.command("sketch");
  await cx.settle();
  assert.deepEqual(host.ran("pane.close"), [{ pane: "pz" }]);
});
