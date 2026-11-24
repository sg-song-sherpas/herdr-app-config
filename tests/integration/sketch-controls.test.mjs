import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import Sketch from "../../mods/Sketch/main.js";
import { makeCx, mouse, key } from "../fakes/cx.mjs";
import { byId, text } from "../fakes/element.mjs";

const FILE = "/app/data/sketch/board.json";
const pin = () => ({ id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44, popup: { width: 520, height: 380, shapes: [] } });
const diff = () => ({
  id: "diff", type: "diff", x: 0, y: 0, w: 640, h: 280, text: "app.js\n@@ -10 +10 @@\n-old\n+new",
  comments: [{ id: "review", startRow: 1, endRow: 2, quote: ["-old", "+new"], popup: { width: 520, height: 380, shapes: [] } }],
});
beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount(shapes) {
  host.files.set(FILE, JSON.stringify({ version: 1, shapes }));
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx); await cx.settle(); await cx.flush();
  return { v, cx };
}
function open(v, cx) {
  const canvas = byId(v.render(), "sketch-canvas");
  // No modifier is held.
  canvas.handlers["on_mouse_down:left"](mouse(162, 162), cx);
  canvas.handlers["on_mouse_up:left"](mouse(162, 162), cx);
}

test("ordinary clicking opens the popup and a header toggle hides its tools without hiding the parent tools", async () => {
  const { v, cx } = await mount([pin()]);
  open(v, cx);
  assert.ok(v.popupEntity);
  const mini = v.popupEntity;
  const button = byId(v.render(), "sketch-popup-tools");
  assert.match(text(button), /도구 숨기기/);
  button.handlers.on_click({}, cx);
  assert.equal(byId(mini.view.render(), "sketch-toolbar"), null);
  assert.ok(byId(v.render(), "sketch-toolbar"));
  assert.match(text(byId(v.render(), "sketch-popup-tools")), /도구 보기/);
  byId(v.render(), "sketch-popup-tools").handlers.on_click({}, cx);
  assert.ok(byId(mini.view.render(), "sketch-toolbar"));
});

test("the parent keyboard tool toggle also controls tools in the open popup", async () => {
  const { v, cx } = await mount([pin()]);
  open(v, cx);
  v.render().handlers.on_key_down(key("m"), cx);
  assert.equal(byId(v.render(), "sketch-toolbar"), null);
  assert.equal(byId(v.popupEntity.view.render(), "sketch-toolbar"), null);
  v.render().handlers.on_key_down(key("m"), cx);
  assert.ok(byId(v.render(), "sketch-toolbar"));
  assert.ok(byId(v.popupEntity.view.render(), "sketch-toolbar"));
});

test("popup tool visibility is saved and does not overwrite the main toolbar preference", async () => {
  const { v, cx } = await mount([pin()]);
  open(v, cx);
  const mini = v.popupEntity;
  mini.view.render().handlers.on_key_down(key("m"), mini.cx);
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  await cx.flush();
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].popup.toolsVisible, false);
  assert.notEqual(localStorage.getItem("bars"), "hidden");
  open(v, cx);
  assert.equal(byId(v.popupEntity.view.render(), "sketch-toolbar"), null);
});

test("existing and new diff comment popup buttons sit beside the line numbers", async () => {
  const { v, cx } = await mount([diff()]);
  const marker = byId(v.render(), "diff-diff-comment-review");
  assert.equal(marker.props.left, 0);
  assert.equal(marker.props.right, undefined);
  byId(v.render(), "diff-diff-select-1").handlers["on_mouse_down:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-2").handlers.on_mouse_move(mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_up:left"](mouse(0, 0), cx);
  const add = byId(v.render(), "diff-diff-add-comment");
  assert.ok(byId(byId(v.render(), "diff-diff-row-2"), "diff-diff-add-comment"));
  assert.match(add.props.tooltip, /줄 10/);
  add.handlers.on_click({}, cx);
  assert.ok(v.popupEntity);
});

test("text comments stay editable without sketch tools", async () => {
  const { v, cx } = await mount([diff()]);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_down:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_up:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-add-comment").handlers.on_click({}, cx);
  const mini = v.popupEntity;
  mini.view.input.type("작성 중인 댓글", mini.cx);
  assert.equal(byId(v.render(), "sketch-popup-tools"), null);
  assert.ok(byId(mini.view.render(), "sketch-comment-editor"));
  assert.equal(mini.view.input.value(), "작성 중인 댓글");
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  await cx.flush();
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].comments.at(-1).popup.shapes[0].text, "작성 중인 댓글");
});
