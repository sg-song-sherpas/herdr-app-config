import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { text, byId } from '../fakes/element.mjs';
import Worktree from '../../mods/worktree/main.js';
beforeEach(() => { host.reset(); localStorage.clear(); });
const issue = { identifier: 'PRD-10355', title: '로그인 오류 수정', branchName: 'song/prd-10355' };
const reply = value => ({ code: 0, stdout: JSON.stringify({ data: { issue: value } }), stderr: '' });
async function mount(lookup = async () => reply(issue)) {
  host.props = { folder: '/repo/basecamp', action: 'new', overlay: 'dialog' };
  host.exec = async (cmd, args) => cmd === 'sh' ? lookup(args) : { code: args.includes('show-ref') ? 1 : 0, stdout: args.includes('--git-common-dir') ? '/repo/basecamp/.git' : args.includes('--show-toplevel') ? '/repo/basecamp' : '', stderr: '' };
  const cx = makeCx(); const v = new Worktree(); v.init({}, cx); await cx.settle(); return { v, cx };
}
const requests = () => host.execs.filter(([cmd]) => cmd === 'sh');
for (const input of ['10355', ' 10355 ', 'prd-10355', 'https://linear.app/sherpas/issue/PRD-10355/title']) test(`typing ${input} previews the issue without Enter and reuses it on submit`, async () => {
  const { v, cx } = await mount(); v.input.type(input, cx);
  assert.equal(requests().length, 0); await cx.flush();
  assert.equal(JSON.parse(requests()[0][1].at(-1)).variables.id, 'PRD-10355');
  assert.match(text(byId(v.render(cx), 'linear-preview')), /PRD-10355.*로그인 오류 수정.*song\/prd-10355/);
  assert.equal(host.ran('space.new').length, 0);
  v.input.submit(cx); await cx.settle();
  assert.equal(requests().length, 1); assert.equal(host.ran('space.new')[0].name, issue.title);
});
test('rapid input changes debounce requests and clear the preview for plain branches', async () => {
  const { v, cx } = await mount(); v.input.type('PRD-10', cx); v.input.type('PRD-10355', cx); await cx.flush();
  assert.equal(requests().length, 1); assert.match(text(v.render(cx)), /로그인 오류 수정/);
  v.input.type('feature/plain', cx); assert.doesNotMatch(text(v.render(cx)), /로그인 오류 수정/); await cx.flush();
  assert.equal(requests().length, 1);
});
test('an old response cannot replace a newer issue preview', async () => {
  let first; const { v, cx } = await mount(args => JSON.parse(args.at(-1)).variables.id === 'PRD-1' ? new Promise(r => { first = r; }) : reply(issue));
  v.input.type('PRD-1', cx); await cx.flush(); assert.match(text(v.render(cx)), /Looking up/);
  v.input.type('PRD-10355', cx); await cx.flush(); first(reply({ ...issue, identifier: 'PRD-1', title: '이전 이슈' })); await cx.settle();
  assert.match(text(v.render(cx)), /로그인 오류 수정/); assert.doesNotMatch(text(v.render(cx)), /이전 이슈/);
});
test('Enter during lookup waits for that lookup and creates only after it succeeds', async () => {
  let finish; const { v, cx } = await mount(() => new Promise(r => { finish = r; }));
  v.input.type('PRD-10355', cx); await cx.flush(); v.input.submit(cx); await cx.settle();
  assert.equal(requests().length, 1); assert.equal(host.ran('space.new').length, 0);
  finish(reply(issue)); await cx.settle(); assert.equal(host.ran('space.new').length, 1);
});
test('lookup errors appear before Enter and a changed input clears them', async () => {
  const { v, cx } = await mount(async () => reply(null)); v.input.type('PRD-10355', cx); await cx.flush();
  assert.match(text(v.render(cx)), /not found/); assert.equal(host.ran('space.new').length, 0);
  v.input.type('', cx); assert.doesNotMatch(text(v.render(cx)), /not found/);
});
test('closing cancels a pending debounce without querying Linear', async () => {
  const { v, cx } = await mount(); v.input.type('PRD-10355', cx); v.close(); await cx.flush(); assert.equal(requests().length, 0);
});
