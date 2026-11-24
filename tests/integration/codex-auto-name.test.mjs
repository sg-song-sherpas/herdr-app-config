import { test } from 'node:test';
import assert from 'node:assert/strict';
import { host } from '../fakes/herdr.mjs';
import { makeCx } from '../fakes/cx.mjs';
import Tabs from '../../mods/tabs-linear/main.js';

test('the live tab bar saves the Codex title after its first response finishes', async () => {
  host.reset(); localStorage.clear();
  host.spaces = [{ id: 's1', active: true, tabs: [{ id: 'tb1', name: 'Codex', named: true, active: true }] }];
  host.panes = [{ tab: 'tb1', terminal: 't1', program: { key: 'codex', name: 'Codex', agent: true } }];
  const term = { address: 't1', report: { app: 'codex' }, state: 'live', status: 'working', turn: 1, title: '로그인 오류 수정 | basecamp' };
  host.terminals = [term];
  const cx = makeCx(), view = new Tabs(); view.init({}, cx);
  view.render(cx); await cx.flush(); assert.deepEqual(host.ran('tab.rename'), []);
  term.status = 'idle'; view.render(cx); await cx.flush();
  assert.deepEqual(host.ran('tab.rename'), [{ id: 'tb1', name: '로그인 오류 수정' }]);
  term.turn = 2; term.title = '후속 질문 | basecamp'; view.render(cx); await cx.flush();
  assert.equal(host.ran('tab.rename').length, 1);
});
