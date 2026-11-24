import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, appHome, exec, theme, closeOverlay, run, shared, setShared } from "herdr";

const PHASE = {
  waiting_idle: "현재 작업이 끝나기를 기다리고 있습니다",
  choice: "미커밋 변경을 가져갈까요?",
  request_issue: "이슈 생성 명령을 준비하고 있습니다",
  sending: "에이전트에게 이슈 생성을 요청하고 있습니다",
  awaiting_issue: "에이전트가 Linear 이슈를 생성하고 있습니다",
  prepare_files: "이슈 전용 워크트리를 만들고 있습니다",
  copy_files: "변경 파일과 스테이징 상태를 옮기고 있습니다",
  clean_source: "복구용 stash를 남기고 원래 폴더를 정리하고 있습니다",
  stop_source: "기존 에이전트를 종료하고 있습니다",
  launch: "새 워크트리에서 같은 대화를 재개하고 있습니다",
  verify: "세션 ID와 새 작업 경로를 확인하고 있습니다",
  complete: "이슈 생성과 세션 이동을 마쳤습니다",
  stopping: "진행 중인 단계가 끝나면 이동을 중단합니다",
  cancelled: "이동을 중단했습니다",
  restored: "원래 작업 폴더에서 대화를 복구했습니다",
};

export default class IssueMove extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.pending = false;
    this.error = "";
    this.value = null;
    if (props()?.operation) this.call("get", [props().operation], cx);
    else this.call("begin", [props()?.terminal, props()?.name ?? ""], cx);
    cx.timer.every(1500, cx => {
      if (this.value?.id && !this.pending) this.call("get", [this.value.id], cx);
    });
  }

  call(verb, args, cx) {
    if (this.pending) return;
    this.pending = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec("python3", [`${appHome()}/mods/agent-issue/move.py`, verb, ...args], { timeout: 60000 });
        if (r.code !== 0) throw new Error(r.stderr?.trim() || "이동 상태를 확인하지 못했습니다.");
        this.value = JSON.parse(r.stdout);
        this.error = "";
        setShared("issueMoves", { ...(shared("issueMoves") ?? {}), [this.value.id]: this.value });
      } catch (e) { this.error = String(e.message ?? e); }
      this.pending = false;
      cx.notify();
    });
  }

  button(id, text, fn, t, primary = false) {
    return div().id(id).px(12).py(7).rounded(5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover(s => s.opacity(0.85)).on_click((_e, cx) => { if (!this.pending) fn(cx); }).child(text);
  }

  render(cx) {
    const t = theme(), s = this.value;
    const error = this.error || s?.error;
    const dismiss = () => closeOverlay(props()?.overlay);
    const controls = [];
    if (s?.phase === "choice" && !error) {
      controls.push(this.button("move-take", "변경 가져가기", cx => this.call("choose", [s.id, "take"], cx), t, true));
      controls.push(this.button("move-leave", "변경 두고 가기", cx => this.call("choose", [s.id, "leave"], cx), t));
    }
    const active = s && !["complete", "restored", "cancelled", "stopping"].includes(s.phase);
    if (active && error && s.issue) controls.push(this.button("move-restore", "원래 위치에서 재개", cx => this.call("restore", [s.id], cx), t));
    if (active && error) controls.push(this.button("move-retry", "같은 단계 재시도", cx => this.call("retry", [s.id], cx), t, true));
    if (active) controls.push(this.button("move-stop", "이동 중단", cx => this.call("stop", [s.id], cx), t));
    if (["complete", "restored"].includes(s?.phase)) controls.push(this.button("move-open", "이동한 에이전트 열기", () => {
      run("pane.focus", { terminal: s.new_terminal }); dismiss();
    }, t, true));
    controls.push(this.button("move-close", ["complete", "restored"].includes(s?.phase) || !s ? "닫기" : "창 닫기", dismiss, t));
    return v_flex().id("issue-move-dialog").track_focus(this.handle).w_full().max_h(570).p(20).gap(12)
      .bg(t.popover).text_color(t.foreground).text_size(13)
      .child(div().text_size(16).font_semibold().child("Create Linear Issue & Move to Worktree"))
      .child(div().text_color(t.muted).child(s?.name || props()?.name || "현재 에이전트"))
      .child(div().font_semibold().child(PHASE[s?.phase] ?? (this.pending ? "세션을 확인하고 있습니다…" : "세션을 이동할 수 없습니다")))
      .when(Boolean(error), el => el.child(div().text_color(t.blocked).child(error)))
      .when(s?.phase === "choice", el => el
        .child(div().text_color(t.muted).child("가져가면 새 폴더에서 검증한 뒤 원래 폴더의 변경을 정리합니다. 복구용 stash는 보존합니다. 두고 가면 현재 커밋에서 시작합니다."))
        .child(v_flex().id("move-files").max_h(190).overflow_y_scrollbar().gap(3)
          .children((s?.files ?? []).map((f, i) => div().id(`move-file-${i}`).text_size(12).child(f.path)))))
      .when(Boolean(s?.issue), el => el.child(div().text_color(t.accent).child(`${s.issue.identifier} ${s.issue.title}`)))
      .when(Boolean(s?.path), el => el.child(div().text_size(12).text_color(t.muted).child(s.path)))
      .when(Boolean(s?.stash), el => el.child(div().text_size(11).text_color(t.dim).child(`복구용 stash: ${s.stash}`)))
      .when(active || s?.phase === "stopping" || s?.phase === "cancelled", el => el.child(div().text_size(12).text_color(t.muted).child("중단하면 자동 이동을 멈춥니다. 이미 생성된 이슈·워크트리·파일과 실행 중인 세션은 유지합니다.")))
      .when(s?.phase === "awaiting_issue", el => el.child(div().text_color(t.muted).child("에이전트가 질문하거나 승인을 기다리면 원래 탭에서 응답해 주세요. 이슈 생성 요청은 자동으로 반복하지 않습니다.")))
      .when(s?.phase === "verify", el => el.child(div().text_color(t.muted).child("새 탭에서 권한 확인이나 질문을 기다릴 수 있습니다. 에이전트가 응답을 마치면 이동을 완료합니다.")))
      .when(active, el => el.child(div().text_size(11).text_color(t.dim).child("‘이동 중단’을 누르기 전에는 창을 닫아도 사이드바에서 진행합니다. 우클릭 메뉴로 진행 상태를 다시 열 수 있습니다.")))
      .child(h_flex().gap(8).flex_wrap().children(controls));
  }
}
