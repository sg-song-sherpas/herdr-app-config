import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import Sketch from '../../mods/Sketch/main.js';
import { makeCx, mouse, key } from '../fakes/cx.mjs';
import { byId } from '../fakes/element.mjs';
const FILE = '/app/data/sketch/board.json';
const shapes = () => [{ id: 'diff', type: 'diff', x: 0, y: 0, w: 640, h: 280,
  text: 'app.js\n@@ -1 +1 @@\n-old\n+new', comments: [{ id: 'c', startRow: 2, endRow: 3,
  quote: ['-old', '+new'], popup: { width: 520, height: 380, shapes: [
    { id: 't', type: 'text', x: 0, y: 0, text: '기존 댓글' },
    { id: 'r', type: 'rect', x: 10, y: 30, w: 40, h: 20 },
  ] } }] }];
beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount(scale) {
  host.settings.zoom = scale;
  host.files.set(FILE, JSON.stringify({ version: 1, shapes: shapes() }));
  const cx = makeCx(), v = new Sketch();
  v.init({}, cx); await cx.settle(); await cx.flush();
  const list = byId(v.render(), 'diff-diff-comments');
  list.handlers.on_click({}, cx);
  byId(v.render(), 'sketch-comment-c').handlers.on_click({}, cx);
  return { v, cx };
}
for (const scale of [1, 1.1]) {
  test(`line comments use a compact text editor and outside clicks preserve the draft (${scale})`, async () => {
    const { v, cx } = await mount(scale);
    const popup = byId(v.render(), 'sketch-popup-window');
    assert.equal(popup.props.w, 320);
    assert.equal(popup.props.h, undefined, "height follows the textarea instead of a fixed box");
    assert.equal(byId(v.render(), 'sketch-popup-tools'), null);
    assert.equal(byId(v.render(), 'sketch-popup-resize'), null);
    assert.ok(byId(v.render(), 'sketch-comment-editor'));
    const child = v.popupEntity;
    assert.equal(child.view.input.value(), '기존 댓글');
    child.view.input.type('入力したコメント\n마지막 입력', child.cx);
    popup.handlers['on_mouse_down:left'](mouse(300 * scale, 200 * scale), cx);
    assert.equal(v.popupEntity, child, 'inside clicks keep it open');
    popup.handlers.on_mouse_down_out(mouse(1300 * scale, 500 * scale), cx);
    await cx.flush();
    assert.equal(v.popupEntity, null);
    const saved = JSON.parse(host.files.get(FILE)).shapes[0].comments[0];
    assert.equal(saved.popup.shapes[0].text, '入力したコメント\n마지막 입력');
    assert.equal(saved.popup.shapes[1].type, 'rect', 'legacy drawings are preserved');
  });
}
test('Escape closes the comment editor and preserves the text', async () => {
  const { v, cx } = await mount(1);
  v.popupEntity.view.input.type('닫기 전 입력', v.popupEntity.cx);
  byId(v.render(), 'sketch-popup-window').handlers.on_key_down(key('escape'), cx);
  await cx.flush();
  assert.equal(v.popupEntity, null);
  assert.equal(JSON.parse(host.files.get(FILE)).shapes[0].comments[0].popup.shapes[0].text, '닫기 전 입력');
});

for (const scale of [1, 1.1]) {
  test(`comment height follows wrapped text and stays above its diff range (${scale})`, async () => {
    const { v, cx } = await mount(scale);
    v.shapes[0].y = 260;
    v.zoom = 1.3;
    let popup = byId(v.render(), 'sketch-popup-window');
    const row = byId(v.render(), 'diff-diff-row-2');
    const rowTop = v.pan.y + v.shapes[0].y * v.zoom + row.props.top;
    popup.handlers.on_size_change({ width: 320 * scale, height: 90 * scale }, cx);
    popup = byId(v.render(), 'sketch-popup-window');
    assert.ok(byId(v.render(), 'sketch-comment-anchor').props.top <= rowTop - 8, 'the selected row remains visible');
    const anchor = byId(v.render(), 'sketch-comment-anchor').props.top;
    v.popupEntity.view.input.type('첫 줄\n둘째 줄\n셋째 줄', v.popupEntity.cx);
    popup.handlers.on_size_change({ width: 320 * scale, height: 134 * scale }, cx);
    popup = byId(v.render(), 'sketch-popup-window');
    assert.equal(byId(v.render(), 'sketch-comment-anchor').props.top, anchor, 'growing text keeps the bottom anchored above the row');
    assert.ok(byId(v.render(), 'sketch-comment-anchor').props.top <= rowTop - 8);
    popup.handlers.on_size_change({ width: 320 * scale, height: 68 * scale }, cx);
    popup = byId(v.render(), 'sketch-popup-window');
    assert.equal(byId(v.render(), 'sketch-comment-anchor').props.top, anchor);
    assert.ok(byId(v.render(), 'sketch-comment-anchor').props.top <= rowTop - 8);
    assert.deepEqual(v.popupEntity.view.input.autoGrow, [1, 12]);
  });
}

for (const scale of [1, 1.1]) {
  test(`the first frame anchors above the row before text height is measured (${scale})`, async () => {
    const { v, cx } = await mount(scale);
    v.pan.y = 27;
    const initial = byId(v.render(), 'sketch-popup-window');
    assert.equal(initial.props.top, undefined, 'native bottom anchoring needs no estimated top');
    assert.ok(Number.isFinite(initial.props.bottom), 'the first frame already has an above-row anchor');
    const bottom = byId(v.render(), 'sketch-comment-anchor').props.top;
    for (const height of [68, 124, 78]) {
      initial.handlers.on_size_change({width:320*scale, height:height*scale},cx);
      const next = byId(v.render(), 'sketch-popup-window');
      assert.equal(next.props.top, undefined);
      assert.equal(byId(v.render(), 'sketch-comment-anchor').props.top, bottom, 'measuring or wrapping text never switches sides');
      assert.equal(next.props.bottom, 0);
    }
  });
}

for (const scale of [1, 1.1]) {
  test(`a comment stays hidden until layout measurements settle (${scale})`, async () => {
    const { v, cx } = await mount(scale);
    let popup = byId(v.render(), 'sketch-popup-window');
    assert.equal(popup.props.opacity, 0, 'do not paint the initial layout');
    popup.handlers.on_size_change({width:320*scale, height:78*scale},cx);
    const firstReveal = cx.timers.at(-1);
    assert.equal(byId(v.render(), 'sketch-popup-window').props.opacity, 0);
    popup.handlers.on_size_change({width:320*scale, height:120*scale},cx);
    assert.equal(firstReveal.cancelled, true, 'a later wrapped height cancels the earlier reveal');
    firstReveal.fn(cx);
    assert.equal(byId(v.render(), 'sketch-popup-window').props.opacity, 0, 'a stale callback cannot flash the popup');
    await cx.flush();
    popup = byId(v.render(), 'sketch-popup-window');
    assert.equal(popup.props.opacity, 1, 'show only the settled layout');
    popup.handlers.on_size_change({width:320*scale, height:145*scale},cx);
    assert.equal(byId(v.render(), 'sketch-popup-window').props.opacity, 1, 'subsequent edits do not hide the editor');
  });
}
test('closing a hidden comment cancels its pending reveal', async () => {
  const {v,cx} = await mount(1);
  byId(v.render(), 'sketch-popup-window').handlers.on_size_change({width:320,height:78},cx);
  const pending = cx.timers.at(-1);
  byId(v.render(), 'sketch-popup-window').handlers.on_mouse_down_out(mouse(1200,500),cx);
  assert.equal(pending.cancelled, true);
  pending.fn(cx);
  await cx.flush();
  assert.equal(byId(v.render(), 'sketch-popup-window'), null);
});
