import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Usage, { normalizeUsage, remaining } from '../../mods/codex-usage/main.js';
import { host } from '../fakes/herdr.mjs';
import { makeCx, mouse } from '../fakes/cx.mjs';
import { byId, text } from '../fakes/element.mjs';
const payload = { usage: { plan_type: 'pro', rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1900000000 } } }, tickets: { available_count: 2, credits: [{ status: 'available', expires_at: '2030-05-01T00:00:00Z' }] } };
beforeEach(() => { host.reset(); localStorage.clear(); host.exec = async () => ({ code: 0, stdout: JSON.stringify(payload) }); });
test('weekly-only accounts keep the weekly label and missing windows unknown', () => {
 const d = normalizeUsage(payload); assert.equal(d.windows[0].label, '주간'); assert.equal(d.windows[0].used, 12); assert.equal(d.tickets.count, 2);
 assert.equal(normalizeUsage({ usage: {} }).windows.length, 0); assert.equal(normalizeUsage({ usage: {} }).tickets.count, null);
 assert.equal(remaining(1900000000, 1900000000001), '초기화 확인 중');
});
test('footer shows actual usage and opens a detail popup without consuming a ticket', async () => {
 const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 assert.match(text(v.render()), /12%/); byId(v.render(), 'usage-open').handlers.on_click({ click_count: 1, modifiers: {} }, cx);
 assert.equal(host.overlays[0].props.detail, true); assert.ok(host.execs.every(([, a]) => !a.includes('consume')));
});
test('reset requires explicit confirmation, runs once, and refreshes afterwards', async () => {
 host.props = { detail: true }; const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 assert.match(text(v.render()), /2개/);
 byId(v.render(), 'usage-reset').handlers.on_click({}, cx); assert.match(text(v.render()), /티켓 1개/);
 assert.ok(host.execs.every(([, a]) => !a.includes('consume')));
 const confirm = byId(v.render(), 'usage-confirm'); confirm.handlers.on_click({}, cx); confirm.handlers.on_click({}, cx); await cx.settle();
 assert.equal(host.execs.filter(([, a]) => a.includes('consume')).length, 1);
});
test('refresh failure retains the last values and marks them stale', async () => {
 host.props = { detail: true }; const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 host.exec = async () => ({ code: 1, stdout: JSON.stringify({ error: '네트워크 연결을 확인해주세요.' }) });
 byId(v.render(), 'usage-refresh').handlers.on_click({}, cx); await cx.settle();
 assert.match(text(v.render()), /12%/); assert.match(text(v.render()), /마지막 조회/); assert.match(text(v.render()), /네트워크/);
});
test('unknown tickets cannot consume', async () => {
 host.props = { detail: true }; host.exec = async () => ({ code: 0, stdout: JSON.stringify({ usage: payload.usage }) });
 const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 assert.equal(byId(v.render(), 'usage-reset'), null); assert.match(text(v.render()), /확인 불가/);
});
test('a failed reset remains visible after a successful usage refresh', async () => {
 host.props = { detail: true }; const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 host.exec = async (_cmd, args) => args.includes('consume') ? { code: 1, stdout: JSON.stringify({ error: '초기화 요청 실패' }) } : { code: 0, stdout: JSON.stringify(payload) };
 byId(v.render(), 'usage-reset').handlers.on_click({}, cx);
 byId(v.render(), 'usage-confirm').handlers.on_click({}, cx); await cx.settle();
 assert.match(text(v.render()), /초기화 요청 실패/);
});
test('each available ticket shows its own expiry and the confirmation warns about consumption', async () => {
 host.props = { detail: true };
 host.exec = async () => ({ code: 0, stdout: JSON.stringify({ ...payload, tickets: { available_count: 2, credits: [
 { status: 'available', expires_at: '2030-05-01T00:00:00Z' },
 { status: 'available', expires_at: '2030-06-01T00:00:00Z' },
 { status: 'redeemed', expires_at: '2030-04-01T00:00:00Z' } ] } }) });
 const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 assert.match(text(v.render()), /2030.05.01/); assert.match(text(v.render()), /2030.06.01/);
 assert.doesNotMatch(text(v.render()), /2030.04.01/);
 byId(v.render(), 'usage-reset').handlers.on_click({}, cx);
 assert.match(text(v.render()), /차감/); assert.match(text(v.render()), /되돌릴 수 없습니다/);
 byId(v.render(), 'usage-cancel').handlers.on_click({}, cx);
 assert.ok(host.execs.every(([,a]) => !a.includes('consume')));
});
test('the bottom status bar keeps computer and agent context next to usage', async () => {
 host.props = { status: true }; host.agents = [{ status: 'idle' }, { status: 'blocked' }];
 const v = new Usage(), cx = makeCx(); v.init({}, cx); await cx.settle();
 assert.match(text(v.render()), /This computer/); assert.match(text(v.render()), /2 agents/); assert.match(text(v.render()), /12%/);
});
test('count-only usage still fetches ticket details, without reading real credentials', async () => {
 const { execFileSync } = await import('node:child_process');
 const source = `
import importlib.util,json,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('bridge','mods/codex-usage/fetch.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with patch.object(m.Path,'read_text',return_value=json.dumps({'tokens':{'access_token':'fake'}})), patch.object(m.sys,'argv',['fetch.py','read']), patch.object(m,'request',side_effect=[{'rate_limit_reset_credits':{'available_count':3}}, {'available_count':3,'credits':[{'status':'available','expires_at':'2030-01-01T00:00:00Z'}]}]) as request:
 result=m.main()
 assert [c.args[0] for c in request.call_args_list] == ['usage','rate-limit-reset-credits']
 assert result['tickets']['credits'][0]['expires_at']=='2030-01-01T00:00:00Z'
`;
 execFileSync('python3', ['-c', source], { cwd: new URL('../../', import.meta.url) });
});
test('usage belongs to the bottom status block and is absent from the sidebar', async () => {
 const { readFileSync } = await import('node:fs');
 const layout = JSON.parse(readFileSync(new URL('../../layouts/main-linear.json', import.meta.url)));
 const sidebar = layout.children.find(n => n.id === 'sidebar');
 assert.ok(!JSON.stringify(sidebar).includes('codex-usage'));
 const work = layout.children.find(n => n.id === 'work');
 assert.equal(work.children.at(-1).id, 'status');
 assert.equal(work.children.at(-1).content.mod, 'codex-usage');
 assert.equal(work.children.at(-1).content.props.status, true);
});
