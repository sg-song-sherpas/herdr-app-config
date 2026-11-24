import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host, DARK } from "herdr";
import { makeCx, mouse, key } from "../fakes/cx.mjs";
import { byId, all, text } from "../fakes/element.mjs";
import Sketch, { points } from "../../mods/Sketch/main.js";

const FILE = "/app/data/sketch/board.json";
const PATCH = "diff --git a/설정.js b/설정.js\n--- a/설정.js\n+++ b/설정.js\n@@ -8,2 +8,2 @@\n const count = 1;\n-const enabled = false;\n+const enabled = true;";
beforeEach(() => { host.reset(); localStorage.clear(); });

async function mount(shapes = []) {
  host.files.set(FILE, JSON.stringify({ version: 1, shapes }));
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx);
  await cx.settle();
  await cx.flush();
  return { v, cx };
}
const diff = (extra = {}) => ({ id: "change", type: "diff", x: 0, y: 0, w: 560, h: 280, text: PATCH, ...extra });
const press = (v, cx, k) => v.render().handlers.on_key_down(key(k), cx);

test("the Shapes palette creates an editable diff card at its usual size with Herdr zoomed", async () => {
  host.settings.zoom = 1.1;
  const { v, cx } = await mount();
  press(v, cx, "k");
  const tile = byId(v.render(), "shape-diff");
  assert.ok(tile, "Diff is offered in Shapes");
  tile.handlers.on_click({}, cx);
  const canvas = byId(v.render(), "sketch-canvas");
  canvas.handlers["on_mouse_down:left"](mouse(330, 220), cx);
  canvas.handlers["on_mouse_up:left"](mouse(330, 220), cx);
  await cx.flush();
  const [s] = JSON.parse(host.files.get(FILE)).shapes;
  assert.equal(s.type, "diff");
  assert.ok(s.w >= 500 && s.h >= 240);
  assert.match(s.text, /\n-.*\n\+/);
  assert.equal(v.tool, "select");
  assert.ok(byId(v.render(), `diff-${s.id}`));
});

test("diff rows distinguish metadata, deletion and addition and show both line numbers", async () => {
  const { v } = await mount([diff()]);
  const root = v.render(), card = byId(root, "diff-change");
  assert.ok(card);
  assert.match(text(card), /설정.js/);
  const removed = all(card, (e) => text(e) === "-const enabled = false;").at(-1);
  const added = all(card, (e) => text(e) === "+const enabled = true;").at(-1);
  assert.ok(removed && added);
  assert.notEqual(byId(root, "diff-change-row-5").props.text_color, byId(root, "diff-change-row-6").props.text_color);
  assert.match(text(byId(root, "diff-change-row-5")), /9.*-const enabled = false;/);
  assert.match(text(byId(root, "diff-change-row-6")), /9.*\+const enabled = true;/);
  const fileHeader = byId(root, "diff-change-row-2");
  assert.notEqual(fileHeader.props.bg, byId(root, "diff-change-row-6").props.bg, "+++ is metadata");
  host.theme = DARK;
  assert.ok(byId(v.render(), "diff-change"));
});

test("diff editing preserves the full patch, saves it and supports undo", async () => {
  const { v, cx } = await mount([diff()]);
  const canvas = byId(v.render(), "sketch-canvas");
  canvas.handlers["on_mouse_down:left"](mouse(180, 100, { click_count: 2 }), cx);
  assert.equal(v.input.value(), PATCH);
  const editor = byId(v.render(), "sketch-text-editor");
  assert.ok(editor.props.h >= 160, "the patch gets a multiline editor");
  const next = PATCH.replace("true;", "true; // 변경");
  v.input.set_value(next);
  editor.handlers["on_action:sketch-text-finish"]({}, cx);
  await cx.flush();
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].text, next);
  press(v, cx, "cmd-z");
  assert.equal(v.shapes[0].text, PATCH);
});

test("an attached arrow follows a diff card when moved", async () => {
  const { v, cx } = await mount([
    diff(),
    { id: "target", type: "rect", x: 700, y: 0, w: 100, h: 100 },
    { id: "arrow", type: "arrow", from: "change", to: "target" },
  ]);
  const arrow = v.shapes[2];
  const before = points(arrow, v.byId())[0];
  const canvas = byId(v.render(), "sketch-canvas");
  canvas.handlers["on_mouse_down:left"](mouse(180, 100), cx);
  canvas.handlers.on_mouse_move(mouse(180, 200), cx);
  canvas.handlers["on_mouse_up:left"](mouse(180, 200), cx);
  assert.equal(v.shapes[0].y, 100);
  assert.notDeepEqual(points(arrow, v.byId())[0], before);
});

test("a small diff card limits rendered rows and reports hidden lines without losing data", async () => {
  const content = "@@ -1,1000 +1,1000 @@\n" + Array.from({ length: 1000 }, (_, i) => ` line ${i}`).join("\n");
  const { v } = await mount([diff({ h: 120, text: content })]);
  const card = byId(v.render(), "diff-change");
  assert.ok(all(card, (e) => String(e.props.id ?? "").startsWith("diff-change-row-")).length < 10);
  assert.match(text(card), /more lines/);
  assert.equal(v.shapes[0].text, content);
});
