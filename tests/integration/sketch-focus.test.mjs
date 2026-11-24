import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import Sketch from "../../mods/Sketch/main.js";
import { makeCx, mouse } from "../fakes/cx.mjs";
import { byId } from "../fakes/element.mjs";

const FILE = "/app/data/sketch/board.json";
const board = (label) => JSON.stringify({ version: 1, shapes: [
  { id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44,
    popup: { width: 520, height: 380, shapes: [{ id: "text", type: "text", x: 0, y: 0, text: label }] } },
] });
beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount() {
  host.files.set(FILE, board("기존 스케치"));
  const cx = makeCx(), view = new Sketch();
  view.init({}, cx);
  await cx.settle();
  await cx.flush();
  return { view, cx };
}
function openPopup(view, cx) {
  const canvas = byId(view.render(), "sketch-canvas");
  canvas.handlers["on_mouse_down:left"](mouse(162, 162), cx);
  canvas.handlers["on_mouse_up:left"](mouse(162, 162), cx);
  assert.ok(byId(view.render(), "sketch-popup-window"));
}

test("loading a Sketch does not take keyboard focus from the current tab", async () => {
  const { view } = await mount();
  assert.equal(view.handle.is_focused(), false);
});

test("external board updates close a popup without taking focus from another tab", async () => {
  const { view, cx } = await mount();
  openPopup(view, cx);
  const popup = view.popupEntity;
  await popup.cx.flush();
  // The user has moved to a terminal in another tab before the agent writes.
  view.handle.focused = false;
  for (const label of ["첫 번째 갱신", "두 번째 갱신"]) {
    host.files.set(FILE, board(label));
    host.fireWatch([FILE]);
    await cx.settle();
    await cx.flush();
    assert.equal(view.handle.is_focused(), false);
    assert.equal(byId(view.render(), "sketch-popup-window"), null);
    assert.equal(view.shapes[0].popup.shapes[0].text, label);
    assert.deepEqual(JSON.parse(host.files.get(FILE)), JSON.parse(board(label)));
  }
  assert.equal(popup.released, true);
  assert.deepEqual(cx.errors, []);
});

test("clicking Sketch and explicitly closing a popup still focus the canvas", async () => {
  const { view, cx } = await mount();
  openPopup(view, cx);
  assert.equal(view.handle.is_focused(), true);
  view.handle.focused = false;
  byId(view.render(), "sketch-popup-close").handlers.on_click({}, cx);
  assert.equal(view.handle.is_focused(), true);
  assert.equal(byId(view.render(), "sketch-popup-window"), null);
});
