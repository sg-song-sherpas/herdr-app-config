import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import Sketch from "../../mods/Sketch/main.js";
import { makeCx } from "../fakes/cx.mjs";
import { byId } from "../fakes/element.mjs";

beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount(scale = 1) {
  host.settings.zoom = scale;
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx);
  await cx.settle();
  await cx.flush();
  return { v, cx };
}
const canvas = (v) => byId(v.render(), "sketch-canvas");
const event = (delta, scale = 1, extra = {}) => ({
  delta, touch_phase: "moved", local_position: { x: 250 * scale, y: 180 * scale },
  position: { x: 300 * scale, y: 240 * scale }, modifiers: {}, ...extra,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

for (const scale of [1, 1.1]) {
  test(`pinching zooms in and out around the pointer at app scale ${scale}`, async () => {
    const { v, cx } = await mount(scale);
    const handler = canvas(v).handlers.on_pinch;
    assert.equal(typeof handler, "function", "the canvas handles native pinch events");
    const before = v.world({ x: 250, y: 180 });
    handler(event(0.2, scale), cx);
    near(v.zoom, 1.2);
    const after = v.world({ x: 250, y: 180 });
    near(after[0], before[0]); near(after[1], before[1]);
    handler(event(-0.25, scale), cx);
    near(v.zoom, 0.9);
    assert.ok(cx.stopped >= 2);
  });
}

test("pinch respects zoom limits without moving the anchored point", async () => {
  const { v, cx } = await mount();
  const handler = canvas(v).handlers.on_pinch;
  const before = v.world({ x: 250, y: 180 });
  handler(event(10), cx);
  assert.equal(v.zoom, 6);
  handler(event(-0.999), cx);
  assert.equal(v.zoom, 0.1);
  const after = v.world({ x: 250, y: 180 });
  near(after[0], before[0]); near(after[1], before[1]);
});

test("invalid or cancelled pinch events do not corrupt the viewport", async () => {
  const { v, cx } = await mount();
  const handler = canvas(v).handlers.on_pinch;
  const pan = { ...v.pan };
  for (const delta of [NaN, Infinity, -Infinity, -1, -2, 0]) handler(event(delta), cx);
  handler(event(0.5, 1, { touch_phase: "cancelled" }), cx);
  assert.equal(v.zoom, 1);
  assert.deepEqual(v.pan, pan);
});

test("pinch changes only the viewport and ordinary two-finger scrolling still pans", async () => {
  const { v, cx } = await mount();
  const before = [...v.undo];
  canvas(v).handlers.on_pinch(event(0.1), cx);
  const pan = { ...v.pan }, zoom = v.zoom;
  canvas(v).handlers.on_scroll_wheel({ ...event(0), delta: { x: 10, y: -20 } }, cx);
  near(v.pan.x, pan.x + 10); near(v.pan.y, pan.y - 20);
  assert.equal(v.zoom, zoom);
  assert.deepEqual(v.undo, before);
});
