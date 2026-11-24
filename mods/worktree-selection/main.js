import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { props, spaces, panes, theme, run, closeOverlay, openOverlay } from 'herdr';

const command = (action, ids) => `spaces-agents.selection:${action}:${JSON.stringify(ids)}`;

export default class WorktreeSelection extends View {
  init(_props, cx) { this.at = 0; this.handle = cx.focus_handle(); this.handle.focus(); }
  targets() {
    const ids = new Set(props()?.ids ?? []);
    return spaces().filter(space => ids.has(space.id));
  }
  items() {
    return [['Backlog로 이동 (하위 포함)', 'archive'], ['작업 목록으로 복귀 (하위 포함)', 'restore'],
      ['선택한 워크트리 닫기…', 'close']];
  }
  choose(action) {
    const targets = this.targets(), ids = targets.map(space => space.id);
    if (!ids.length) return;
    closeOverlay(props()?.overlay);
    if (action === 'close') {
      const tabs = new Set(targets.flatMap(space => space.tabs.map(tab => tab.id)));
      const terminals = panes().filter(pane => tabs.has(pane.tab) && pane.terminal).length;
      openOverlay({ mod: 'confirm', kind: 'dialog', width: 460, height: 340, props: {
        title: `${ids.length}개 워크트리를 닫을까요?`,
        detail: `${targets.map(space => `• ${space.name}${space.machine ? ` · ${space.machine}` : ''}`).join('\n')}\n\n${tabs.size}개 탭과 ${terminals}개 터미널의 세션을 종료합니다. Git 워크트리 폴더는 유지합니다.`,
        command: { name: command('close', ids) },
      }});
    } else run(command(action, ids));
  }
  render(cx) {
    const t = theme(), targets = this.targets(), items = this.items();
    return v_flex().id('worktree-selection-menu').track_focus(this.handle).w_full().p(6).gap(3).bg(t.popover)
      .on_key_down((event, cx) => {
        if (event.key === 'escape') closeOverlay(props()?.overlay);
        else if (event.key === 'down' || event.key === 'up') {
          this.at = (this.at + (event.key === 'down' ? 1 : items.length - 1)) % items.length; cx.notify();
        } else if (event.key === 'enter') this.choose(items[this.at][1]);
        else return;
        cx.stop_propagation();
      })
      .child(div().px(8).py(6).text_size(12).text_color(t.muted).child(`${targets.length}개 워크트리 선택됨`))
      .children(items.map(([label, action], index) => h_flex().id(`selection-${action}`).h(30).px(8).items_center().rounded(5)
        .text_size(13).text_color(action === 'close' ? t.blocked : t.foreground)
        .when(index === this.at, el => el.bg(t.selected)).hover(el => el.bg(t.hover)).cursor_pointer()
        .on_click(() => this.choose(action)).child(label)))
      .child(h_flex().px(8).py(6).gap(7).items_center()
        .child(div().text_size(11).text_color(t.dim).child('색상'))
        .children(['ansi6', 'ansi3', 'ansi4', 'ansi5', 'ansi2', 'ansi1'].map(color => div().id(`selection-color-${color}`)
          .size(20).rounded(5).bg(t[color]).cursor_pointer().tooltip('선택한 워크트리 색상 변경')
          .hover(el => el.opacity(0.75)).on_click(() => this.choose(`color-${color}`)))));
  }
}
