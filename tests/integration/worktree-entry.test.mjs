import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { byId, text } from '../fakes/element.mjs';
import Worktree from '../../mods/worktree/main.js';
import Tabs from '../../mods/tabs-linear/main.js';

beforeEach(() => { host.reset(); localStorage.clear(); });
function setup(issue = { identifier: 'PRD-10355', title: '로그인 오류를 수정한다', branchName: 'song/prd-10355-login' }) {
  host.props = { folder: '/repo/basecamp', action: 'new', overlay: 'dialog' };
  host.exec = async (cmd, args) => {
    if (cmd === 'sh') return { code: 0, stdout: JSON.stringify({ data: { issue } }), stderr: '' };
    return { code: args.includes('show-ref') ? 1 : 0, stdout: args.includes('--git-common-dir') ? '/repo/basecamp/.git' : args.includes('--show-toplevel') ? '/repo/basecamp' : '', stderr: '' };
  };
}
for (const input of ['10355', 'prd-10355', 'https://linear.app/sherpas/issue/PRD-10355/login?x=1#description']) {
  test(`new worktree resolves ${input} to its Linear branch and title`, async () => {
    setup(); const cx = makeCx(); const v = new Worktree(); v.init({}, cx); await cx.settle();
    v.input.type(input, cx); v.input.submit(cx); v.input.submit(cx); await cx.settle();
    assert.equal(host.execs.filter(([cmd]) => cmd === 'sh').length, 1);
    const request = JSON.parse(host.execs.find(([cmd]) => cmd === 'sh')[1].at(-1));
    assert.deepEqual(request.variables, { id: 'PRD-10355' });
    assert.deepEqual(host.ran('space.new'), [{ name: '로그인 오류를 수정한다', folder: '/home/test/.herdr/worktrees/basecamp/song-prd-10355-login', machine: null, tab: undefined, argv: undefined }]);
    assert.equal(host.execs.filter(([cmd, args]) => cmd === 'git' && args.includes('add')).length, 1);
    assert.ok(host.execs.some(([cmd, args]) => cmd === 'git' && args.includes('song/prd-10355-login')));
  });
}
for (const [input, issue, error] of [
  ['PRD-10355', null, /not found/i],
  ['PRD-10355', { identifier: 'PRD-10355', title: '제목', branchName: '' }, /branch/i],
  ['https://linear.app/sherpas/project/test', null, /Linear issue/i],
  ['https://linear.app.evil.test/sherpas/issue/PRD-10355', null, /Linear issue/i],
]) test(`invalid or unavailable issue does not create a worktree: ${input} ${JSON.stringify(issue)}`, async () => {
  setup(issue); const cx = makeCx(); const v = new Worktree(); v.init({}, cx); await cx.settle();
  v.input.type(input, cx); v.input.submit(cx); await cx.settle();
  assert.match(text(v.render(cx)), error);
  assert.equal(host.ran('space.new').length, 0);
  assert.equal(host.execs.filter(([cmd, args]) => cmd === 'git' && args.includes('add')).length, 0);
});
test('ordinary branches still create worktrees without a Linear request', async () => {
  setup(); const cx = makeCx(); const v = new Worktree(); v.init({}, cx); await cx.settle();
  v.input.type('feature/login', cx); v.input.submit(cx); await cx.settle();
  assert.equal(host.execs.filter(([cmd]) => cmd === 'sh').length, 0);
  assert.equal(host.ran('space.new')[0].folder, '/home/test/.herdr/worktrees/basecamp/feature-login');
});
test('the plus menu uses the personal Linear-enabled menu', async () => {
  host.spaces = [{ id: 's1', active: true, tabs: [] }];
  const cx = makeCx(); const v = new Tabs(); v.init({}, cx); await cx.settle();
  byId(v.render(), 'tab-new').handlers.on_click({}, cx);
  assert.equal(host.overlays.at(-1).mod, 'new-menu-linear');
});

test('the personal menu opens the Linear-enabled dialog with the selected folder', async () => {
  const { default: Menu } = await import('../../mods/new-menu-linear/main.js');
  host.spaces = [{ id: 's1', active: true, tabs: [] }];
  host.panes = [{ focused: true, cwd: '/repo/selected' }];
  const cx = makeCx(); const v = new Menu(); v.init({}, cx); await cx.settle();
  byId(v.render(), 'worktree').handlers.on_click({}, cx);
  assert.equal(host.overlays.at(-1).mod, 'worktree');
  assert.deepEqual(host.overlays.at(-1).props, { space: 's1', folder: '/repo/selected', action: 'new' });
});
for (const reply of [{ code: 1, stdout: '', stderr: 'offline' }, { code: 0, stdout: '{"errors":[{"message":"Authentication required"}]}' }, { code: 0, stdout: 'Bad Gateway' }]) {
  test(`Linear errors preserve the dialog without creating a worktree: ${reply.stdout || reply.stderr}`, async () => {
    setup(); const normal = host.exec;
    host.exec = (cmd, args) => cmd === 'sh' ? reply : normal(cmd, args);
    const cx = makeCx(); const v = new Worktree(); v.init({}, cx); await cx.settle();
    v.input.type('PRD-10355', cx); v.input.submit(cx); await cx.settle();
    assert.equal(host.ran('space.new').length, 0);
    assert.equal(host.closedOverlays.length, 0);
    assert.match(text(v.render(cx)), /Linear|Authentication/);
  });
}
