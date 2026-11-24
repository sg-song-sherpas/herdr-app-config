import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { byId } from "../fakes/element.mjs";
import Tabs from "../../mods/tabs-linear/main.js";

let panel, body;
beforeEach(() => {
  host.reset();
  localStorage.clear();
  host.spaces = ["a", "b"].map(id => ({ id, active: id === "a", tabs: [{ id: `tab-${id}`, active: true, name: id }] }));
  body = { id: "panel-body", active: "files" };
  panel = { id: "panel", hidden: true, children: [body] };
  host.layout = { id: "root", children: [panel] };
});

async function mount() {
  const cx = makeCx(), v = new Tabs();
  v.init({}, cx);
  await cx.settle();
  paint(v);
  return { v, cx };
}

// Layout commands land asynchronously in Herdr, after the render that sent them.
function applyCommands() {
  for (const [name, args] of host.runs.splice(0)) {
    if (name === "layout.select") body.active = args.child;
    if (name === "layout.show") panel.hidden = false;
    if (name === "layout.hide") panel.hidden = true;
  }
}
function paint(v) {
  v.render();
  applyCommands();
  v.render();
}
function select(v, id) {
  host.spaces.forEach(s => { s.active = s.id === id; });
  paint(v);
}
function click(v, cx, id) {
  byId(v.render(), `panel-${id}`).handlers.on_click({}, cx);
  applyCommands();
  paint(v);
}

test("Linear stays open across worktrees and closing it applies to every worktree", async () => {
  const { v, cx } = await mount();
  click(v, cx, "linear");
  select(v, "b");
  assert.equal(panel.hidden, false);
  assert.equal(body.active, "linear");
  click(v, cx, "linear");
  select(v, "a");
  assert.equal(panel.hidden, true);
});

test("old per-worktree Linear choices cannot reopen it after it is closed elsewhere", async () => {
  localStorage.setItem("panels", JSON.stringify({ a: "linear", b: "linear" }));
  panel.hidden = false;
  body.active = "linear";
  const { v, cx } = await mount();
  click(v, cx, "linear");
  select(v, "b");
  assert.equal(panel.hidden, true);
});

test("the global Linear choice survives remounting in a different worktree", async () => {
  const { v, cx } = await mount();
  click(v, cx, "linear");
  host.spaces.forEach(s => { s.active = s.id === "b"; });
  panel.hidden = true;
  body.active = "files";
  await mount();
  assert.equal(panel.hidden, false);
  assert.equal(body.active, "linear");
});

test("Files and Changes still follow their worktrees when Linear is closed", async () => {
  const { v, cx } = await mount();
  click(v, cx, "files");
  select(v, "b");
  click(v, cx, "changes");
  select(v, "a");
  assert.equal(body.active, "files");
  assert.equal(panel.hidden, false);
  click(v, cx, "linear");
  select(v, "b");
  click(v, cx, "linear");
  select(v, "a");
  assert.equal(body.active, "files");
  assert.equal(panel.hidden, false);
});

test("keyboard and search layout commands share the same global Linear state", async () => {
  const { v, cx } = await mount();
  host.command("linear");
  await cx.settle();
  applyCommands();
  paint(v);
  select(v, "b");
  assert.equal(panel.hidden, false);
  host.command("linear");
  await cx.settle();
  applyCommands();
  paint(v);
  select(v, "a");
  assert.equal(panel.hidden, true);
  // Search reveals the layout directly, rather than clicking the tab bar.
  panel.hidden = false;
  body.active = "linear";
  paint(v);
  select(v, "b");
  assert.equal(panel.hidden, false);
  assert.equal(body.active, "linear");
});
