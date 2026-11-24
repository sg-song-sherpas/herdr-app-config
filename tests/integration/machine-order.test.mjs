import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx, mouse } from '../fakes/cx.mjs';
import { walk, byId } from '../fakes/element.mjs';
import Spaces from '../../mods/spaces-agents/main.js';
const order = v => [...walk(v.render())].map(e => e.props.id).filter(id => ['machine-local', 'machine-windows', 'machine-linux'].includes(id));
async function mount() { const cx = makeCx(), v = new Spaces(); v.init({}, cx); await cx.settle(); return { v, cx }; }
beforeEach(() => {
  host.reset(); localStorage.clear();
  host.hc = async () => ({ code: 0, stdout: JSON.stringify({ machines: [{ name: 'windows', state: 'connected' }, { name: 'linux', state: 'unreachable' }] }) });
});
for (const zoom of [1, 1.1]) test(`machine drag moves its group above local and persists at zoom ${zoom}`, async () => {
  host.settings.zoom = zoom;
  const { v, cx } = await mount();
  assert.deepEqual(order(v), ['machine-local', 'machine-linux', 'machine-windows']);
  byId(v.render(), 'machine-windows').handlers['on_mouse_down:left'](mouse(40, 180), cx);
  byId(v.render(), 'machine-local').handlers.on_mouse_move(mouse(40, 90), cx);
  byId(v.render(), 'machine-local').handlers['on_mouse_up:left'](mouse(40, 90), cx);
  assert.deepEqual(order(v), ['machine-windows', 'machine-local', 'machine-linux']);
  assert.deepEqual(order((await mount()).v), order(v));
  assert.deepEqual(host.ran('space.move'), []);
  assert.equal(localStorage.getItem('machines.folded'), null);
});
test('downward drag works and a normal click still folds the machine', async () => {
  const { v, cx } = await mount();
  byId(v.render(), 'machine-local').handlers['on_mouse_down:left'](mouse(40, 90), cx);
  byId(v.render(), 'machine-windows').handlers.on_mouse_move(mouse(40, 180), cx);
  byId(v.render(), 'machine-windows').handlers['on_mouse_up:left'](mouse(40, 180), cx);
  assert.deepEqual(order(v), ['machine-linux', 'machine-windows', 'machine-local']);
  const head = byId(v.render(), 'machine-local');
  head.handlers['on_mouse_down:left'](mouse(40, 180), cx);
  head.handlers['on_mouse_up:left'](mouse(40, 180), cx);
  head.handlers.on_click({}, cx);
  assert.deepEqual(JSON.parse(localStorage.getItem('machines.folded')), [null]);
});
test('obsolete and duplicate saved names are ignored; new machines remain visible', async () => {
  localStorage.setItem('machines.order', JSON.stringify(['windows', 'gone', 'windows', null]));
  const { v } = await mount();
  assert.deepEqual(order(v), ['machine-windows', 'machine-local', 'machine-linux']);
});
test('leaving the sidebar cancels a drag without changing the saved order', async () => {
  const { v, cx } = await mount();
  byId(v.render(), 'machine-windows').handlers['on_mouse_down:left'](mouse(40, 180), cx);
  v.render().handlers.on_hover(false, cx);
  byId(v.render(), 'machine-local').handlers.on_mouse_move(mouse(40, 90), cx);
  byId(v.render(), 'machine-local').handlers['on_mouse_up:left'](mouse(40, 90), cx);
  assert.deepEqual(order(v), ['machine-local', 'machine-linux', 'machine-windows']);
  assert.equal(localStorage.getItem('machines.order'), null);
});
