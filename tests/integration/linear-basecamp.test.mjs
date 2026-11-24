import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from 'herdr';
import { makeCx } from '../fakes/cx.mjs';
import { text } from '../fakes/element.mjs';
const { default: Worktree } = await import(new URL('../../mods/worktree-codex/main.js', import.meta.url));
const issue = {identifier: 'PRD-12345', title: '조회 오류', branchName: 'feature/prd-12345', description: null};
beforeEach(() => {
  host.reset(); localStorage.clear();
  host.spaces = [
    {id: 'base', name: 'Sherpas Basecamp', folder: '/repo/basecamp', machine: null},
    {id: 'remote', name: 'Remote', folder: '/remote/other', machine: 'signing-server', active: true},
    {id: 'other', name: 'Other', folder: '/repo/other', machine: null},
  ];
  host.props = {space: 'remote', action: 'new', issue, overlay: 'dialog'};
  host.exec = async (cmd, args, opts) => {
    if (cmd === 'sh') return {code: 0, stdout: args.includes('linear') ? JSON.stringify({data: {issue}}) : '/remote/home', stderr: ''};
    return {code: args.includes('show-ref') ? 1 : 0, stdout: args.includes('--git-common-dir') ? `${opts.cwd}/.git` : args.includes('--show-toplevel') ? opts.cwd : '', stderr: ''};
  };
});
async function submit() {
  const cx = makeCx(), view = new Worktree(); view.init({}, cx); await cx.settle();
  view.input.submit(cx); await cx.settle(); return {view, cx};
}
test('Linear creation uses local Basecamp even when a remote space is selected', async () => {
  await submit();
  const [launch] = host.ran('space.new'); assert.ok(launch);
  assert.equal(launch.machine, '');
  assert.equal(launch.folder, '/home/test/.herdr/worktrees/basecamp/feature-prd-12345');
  const add = host.execs.find(([, args]) => args.includes('add'));
  assert.equal(add[2].cwd, '/repo/basecamp'); assert.equal(add[2].on, '');
});
test('an issue typed from another local repository also uses Basecamp', async () => {
  host.props = {space: 'other', action: 'new', overlay: 'dialog'};
  const cx = makeCx(), view = new Worktree(); view.init({}, cx); await cx.settle();
  view.input.type('12345', cx); view.input.submit(cx); await cx.settle();
  assert.equal(host.ran('space.new')[0].folder, '/home/test/.herdr/worktrees/basecamp/feature-prd-12345');
  assert.equal(host.ran('space.new')[0].machine, '');
});
for (const duplicate of [false, true]) test(`Linear creation stops when local Basecamp is ${duplicate ? 'ambiguous' : 'missing'}`, async () => {
  if (duplicate) host.spaces.push({...host.spaces[0], id: 'duplicate'});
  else host.spaces = host.spaces.filter(s => s.id !== 'base');
  const {view, cx} = await submit();
  assert.equal(host.ran('space.new').length, 0);
  assert.equal(host.execs.filter(([, args]) => args.includes('add')).length, 0);
  assert.match(text(view.render(cx)), /Sherpas Basecamp/);
});
test('manual remote branches keep their requested repository and machine', async () => {
  host.props = {space: 'remote', action: 'new', branch: 'fix/manual'};
  const cx = makeCx(), view = new Worktree(); view.init({}, cx); await cx.settle();
  const [launch] = host.ran('space.new'); assert.ok(launch);
  assert.equal(launch.machine, 'signing-server');
  assert.equal(launch.folder, '/remote/home/.herdr/worktrees/other/fix-manual');
});
test('Sentry issues keep QA as sidebar parent while Git creation stays in Basecamp', async () => {
  host.spaces.push({id: 'qa', name: 'QA', folder: '/repo/qa', machine: null});
  host.props.issue = {...issue, description: 'Sentry 에러 자동 인입'};
  await submit();
  const [launch] = host.ran('space.new'); assert.equal(launch.machine, '');
  const parents = JSON.parse(host.files.get('/app/data/space-hierarchy/parents.json')).parents;
  assert.equal(parents[launch.folder], '/repo/qa');
  assert.equal(host.execs.find(([, args]) => args.includes('add'))[2].cwd, '/repo/basecamp');
});
test('a Basecamp space pointing to a linked checkout cannot create Linear worktrees', async () => {
  const original = host.exec;
  host.exec = async (cmd, args, opts) => args.includes('--git-common-dir')
    ? {code: 0, stdout: '/different/main/.git', stderr: ''} : original(cmd, args, opts);
  const {view, cx} = await submit();
  assert.equal(host.ran('space.new').length, 0);
  assert.equal(host.execs.filter(([, args]) => args.includes('add')).length, 0);
  assert.match(text(view.render(cx)), /기본 체크아웃/);
});
test('a selected Linear issue never contacts the active remote machine', async () => {
  await submit();
  assert.equal(host.ran('space.new').length, 1);
  assert.ok(host.execs.every(([, , opts]) => !opts?.on));
});
test('Linear detail uses the same restricted worktree dialog as list and search', async () => {
  const {Detail} = await import(new URL('../../mods/linear-issues/detail.js', import.meta.url));
  const {byId} = await import('../fakes/element.mjs');
  const cx = makeCx(), detail = new Detail(cx, () => {});
  detail.issue = {...issue, state: {name: 'Todo', type: 'unstarted'}, comments: {nodes: []}, children: {nodes: []}, attachments: {nodes: []}, labels: {nodes: []}};
  detail.id = issue.identifier; host.shared['linear.detail'] = issue.identifier;
  byId(detail.render(cx), 'ld-worktree').handlers.on_click({}, cx);
  assert.equal(host.overlays.at(-1).mod, 'worktree-codex');
});
