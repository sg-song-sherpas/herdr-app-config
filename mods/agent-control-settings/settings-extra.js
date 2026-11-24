// Personal settings extension; no additions to Herdr's settings.json schema.
import { div } from "gpui-kit";
import { h_flex, v_flex, Select, Popup } from "gpui-base";
import { shared, setShared, exec, appHome } from "herdr";
import { renderAI } from "./ai.js";

export const DEFAULT_CONFIG = {
  autoResponseSummary: false, responseSummaryModels: {},
  unreadAnimation: "highlight", sidebarCompletionNotifications: false,
};

export function config() {
  return { ...DEFAULT_CONFIG, ...(shared("acc.config") ?? {}) };
}

export function changeConfig(edit) {
  const value = config();
  edit(value);
  setShared("acc.config", value);
}

export function initControlSettings(view, cx) {
  if (typeof shared("acc.config")?.sidebarCompletionNotifications !== "boolean") {
    changeConfig(next => { next.sidebarCompletionNotifications = false; });
  }
  view.responseModelOpen = false;
  view.responseModels = {};
  view.responseModelLoading = false;
  view.responseModelError = null;
  view.responseModelFocus = cx.focus_handle();
  view.responseModelListFocus = cx.focus_handle();

}

function responseModelOptions(view, provider) {
  const current = config().responseSummaryModels?.[provider] || "";
  const inherited = shared("ai.connection")?.models?.[provider] || "명령줄 도구 기본 모델";
  const options = [{ id: "", label: `Herdr AI 연결 모델 · ${inherited}` },
    ...(view.responseModels?.[provider] ?? [])];
  if (current && !options.some(item => item.id === current)) options.push({ id: current, label: current });
  return options;
}

function loadResponseModels(view, provider, cx) {
  if (view.responseModelLoading || view.responseModels[provider]) return;
  view.responseModelLoading = true;
  cx.spawn(async cx => {
    try {
      const result = await exec("python3", [`${appHome()}/mods/ai-context/bridge.py`, "models", provider],
        { timeout: 40000 });
      const value = JSON.parse(result.stdout);
      if (!value.ok || !Array.isArray(value.models)) throw new Error("모델 목록을 가져오지 못했습니다.");
      view.responseModels[provider] = value.models.filter(item => typeof item.id === "string" && typeof item.label === "string");
      view.responseModelError = null;
    } catch {
      view.responseModelError = "모델 목록을 가져오지 못했습니다. Herdr AI 연결 모델은 계속 사용할 수 있습니다.";
    }
    view.responseModelLoading = false;
    cx.notify();
  });
}

function responseModelPicker(view, t, provider) {
  const options = responseModelOptions(view, provider);
  const selected = config().responseSummaryModels?.[provider] || "";
  const trigger = h_flex().id("acc-response-model").w(285).h(32).px(10).gap(8).items_center()
    .rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground).text_size(12)
    .track_focus(view.responseModelFocus).cursor_pointer().on_click((_event, cx) => {
      view.responseModelOpen = !view.responseModelOpen;
      if (view.responseModelOpen) {
        loadResponseModels(view, provider, cx);
        view.responseModelListFocus.focus();
      }
      cx.stop_propagation();
      cx.notify();
    })
    .child(div().flex_1().truncate().child(options.find(item => item.id === selected)?.label || selected))
    .child("⌄");
  const list = v_flex().id("acc-response-model-list").w(310).max_h(300).p(4).gap(2)
    .overflow_y_scrollbar().rounded(7).bg(t.popover).border_1().border_color(t.border)
    .track_focus(view.responseModelListFocus)
    .on_key_down((event, cx) => {
      if (event.key === "escape") { view.responseModelOpen = false; view.responseModelFocus.focus(); cx.notify(); }
    })
    .when(view.responseModelLoading, element => element.child(div().px(8).py(6).text_color(t.dim).child("모델 목록 불러오는 중…")))
    .children(options.map(item => h_flex().id(`acc-response-model-${item.id || "inherit"}`).h(30).px(8)
      .items_center().rounded(5).text_size(12).text_color(t.foreground)
      .bg(item.id === selected ? t.selected : t.popover).hover(style => style.bg(t.hover)).cursor_pointer()
      .on_click((_event, cx) => {
        changeConfig(next => { next.responseSummaryModels = { ...(next.responseSummaryModels ?? {}), [provider]: item.id }; });
        view.responseModelOpen = false;
        view.responseModelFocus.focus();
        cx.notify();
      }).child(div().flex_1().truncate().child(item.label)).when(item.id === selected, element => element.child("✓"))));
  return Select.new("acc-response-model-select").accessibility_label("완료 응답 자동 요약 모델")
    .open(view.responseModelOpen).track_focus(view.responseModelFocus).content_focus_handle(view.responseModelListFocus)
    .on_open_change((open, cx) => { view.responseModelOpen = open; cx.notify(); })
    .child(Popup.new("acc-response-model-popup", trigger).anchor("top_right")
      .when(view.responseModelOpen, element => element.content(list)));
}

function choose(view, t, id, values, current, onChange) {
  return h_flex().flex_wrap().gap(4).children(values.map(([value, label]) =>
    view.button(t, `${id}-${value}`, (current === value ? "✓ " : "") + label,
      (_e, cx) => { onChange(value); cx.notify(); })));
}

export function renderControlSettings(view, t, cx) {
  const c = config();
  const toggle = (key, title, about) => view.row(t, title, about,
    view.toggle(t, `acc-${key}`, c[key], (_e, cx) => {
      changeConfig(next => { next[key] = !next[key]; });
      cx.notify();
    }));
  const select = (key, title, about, values) => view.row(t, title, about,
    choose(view, t, `acc-${key}`, values, c[key], value => changeConfig(next => { next[key] = value; })));
  return v_flex().w_full()
    .child(renderAI(view,t,cx))
    .child(view.heading(t,"응답 요약"))
    .child(toggle("autoResponseSummary","완료 응답 자동 요약",
      "완료 응답을 연결한 AI에 보내 요약합니다. 상단과 미확인 카드에 표시하며, 원래 대화에 영향을 주지 않습니다."))
    .when(["codex","claude"].includes(shared("ai.connection")?.provider),element=>element
      .child(view.row(t,"요약 모델","요약에만 사용할 모델입니다.",
        responseModelPicker(view,t,shared("ai.connection").provider))))
    .when(Boolean(view.responseModelError),element=>element.child(div().py(6).text_size(11).text_color(t.dim).child(view.responseModelError)))
    .child(view.heading(t,"표시와 알림"))
    .child(select("unreadAnimation","새 미확인 카드 효과","새로 도착한 카드에만 적용합니다.",
      [["none","없음"],["fade","서서히 나타나기"],["slide","옆에서 나타나기"],["highlight","강조"]]))
    .child(toggle("sidebarCompletionNotifications","좌측 완료 알림",
      "왼쪽 아래에 완료 팝업을 표시합니다. 미확인 카드는 우측에서 볼 수 있습니다."))
    .when(Boolean(shared("acc.notification-error")),element=>element.child(div().py(8).text_size(12).text_color(t.foreground)
      .child(`알림 설정 적용 실패: ${shared("acc.notification-error")}`)));
}
