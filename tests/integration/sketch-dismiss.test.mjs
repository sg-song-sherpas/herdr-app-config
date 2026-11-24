import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import Sketch from "../../mods/Sketch/main.js";
import { makeCx, mouse } from "../fakes/cx.mjs";
import { byId } from "../fakes/element.mjs";

const FILE = "/app/data/sketch/board.json";
beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount() {
  host.files.set(FILE, JSON.stringify({ version: 1, shapes: [
    { id: "pin", type: "popup", x: 100, y: 100, w: 44, h: 44, popup: { width: 520, height: 380, shapes: [
      { id: "text", type: "text", x: 0, y: 0, text: "댓글" },
    ] } },
  ] }));
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx); await cx.settle(); await cx.flush();
  const c = byId(v.render(), "sketch-canvas");
  c.handlers["on_mouse_down:left"](mouse(162, 162), cx);
  c.handlers["on_mouse_up:left"](mouse(162, 162), cx);
  return { v, cx };
}

test("clicking elsewhere on the Sketch closes the popup and saves its current text draft", async () => {
  const { v, cx } = await mount();
  const mini = v.popupEntity;
  mini.view.startEdit(mini.view.shapes[0]);
  mini.view.input.type("닫기 전 마지막 댓글", mini.cx);
  const backdrop = byId(byId(v.render(), "sketch-canvas"), "sketch-popup-backdrop");
  assert.ok(backdrop, "dismissal is bounded to the Sketch canvas");
  backdrop.handlers["on_mouse_down:left"](mouse(800, 650), cx);
  await cx.flush();
  assert.equal(v.popupEntity, null);
  assert.equal(mini.released, true);
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].popup.shapes[0].text, "닫기 전 마지막 댓글");
});

test("an outside click only dismisses the popup rather than drawing a shape underneath it", async () => {
  const { v, cx } = await mount();
  v.tool = "rect";
  const c = byId(v.render(), "sketch-canvas");
  c.handlers["on_mouse_down:left"](mouse(800, 650), cx);
  c.handlers["on_mouse_up:left"](mouse(800, 650), cx);
  assert.equal(v.popupEntity, null);
  assert.equal(v.shapes.length, 1);
});

test("clicking inside the popup keeps it open", async () => {
  const { v, cx } = await mount();
  const popup = v.popupEntity;
  byId(v.render(), "sketch-popup-window").handlers["on_mouse_down:left"](mouse(300, 200), cx);
  assert.equal(v.popupEntity, popup);
  assert.equal(popup.released, false);
});

test("the parent toolbar also dismisses the popup before acting on controls outside it", async () => {
  const { v, cx } = await mount();
  const backdrop = byId(byId(v.render(), "sketch-toolbar"), "sketch-popup-toolbar-backdrop");
  assert.ok(backdrop);
  backdrop.handlers["on_mouse_down:left"](mouse(200, 20), cx);
  assert.equal(v.popupEntity, null);
  assert.equal(v.tool, "select");
});

test("the tool button outside a popup dismisses it before showing hidden parent tools", async () => {
  localStorage.setItem("bars", "hidden");
  const { v, cx } = await mount();
  byId(v.render(), "show-bars").handlers.on_click({}, cx);
  assert.equal(v.popupEntity, null);
  assert.equal(byId(v.render(), "sketch-toolbar"), null);
  byId(v.render(), "show-bars").handlers.on_click({}, cx);
  assert.ok(byId(v.render(), "sketch-toolbar"));
});
