import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { walk, byId } from '../fakes/element.mjs';
import Spaces from '../../mods/spaces-agents/main.js';

beforeEach(() => { host.reset(); localStorage.clear(); });
async function mount(zoom = 1) {
  host.settings.zoom = zoom;
  host.layout = { children: [{ id: 'sidebar', size: { px: 268 } }] };
  host.spaces = ['source', 'parent', 'child', 'grandchild', 'next'].map(id => ({ id, name: id, folder: `/${id}`, tabs: [] }));
  host.agents = [{ address: 'a', space: 'child', tab: 't', pane: 'p', status: 'idle' }];
  host.files.set('/app/data/space-hierarchy/parents.json', JSON.stringify({ parents: { '/child': '/parent', '/grandchild': '/child' } }));
  host.exec = async () => ({ code: 128, stdout: '', stderr: '' });
  const cx = makeCx(), v = new Spaces(); v.init({}, cx); await cx.settle();
  return { v, cx };
}
const event = y => ({ position: { x: 100, y }, local_position: { x: 100, y }, bounds: { width: 260, height: 30 } });
function hover(v, cx, target, y) {
  byId(v.render(), 'space-source').handlers['on_mouse_down:left']({ click_count: 1 }, cx);
  byId(v.render(), `space-${target}`).handlers.on_mouse_move(event(y), cx);
  return v.render();
}

test('the scrolling list keeps one explicit identity as drag feedback changes', async () => {
  const { v, cx } = await mount();
  const scroller = root => [...walk(root)].find(e => e.calls.some(([name]) => name === 'overflow_y_scrollbar'));
  assert.equal(scroller(v.render()).props.id, 'spaces-agents-list');
  assert.equal(scroller(hover(v, cx, 'parent', 29)).props.id, 'spaces-agents-list');
  assert.equal(scroller(hover(v, cx, 'parent', 15)).props.id, 'spaces-agents-list');
});
for (const zoom of [1, 1.1]) {
  test(`after feedback follows the entire target subtree at zoom ${zoom}`, async () => {
    const { v, cx } = await mount(zoom);
    const root = hover(v, cx, 'parent', 29);
    const group = byId(root, 'worktree-group-parent');
    assert.ok(group, 'the target has a subtree container');
    for (const id of ['space-parent', 'space-child', 'space-grandchild', 'ag-a']) assert.ok(byId(group, id), id);
    assert.equal(byId(group, 'space-next'), null);
    const indicator = byId(group, 'worktree-drop-parent');
    assert.ok(indicator, 'the insertion line belongs to the full subtree');
    assert.equal(indicator.props.bottom, 0);
    assert.equal(byId(byId(root, 'space-parent'), 'worktree-drop-parent'), null);
    byId(root, 'space-parent').handlers['on_mouse_up:left'](event(29), cx); await cx.settle();
    assert.equal(JSON.parse(host.files.get('/app/data/space-hierarchy/parents.json')).parents['/source'], null);
  });
  test(`inside feedback encloses descendants and releasing nests the source at zoom ${zoom}`, async () => {
    const { v, cx } = await mount(zoom);
    const root = hover(v, cx, 'parent', 15);
    const indicator = byId(byId(root, 'worktree-group-parent'), 'worktree-drop-parent');
    assert.ok(indicator);
    assert.ok(indicator.calls.some(([name]) => name === 'inset_0'));
    assert.equal(indicator.props.border, 1);
    byId(root, 'space-parent').handlers['on_mouse_up:left'](event(15), cx); await cx.settle();
    assert.deepEqual(JSON.parse(host.files.get('/app/data/space-hierarchy/parents.json')).parents['/source'], { machine: null, path: '/parent' });
  });
}
