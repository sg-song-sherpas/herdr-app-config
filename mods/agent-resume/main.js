import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, spaces, props, closeOverlay, exec, appHome } from "herdr";
import { rowKey, canSelect, selectedTargets, rowLabel, tabNames } from "./resume-ui-data.js";

export default class InterruptedWork extends View {
  init(_props, cx) {
    this.rows = [];
    this.selected = new Set();
    this.refreshing = false;
    this.sending = false;
    this.message = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.refresh(cx);
    cx.timer.every(2000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.refreshing || this.sending) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [`${appHome()}/hooks/auto-resume.py`, "candidates"], {timeout: 12000});
        if (result.code !== 0) throw new Error("read failed");
        const data = JSON.parse(result.stdout);
        this.rows = data.candidates ?? [];
        const selectable = new Set(this.rows.filter(canSelect).map(rowKey));
        this.selected = new Set([...this.selected].filter(key => selectable.has(key)));
      } catch {
        this.message = "중단 후보를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.";
      } finally {
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  toggle(row, cx) {
    if (!canSelect(row) || this.sending) return;
    const key = rowKey(row);
    this.selected.has(key) ? this.selected.delete(key) : this.selected.add(key);
    cx.notify();
  }

  chooseAll(cx) {
    if (this.sending) return;
    const all = this.rows.filter(canSelect).map(rowKey);
    this.selected = all.length && all.every(key => this.selected.has(key)) ? new Set() : new Set(all);
    cx.notify();
  }

  submit(cx) {
    const targets = selectedTargets(this.rows, this.selected);
    if (!targets.length || this.sending) return;
    this.sending = true;
    this.message = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [
          `${appHome()}/hooks/auto-resume.py`, "continue", "--targets", JSON.stringify(targets),
        ], {timeout: 20000});
        if (result.code !== 0) throw new Error("delivery failed");
        const data = JSON.parse(result.stdout);
        const count = (data.requests ?? []).filter(item => item.queued).length;
        const ignored = targets.length - count;
        this.message = `${count}개 작업을 재개 대기 목록에 넣었습니다.${ignored ? ` 상태가 바뀐 ${ignored}개는 제외했습니다.` : ""}`;
      } catch {
        this.message = "전송 결과를 확인하지 못했습니다. 중복 전송을 막기 위해 자동으로 다시 보내지 않습니다.";
      } finally {
        this.selected.clear();
        this.sending = false;
        cx.notify();
        this.refresh(cx);
      }
    });
  }

  render(cx) {
    const t = theme(), names = tabNames(spaces());
    const targets = selectedTargets(this.rows, this.selected);
    const canSubmit = targets.length > 0 && !this.sending;
    return v_flex().id("interrupted-work-dialog").track_focus(this.handle).size_full()
      .p(18).gap(12).bg(t.popover).text_color(t.foreground)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { closeOverlay(props()?.overlay); cx.stop_propagation(); }
      })
      .child(div().text_size(16).font_weight(600).child("중단된 작업 재개"))
      .child(div().text_size(12).text_color(t.muted)
        .child("마지막으로 작업 중이라고 관측한 대화입니다. 선택한 작업만 기존 승인 범위에서 이어갑니다."))
      .child(h_flex().items_center().justify_between().text_size(12)
        .child(div().text_color(t.dim).child(`${this.rows.length}개 중단 후보`))
        .child(div().id("interrupted-select-all").px(8).py(4).rounded(5).cursor_pointer().text_color(t.accent)
          .hover(el => el.bg(t.hover)).on_click((_e, cx) => this.chooseAll(cx)).child("재개 가능한 작업 전체 선택")))
      .child(v_flex().id("interrupted-work-list").flex_1().min_h(0).gap(6).overflow_y_scrollbar()
        .when(this.rows.length === 0, el => el.child(div().p(16).text_size(13).text_color(t.muted)
          .child(this.refreshing ? "중단 후보를 확인하고 있습니다." : "재개할 중단 후보가 없습니다.")))
        .children(this.rows.map(row => {
          const title = names.get(row.tab);
          const selected = this.selected.has(rowKey(row));
          const enabled = canSelect(row) && !this.sending;
          const observed = row.origin_activity?.observed_at_ms;
          const date = observed ? new Date(observed) : null;
          const time = date ? `${date.getMonth()+1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "";
          return h_flex().id(`interrupted-row-${row.address}`).flex_none().p(10).gap(10).items_center().rounded(7)
            .border(1).border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.raised)
            .when(enabled, el => el.cursor_pointer().hover(el => el.bg(t.hover)))
            .on_click((_e, cx) => this.toggle(row, cx))
            .child(div().w(16).flex_none().text_size(16).text_color(selected ? t.accent : t.dim).child(selected ? "☑" : "☐"))
            .child(v_flex().flex_1().min_w(0).gap(4)
              .child(div().text_size(13).truncate().tooltip(title?.name ?? row.agent).child(title?.name ?? row.agent))
              .child(div().text_size(11).text_color(t.muted).truncate().tooltip(title?.space ?? row.cwd)
                .child(`${title?.space ?? row.cwd}${time ? ` · 마지막 관측 ${time}` : ""}`)))
            .child(div().flex_none().text_size(11).text_color(enabled ? t.accent : t.dim).child(rowLabel(row)));
        })))
      .when(Boolean(this.message), el => el.child(div().text_size(12).text_color(t.muted).child(this.message)))
      .child(div().text_size(11).text_color(t.dim).child("한 번에 최대 2개씩 시작합니다. 승인 대기·오류 상태에서는 지시를 보내지 않습니다."))
      .child(h_flex().gap(8).justify_end()
        .child(div().id("interrupted-close").px(12).py(8).rounded(6).cursor_pointer().bg(t.raised)
          .on_click(() => closeOverlay(props()?.overlay)).child("닫기"))
        .child(div().id("interrupted-continue").px(12).py(8).rounded(6)
          .bg(canSubmit ? t.selected : t.raised).text_color(canSubmit ? t.accent : t.dim)
          .when(canSubmit, el => el.cursor_pointer().hover(el => el.bg(t.hover)))
          .on_click((_e, cx) => this.submit(cx))
          .child(this.sending ? "재개 요청 중…" : `선택한 ${targets.length}개 재개`)));
  }
}
