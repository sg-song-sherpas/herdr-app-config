import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { host } from '../fakes/herdr.mjs';
import { makeCx } from '../fakes/cx.mjs';
import { CodexAutoName } from '../../mods/tabs-linear/codex-auto-name.js';

let cx, auto, tab, term;
beforeEach(() => {
  host.reset(); localStorage.clear(); cx = makeCx(); auto = new CodexAutoName();
  tab = { id: 'tb1', name: 'Codex', named: true };
  term = { address: 't1', state: 'live', status: 'working', turn: 1, title: '⠹ 로그인 오류 수정 | basecamp', report: { app: 'codex' } };
  host.spaces = [{ tabs: [tab] }]; host.terminals = [term];
  host.panes = [{ tab: tab.id, terminal: term.address, program: { key: 'codex', agent: true } }];
});
test('waits for the first response, excluding blocked and empty sessions', async () => {
  for (const status of ['working', 'blocked']) { term.status = status; auto.sync(cx); await cx.flush(); }
  term.status = 'idle'; term.turn = 0; auto.sync(cx); await cx.flush();
  assert.deepEqual(host.runs, []);
});
test('saves the conversation title once after completion, without the folder suffix', async () => {
  term.status = 'idle'; auto.sync(cx); await cx.flush();
  assert.deepEqual(host.runs, [['tab.rename', { id: 'tb1', name: '로그인 오류 수정' }]]);
  term.title = '다음 작업 | basecamp'; auto.sync(cx); await cx.flush();
  new CodexAutoName().sync(cx); await cx.flush();
  assert.equal(host.runs.length, 1);
});
test('also names a numbered tab completed while away', async () => {
  tab.name = '2'; tab.named = false; term.status = 'done'; auto.sync(cx); await cx.flush();
  assert.equal(host.runs[0][1].name, '로그인 오류 수정');
});
test('preserves a manually named tab, including edits made while the rename is queued', async () => {
  term.status = 'done'; auto.sync(cx); tab.name = '직접 정한 작업'; await cx.flush();
  assert.deepEqual(host.runs, []);
  auto.sync(cx); await cx.flush(); assert.deepEqual(host.runs, []);
});
test('does not name from generic titles or another agent and retries when the real title arrives', async () => {
  term.status = 'idle'; term.title = 'Codex | basecamp'; auto.sync(cx); await cx.flush();
  term.report.app = 'claude-code'; term.title = '작업 완료'; auto.sync(cx); await cx.flush();
  assert.deepEqual(host.runs, []);
  term.report.app = 'codex'; auto.sync(cx); await cx.flush(); assert.equal(host.runs.length, 1);
});
test('cancels a queued rename if the terminal switches or a new turn starts', async () => {
  term.status = 'idle'; auto.sync(cx); term.status = 'working'; await cx.flush();
  assert.deepEqual(host.runs, []);
  term.status = 'idle'; auto.sync(cx); host.panes[0].terminal = 't2'; await cx.flush();
  assert.deepEqual(host.runs, []);
});

test('waits when completion arrives before Codex replaces the home folder title', async () => {
  term.status = 'done'; term.cwd = '/Users/songseongwon'; term.title = 'songseongwon';
  auto.sync(cx); await cx.flush();
  assert.deepEqual(host.runs, []);
  term.title = 'Say hello | songseongwon'; auto.sync(cx); await cx.flush();
  assert.deepEqual(host.runs, [['tab.rename', { id: 'tb1', name: 'Say hello' }]]);
});

test('also rejects a foreground working directory title', async () => {
  term.status = 'idle'; term.cwd = '/Users/songseongwon';
  term.foreground = { cwd: '/Users/songseongwon/project' }; term.title = 'project';
  auto.sync(cx); await cx.flush(); assert.deepEqual(host.runs, []);
});
