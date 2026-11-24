import { View, div, svg } from 'gpui-kit';
import { h_flex, v_flex } from 'gpui-base';
import { exec, appHome, theme, props, shared, setShared, openOverlay, closeOverlay, spaces, agents, run, window, keys } from 'herdr';

const CACHE = 'codex-usage.snapshot';
const finite = v => typeof v === 'number' && Number.isFinite(v);
export function normalizeUsage(raw) {
  const limits = raw?.usage?.rate_limit ?? {};
  const windows = [limits.primary_window, limits.secondary_window].filter(w => w && finite(w.used_percent)).map(w => ({
    used: Math.max(0, Math.min(100, w.used_percent)), reset: w.reset_at,
    label: w.limit_window_seconds >= 604800 ? '주간' : w.limit_window_seconds === 18000 ? '5시간' : w.limit_window_seconds ? `${Math.round(w.limit_window_seconds / 3600)}시간` : '사용량',
  }));
  const credits = raw?.tickets?.credits;
  const count = finite(raw?.tickets?.available_count) ? raw.tickets.available_count : Array.isArray(credits) ? credits.filter(c => c.status === 'available').length : null;
  const available = (credits ?? []).filter(c => c.status === 'available');
  const expiries = available.map(c => c.expires_at || null).sort((a,b) => (new Date(a).getTime() || Infinity) - (new Date(b).getTime() || Infinity));
  const expiry = expiries.find(Boolean);
  return { windows, plan: raw?.usage?.plan_type, tickets: { count, expiry, expiries }, ticketError: raw?.ticketError };
}
export function remaining(seconds, now = Date.now()) {
  if (!finite(seconds)) return '시각 확인 불가';
  const mins = Math.ceil((seconds * 1000 - now) / 60000);
  if (mins <= 0) return '초기화 확인 중';
  const days = Math.floor(mins / 1440), hours = Math.floor(mins % 1440 / 60);
  return `${days ? `${days}일 ` : ''}${hours ? `${hours}시간 ` : ''}${!days ? `${mins % 60}분 ` : ''}후 초기화`;
}
function dateLabel(value) {
  if (!value) return '시각 확인 불가';
  const d = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(d.getTime())) return '시각 확인 불가';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function requestId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16); });
}
export default class CodexUsage extends View {
  init(_props, cx) {
    this.status = !!props()?.status;
    this.detail = !!props()?.detail || !!props()?.overlay;
    this.loading = false; this.busy = false; this.confirming = false; this.error = ''; this.resetError = ''; this.message = '';
    this.refresh(cx);
    if (!this.detail) cx.timer.every(60000, cx => this.refresh(cx));
  }
  bridge(action, key) {
    return exec('python3', [`${appHome()}/mods/codex-usage/fetch.py`, action, ...(key ? [key] : [])]);
  }
  refresh(cx) {
    if (this.loading || this.busy) return;
    this.loading = true; cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await this.bridge('read');
        const raw = JSON.parse(r.stdout);
        if (r.code !== 0 || raw.error) throw new Error(raw.error || '사용량 조회 실패');
        setShared(CACHE, { ...normalizeUsage(raw), at: Date.now() }); this.error = '';
      } catch (e) { this.error = e.message || '사용량 조회 실패'; }
      finally { this.loading = false; cx.notify(); }
    });
  }
  consume(cx) {
    if (this.busy || this.loading || !this.confirming || !(shared(CACHE)?.tickets.count > 0)) return;
    this.busy = true; this.confirming = false; this.error = ''; this.resetError = ''; this.message = ''; this.resetKey = shared('codex-usage.reset-request') || requestId(); setShared('codex-usage.reset-request', this.resetKey); cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await this.bridge('consume', this.resetKey), data = JSON.parse(r.stdout);
        if (r.code !== 0 || data.error) throw new Error(data.error || '초기화에 실패했습니다.');
        const messages = { reset: '사용량을 초기화했습니다.', nothing_to_reset: '초기화할 사용량이 없습니다.', no_credit: '사용 가능한 티켓이 없습니다.', already_redeemed: '이미 처리한 초기화 요청입니다.' };
        this.message = messages[data.outcome] || '처리 결과를 확인할 수 없습니다. 새로고침으로 확인해주세요.';
        this.resetKey = null; setShared('codex-usage.reset-request', null);
      } catch (e) { this.resetError = e.message || '초기화에 실패했습니다.'; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
  }
  button(id, label, action, primary = false) {
    const t = theme();
    return div().id(id).px(10).py(7).rounded(6).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).cursor_pointer().hover(s => s.bg(t.hover)).on_click(action).child(label);
  }
  paletteHint() {
    const mac = window()?.platform === 'macos';
    const names = { cmd: mac ? '⌘' : 'Ctrl+', ctrl: mac ? '⌃' : 'Ctrl+', shift: mac ? '⇧' : 'Shift+', alt: mac ? '⌥' : 'Alt+', option: mac ? '⌥' : 'Alt+' };
    const b = keys().find(k => k.section === 'global' && k.action === 'app.palette');
    const parts = b && b.keys.endsWith('--') ? [...b.keys.slice(0, -2).split('-'), '-'] : b?.keys.split('-');
    return parts ? `${parts.map(p => names[p.toLowerCase()] ?? p.toUpperCase()).join('')}  commands` : 'commands';
  }
  render() {
    const t = theme(), data = shared(CACHE), windows = data?.windows ?? [], worst = [...windows].sort((a,b) => b.used - a.used)[0];
    const color = w => w.used >= 90 ? t.blocked : w.used >= 70 ? t.working : t.accent;
    if (!this.detail) {
      const bar = h_flex().h_full().items_center().px(12).gap(8).bg(t.chrome).border_t(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(h_flex().id('usage-open').min_w(0).items_center().gap(7).cursor_pointer().on_click(() => {
          openOverlay({ mod: 'codex-usage', props: { detail: true }, kind: 'popup', width: 420, height: 630 });
        }).child(div().text_color(t.foreground).child('Codex'))
          .when(!!worst, el => el.child(div().w(34).h(4).rounded(2).bg(t.border).child(div().w(Math.round(34 * worst.used / 100)).h(4).rounded(2).bg(color(worst)))))
          .child(div().truncate().child(this.error ? '조회 실패 · 다시 시도' : worst ? `${Math.round(worst.used)}% · ${remaining(worst.reset)}` : this.loading ? '조회 중…' : '사용량 보기')))
        .child(div().id('usage-bar-refresh').cursor_pointer().on_click((_e,cx) => this.refresh(cx)).child('↻'));
      if (!this.status) return bar.w_full();
      const space = spaces().find(s => s.active), list = agents(), working = list.filter(a => a.status === 'working').length, needs = list.filter(a => a.status === 'blocked').length;
      const icon = (name, label) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${name}.svg`).size(13)).child(label);
      return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
        .child(icon(space?.machine ? 'server' : 'monitor', space?.machine ?? 'This computer'))
        .when(!!space?.branch, el => el.child(icon('branch', space.branch)))
        .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${working} / ${list.length} agents`)
          .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
        .child(bar.border_t(0))
        .child(div().flex_1())
        .child(div().id('palette').text_color(t.dim).cursor_pointer().on_click(() => run('app.palette')).child(this.paletteHint()));
    }
    const root = v_flex().size_full().p(18).gap(14).bg(t.popover).text_size(13).text_color(t.foreground).overflow_y_scrollbar();
    root.child(h_flex().items_center().justify_between().child(div().font_semibold().text_size(16).child('사용량'))
      .child(h_flex().gap(8).items_center().child(this.button('usage-refresh', this.loading ? '조회 중…' : '↻ 새로고침', (_e,cx) => this.refresh(cx)))
        .child(this.button('usage-close', '×', () => closeOverlay(props().overlay)))));
    root.child(h_flex().gap(8).child(div().font_semibold().child('Codex')).child(div().text_color(t.muted).child(data?.plan ? data.plan.toUpperCase() : 'ChatGPT 계정')));
    if (!windows.length) root.child(div().text_color(t.muted).child(this.loading ? '사용량을 조회하고 있습니다…' : '조회 가능한 사용량 구간이 없습니다.'));
    windows.forEach(w => root.child(v_flex().gap(6).p(12).rounded(8).bg(t.surface)
      .child(h_flex().justify_between().child(w.label).child(`${Math.round(w.used)}% 사용 · ${Math.round(100 - w.used)}% 남음`))
      .child(div().h(5).rounded(3).bg(t.border).child(div().w(`${w.used}%`).h(5).rounded(3).bg(color(w))))
      .child(div().text_color(t.muted).text_size(12).child(`${remaining(w.reset)} · ${dateLabel(w.reset)}`))));
    root.child(v_flex().gap(8).p(12).rounded(8).bg(t.surface)
      .child(h_flex().justify_between().child('초기화 티켓').child(data?.tickets.count == null ? '확인 불가' : `${data.tickets.count}개`))
      .children((data?.tickets.expiries ?? []).map((expiry, i) => v_flex().gap(3).text_size(12)
        .child(div().text_color(t.muted).child(`티켓 ${i + 1} · ${expiry ? dateLabel(expiry) + ' 만료' : '만료일 정보 없음'}`))
        .when(!!expiry, el => el.child(div().text_color(t.dim).child(remaining(new Date(expiry).getTime() / 1000).replace('후 초기화', '후 만료').replace('초기화 확인 중', '만료됨'))))))
      .when(!(data?.tickets.expiries?.length), el => el.child(div().text_size(12).text_color(t.muted).child(data?.tickets.count === 0 ? '사용 가능한 티켓이 없습니다.' : '유효기간을 확인할 수 없습니다. 새로고침해주세요.')))
      .when(!!data?.ticketError, el => el.child(div().text_size(12).text_color(t.muted).child(data.ticketError))));
    if (this.busy) root.child(div().child('초기화 처리 중…'));
    else if (this.confirming) {
      root.child(v_flex().id('usage-warning').gap(6).p(12).rounded(8).border(1).border_color(t.blocked)
        .child(div().font_semibold().text_color(t.blocked).child('주의 · 초기화 티켓을 사용합니다'))
        .child(div().child('사용량을 초기화하면 티켓 1개가 즉시 차감됩니다. 사용한 티켓은 되돌릴 수 없습니다.'))
        .child(div().text_color(t.muted).child('계속 진행할까요?')));
      root.child(h_flex().gap(8).child(this.button('usage-cancel', '취소', (_e,cx) => { this.confirming = false; cx.notify(); }))
        .child(this.button('usage-confirm', '티켓 1개 사용 · 초기화', (_e,cx) => this.consume(cx), true)));
    } else if (data?.tickets.count > 0 && !this.error && !this.loading) root.child(this.button('usage-reset', '티켓으로 사용량 초기화', (_e,cx) => { this.confirming = true; cx.notify(); }, true));
    if (this.message) root.child(div().text_color(t.accent).child(this.message));
    if (this.resetError) root.child(div().text_color(t.blocked).child(this.resetError));
    if (this.error) root.child(div().text_color(t.blocked).child(this.error));
    root.child(div().text_size(11).text_color(t.dim).child(data ? `마지막 조회 · ${dateLabel(data.at / 1000)}${this.error ? ' (이전 값)' : ''} · 시각은 현지 시간` : 'Codex CLI 로그인 계정 기준'));
    root.child(this.button('usage-account', '사용량 상세 및 기록 ↗', () => exec('open', ['https://chatgpt.com/codex/settings/usage'])));
    return root;
  }
}
