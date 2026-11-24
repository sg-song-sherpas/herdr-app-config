import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { byId, text, walk } from '../fakes/element.mjs';
import Spaces from '../../mods/spaces-agents/main.js';
import Menu from '../../mods/menu-linear/main.js';
import Worktree from '../../mods/worktree/main.js';

beforeEach(() => {
  host.reset(); localStorage.clear();
  host.layout = { id: 'root', children: [{ id: 'sidebar', size: { px: 268 } }] };
  host.spaces = [{ id: 'active', name: 'active', active: true, folder: '/repo/active', tabs: [{ id: 't1' }] },
    { id: 'target', name: 'target', folder: '/repo/target', tabs: [{ id: 't2' }] }];
  host.panes = [{ pane: 'p1', tab: 't1', cwd: '/repo/active', focused: true }, { pane: 'p2', tab: 't2', cwd: '/repo/target' }];
  host.exec = async (cmd, args, opts) => {
    if (cmd === 'sh') return { code: 0, stdout: JSON.stringify({ data: { issue: { identifier: 'PRD-10355', title: '이슈 제목', branchName: 'song/prd-10355' } } }), stderr: '' };
    return { code: args.includes('show-ref') ? 1 : 0, stdout: args.includes('--git-common-dir') ? `${opts.cwd}/.git` : args.includes('--show-toplevel') ? opts.cwd : '', stderr: '' };
  };
});
async function mount(View) { const cx = makeCx(); const v = new View(); v.init({}, cx); await cx.settle(); return { v, cx }; }
async function createFromDialog(input, repo) {
  assert.equal(host.overlays.at(-1).mod, 'worktree');
  host.props = { ...host.overlays.at(-1).props, overlay: 'dialog' };
  const { v, cx } = await mount(Worktree);
  v.input.type(input, cx); v.input.submit(cx); await cx.settle();
  assert.deepEqual(cx.errors, []);
  assert.equal(host.ran('space.new').at(-1).name, '이슈 제목');
  assert.equal(host.ran('space.new').at(-1).folder, `/home/test/.herdr/worktrees/${repo}/song-prd-10355`);
}
test('sidebar + directly opens the dialog and creates a Linear issue worktree', async () => {
  const { v, cx } = await mount(Spaces);
  byId(v.render(), 'space-new').handlers.on_click({}, cx);
  assert.equal(host.ran('space.new').length, 0);
  assert.equal(host.overlays.length, 1);
  assert.equal(host.overlays.at(-1).mod, 'worktree');
  assert.equal(host.overlays.at(-1).props.space, 'active');
  await createFromDialog('PRD-10355', 'active');
});
test('sidebar right-click creates a Linear worktree in the clicked repository', async () => {
  const { v, cx } = await mount(Spaces);
  byId(v.render(), 'space-target').handlers['on_mouse_down:right']({}, cx);
  assert.equal(host.overlays.at(-1).mod, 'menu-linear');
  assert.equal(host.overlays.at(-1).props.target.id, 'target');
  host.props = { ...host.overlays.at(-1).props, overlay: 'context' };
  const menu = await mount(Menu);
  assert.match(text(byId(menu.v.render(menu.cx), 'mi-1')), /New worktree/);
  byId(menu.v.render(menu.cx), 'mi-1').handlers.on_click({}, menu.cx);
  await createFromDialog('https://linear.app/sherpas/issue/PRD-10355/title', 'target');
});
for (const [index, action] of [[2, 'open'], [3, 'remove']]) test(`context menu preserves ${action} worktree`, async () => {
  host.props = { tab: 'space', target: { id: 'target' }, overlay: 'context' };
  const original = host.exec;
  host.exec = (cmd, args, opts) => args.includes('--git-common-dir') ? { code: 0, stdout: '/repo/main/.git', stderr: '' } : original(cmd, args, opts);
  const { v, cx } = await mount(Menu);
  byId(v.render(cx), `mi-${index}`).handlers.on_click({}, cx);
  assert.equal(host.overlays.at(-1).mod, 'worktree');
  assert.deepEqual(host.overlays.at(-1).props, { space: 'target', action });
});

test('context Rename edits the clicked workspace inline, even when another workspace is active', async () => {
  const sidebar = await mount(Spaces);
  byId(sidebar.v.render(), 'space-target').handlers['on_mouse_down:right']({}, sidebar.cx);
  host.props = { ...host.overlays.at(-1).props, overlay: 'context' };
  const menu = await mount(Menu);
  byId(menu.v.render(menu.cx), 'mi-0').handlers.on_click({}, menu.cx);
  assert.ok(host.closedOverlays.includes('context'));
  assert.deepEqual(host.ran('space.rename'), []);
  const [command] = host.runs.at(-1);
  assert.equal(command, 'spaces-agents.rename:target');
  host.command(command.slice('spaces-agents.'.length));
  await sidebar.cx.settle();
  const editor = byId(sidebar.v.render(), 'rename-space-target');
  assert.ok(editor);
  const input = [...walk(editor)].find(e => e.kind === 'input');
  assert.equal(input.arg.value(), 'target');
  input.arg.type('바꾼 워크트리', sidebar.cx);
  input.arg.submit(sidebar.cx);
  assert.deepEqual(host.ran('space.rename'), [{ id: 'target', name: '바꾼 워크트리' }]);
});
