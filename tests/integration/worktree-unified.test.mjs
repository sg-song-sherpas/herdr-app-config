import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { byId, text } from '../fakes/element.mjs';
import Worktree from '../../mods/worktree/main.js';
import { Detail } from '../../mods/linear-issues/detail.js';
const issue = { identifier: 'PRD-10355', title: '로그인 오류 수정', branchName: 'song/prd-10355' };
beforeEach(() => {
  host.reset(); localStorage.clear();
  host.props = { folder: '/repo/basecamp', action: 'new', issue, overlay: 'dialog' };
  host.exec = async (cmd, args) => cmd === 'sh'
    ? { code: 0, stdout: JSON.stringify({ data: { issue } }), stderr: '' }
    : { code: args.includes('show-ref') ? 1 : 0, stdout: args.includes('--git-common-dir') ? '/repo/basecamp/.git' : args.includes('--show-toplevel') ? '/repo/basecamp' : '', stderr: '' };
});
async function mount() { const cx = makeCx(), v = new Worktree(); v.init({}, cx); await cx.settle(); return { v, cx }; }
test('a selected issue is previewed and creates nothing until Enter', async () => {
  const { v, cx } = await mount();
  assert.match(text(byId(v.render(cx), 'linear-preview')), /PRD-10355.*로그인 오류 수정.*song\/prd-10355/);
  assert.equal(host.execs.filter(([cmd]) => cmd === 'sh').length, 0);
  assert.equal(host.ran('space.new').length, 0);
  v.input.submit(cx); await cx.settle();
  assert.equal(host.ran('space.new')[0].name, `${issue.identifier} ${issue.title}`);
  assert.equal(host.ran('space.new')[0].folder, '/home/test/.herdr/worktrees/basecamp/song-prd-10355');
  assert.equal(host.execs.filter(([cmd]) => cmd === 'sh').length, 0);
});
test('editing a selected issue replaces its preview and creates the newly selected branch', async () => {
  const { v, cx } = await mount(); v.input.type('feature/plain', cx);
  assert.doesNotMatch(text(v.render(cx)), /로그인 오류 수정/);
  v.input.submit(cx); await cx.settle();
  assert.equal(host.ran('space.new')[0].name, undefined);
  assert.match(host.ran('space.new')[0].folder, /feature-plain$/);
});
test('the detail button passes its issue to the restricted confirmation dialog', () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  detail.issue = { ...issue, state: { name: 'Todo', type: 'unstarted' }, comments: { nodes: [] }, children: { nodes: [] }, attachments: { nodes: [] }, labels: { nodes: [] } };
  detail.id = issue.identifier;
  host.shared['linear.detail'] = issue.identifier;
  byId(detail.render(cx), 'ld-worktree').handlers.on_click({}, cx);
  const overlay = host.overlays.at(-1);
  assert.equal(overlay.mod, 'worktree-codex');
  assert.deepEqual(overlay.props.issue, issue);
  assert.equal(overlay.props.branch, undefined);
  assert.ok(overlay.height >= 360);
});
