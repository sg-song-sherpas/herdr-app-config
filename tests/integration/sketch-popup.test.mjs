import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import Sketch from "../../mods/Sketch/main.js";
import { makeCx, mouse, key } from "../fakes/cx.mjs";
import { byId, text } from "../fakes/element.mjs";

const FILE = "/app/data/sketch/board.json";
const PATCH = "app.js\n@@ -10,3 +10,3 @@\n const count = 1;\n-const enabled = false;\n+const enabled = true;\n done();";
const diff = () => ({ id: "diff", type: "diff", x: 0, y: 0, w: 640, h: 280, text: PATCH });
beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount(shapes = [], scale = 1) {
  host.settings.zoom = scale;
  host.files.set(FILE, JSON.stringify({ version: 1, shapes }));
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx); await cx.settle(); await cx.flush();
  return { v, cx };
}
const press = (v, cx, k) => v.render().handlers.on_key_down(key(k), cx);
const canvas = (v) => byId(v.render(), "sketch-canvas");
const click = (v, cx, x, y) => {
  canvas(v).handlers["on_mouse_down:left"](mouse(x, y), cx);
  canvas(v).handlers["on_mouse_up:left"](mouse(x, y), cx);
};
const addPopup = (v, cx, scale = 1) => {
  byId(v.render(), "tool-popup").handlers.on_click({}, cx);
  click(v, cx, 220 * scale, 180 * scale);
};
const child = (v) => v.popupEntity;

for (const scale of [1, 1.1]) {
  test(`a popup pin opens an editable mini Sketch and preserves its content on reopen at scale ${scale}`, async () => {
    const { v, cx } = await mount([], scale);
    addPopup(v, cx, scale);
    assert.equal(v.shapes[0].type, "popup");
    const window = byId(v.render(), "sketch-popup-window");
    assert.ok(window, "a small sketch window opens");
    const mini = child(v);
    press(mini.view, mini.cx, "r");
    const c = canvas(mini.view);
    c.handlers["on_mouse_down:left"](mouse(80 * scale, 80 * scale), mini.cx);
    c.handlers.on_mouse_move(mouse(220 * scale, 150 * scale), mini.cx);
    c.handlers["on_mouse_up:left"](mouse(220 * scale, 150 * scale), mini.cx);
    byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
    await cx.flush();
    const stored = JSON.parse(host.files.get(FILE)).shapes[0];
    assert.equal(stored.popup.shapes.length, 1);
    assert.equal(stored.popup.shapes[0].type, "rect");
    assert.equal(mini.released, true, "closing releases the child view");
    click(v, cx, 220 * scale, 180 * scale);
    assert.equal(child(v).view.shapes.length, 1);
  });
}

test("the popup window can be resized and the custom dimensions survive reload", async () => {
  const { v, cx } = await mount();
  addPopup(v, cx);
  const size = { ...v.shapes[0].popup };
  byId(v.render(), "sketch-popup-resize").handlers["on_mouse_down:left"](mouse(500, 400), cx);
  canvas(v).handlers.on_mouse_move(mouse(600, 470), cx);
  canvas(v).handlers["on_mouse_up:left"](mouse(600, 470), cx);
  assert.equal(v.shapes[0].popup.width, size.width + 100);
  assert.equal(v.shapes[0].popup.height, size.height + 70);
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  await cx.flush();
  const next = await mount(JSON.parse(host.files.get(FILE)).shapes);
  click(next.v, next.cx, 220, 180);
  assert.equal(byId(next.v.render(), "sketch-popup-window").props.w, size.width + 100);
});

test("dragging a popup pin moves it without opening the window", async () => {
  const { v, cx } = await mount([{ id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44, popup: { width: 520, height: 380, shapes: [] } }]);
  const c = canvas(v);
  c.handlers["on_mouse_down:left"](mouse(162, 162), cx);
  c.handlers.on_mouse_move(mouse(242, 212), cx);
  c.handlers["on_mouse_up:left"](mouse(242, 212), cx);
  assert.equal(v.shapes[0].x, 180);
  assert.equal(byId(v.render(), "sketch-popup-window"), null);
});

test("selecting multiple diff rows creates a range comment with a text editor", async () => {
  const { v, cx } = await mount([diff()]);
  byId(v.render(), "diff-diff-select-1").handlers["on_mouse_down:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-3").handlers.on_mouse_move(mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-3").handlers["on_mouse_up:left"](mouse(0, 0), cx);
  const button = byId(v.render(), "diff-diff-add-comment");
  assert.match(button.props.tooltip, /10.*11/);
  button.handlers.on_click({}, cx);
  const comment = v.shapes[0].comments[0];
  assert.deepEqual([comment.startRow, comment.endRow], [1, 3]);
  assert.deepEqual(comment.quote, [" const count = 1;", "-const enabled = false;", "+const enabled = true;"]);
  const mini = child(v);
  assert.ok(byId(v.render(), "sketch-comment-editor"), "the text comment is ready to type");
  mini.view.input.type("재시도 처리를 추가해주세요.", mini.cx);
  // Closing without Enter must retain the draft text.
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  await cx.flush();
  const stored = JSON.parse(host.files.get(FILE)).shapes[0].comments[0];
  assert.equal(stored.popup.shapes[0].text, "재시도 처리를 추가해주세요.");
  byId(v.render(), `diff-diff-comment-${comment.id}`).handlers.on_click({}, cx);
  assert.equal(child(v).view.shapes[0].text, "재시도 처리를 추가해주세요.");
});

test("changing the diff keeps comments and exposes comments whose lines no longer match", async () => {
  const { v, cx } = await mount([{
    ...diff(),
    comments: [{ id: "c", startRow: 2, endRow: 3, quote: ["-old", "+new"], popup: { width: 500, height: 360, shapes: [{ id: "t", type: "text", x: 0, y: 0, text: "기존 댓글" }] } }],
  }]);
  const list = byId(v.render(), "diff-diff-comments");
  assert.match(text(list), /1/);
  list.handlers.on_click({}, cx);
  assert.match(text(byId(v.render(), "sketch-comment-list")), /변경된 줄/);
  byId(v.render(), "sketch-comment-c").handlers.on_click({}, cx);
  assert.equal(child(v).view.input.value(), "기존 댓글");
});

test("copying a pin preserves an independent copy of its popup content", async () => {
  const { v, cx } = await mount([{ id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44, popup: { width: 520, height: 380, shapes: [{ id: "t", type: "text", x: 0, y: 0, text: "원본" }] } }]);
  click(v, cx, 162, 162);
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  press(v, cx, "cmd-d");
  assert.equal(v.shapes.length, 2);
  v.shapes[1].popup.shapes[0].text = "복사본";
  assert.equal(v.shapes[0].popup.shapes[0].text, "원본");
});

test("a range comment can be deleted and restored with undo", async () => {
  const { v, cx } = await mount([diff()]);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_down:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_up:left"](mouse(0, 0), cx);
  byId(v.render(), "diff-diff-add-comment").handlers.on_click({}, cx);
  child(v).view.input.type("검토 의견", child(v).cx);
  byId(v.render(), "sketch-popup-delete-comment").handlers.on_click({}, cx);
  assert.equal(v.shapes[0].comments.length, 0);
  assert.equal(v.popupEntity, null);
  press(v, cx, "cmd-z");
  assert.equal(v.shapes[0].comments[0].popup.shapes[0].text, "검토 의견");
});

test("opening a popup adds no extra file watchers and nested text drafts survive immediate close", async () => {
  const { v, cx } = await mount();
  const watchers = host.watchers.length;
  addPopup(v, cx);
  assert.equal(host.watchers.length, watchers);
  const mini = child(v);
  press(mini.view, mini.cx, "t");
  click(mini.view, mini.cx, 100, 100);
  mini.view.input.type("팝업 안의 설명", mini.cx);
  byId(v.render(), "sketch-popup-close").handlers.on_click({}, cx);
  await cx.flush();
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].popup.shapes[0].text, "팝업 안의 설명");
});

test("closing the parent Sketch before its save timer fires preserves the popup draft", async () => {
  const { v, cx } = await mount();
  addPopup(v, cx);
  const mini = child(v);
  press(mini.view, mini.cx, "t");
  click(mini.view, mini.cx, 100, 100);
  mini.view.input.type("종료 전 마지막 입력", mini.cx);
  await v.close(cx);
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].popup.shapes[0].text, "종료 전 마지막 입력");
});

test("an external board edit closes the old popup and keeps the external content", async () => {
  const { v, cx } = await mount([{ id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44, popup: { width: 520, height: 380, shapes: [] } }]);
  click(v, cx, 162, 162);
  const external = [{ id: "other", type: "text", x: 0, y: 0, text: "외부에서 추가한 설명" }];
  host.files.set(FILE, JSON.stringify({ version: 1, shapes: external }));
  host.fireWatch();
  await cx.settle();
  assert.equal(v.popupEntity, null);
  assert.deepEqual(v.shapes, external);
});

test("editing a diff clears a previously selected comment range", async () => {
  const { v, cx } = await mount([diff()]);
  byId(v.render(), "diff-diff-select-2").handlers["on_mouse_down:left"](mouse(0, 0), cx);
  canvas(v).handlers["on_mouse_down:left"](mouse(180, 70, { click_count: 2 }), cx);
  assert.equal(v.diffSelection, null);
});
