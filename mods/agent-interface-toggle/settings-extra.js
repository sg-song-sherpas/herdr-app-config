// Personal settings extension; no additions to Herdr's settings.json schema.
import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, Select, Popup } from "gpui-base";
import { shared, setShared, run, focused, layout, exec, appHome } from "herdr";
import { captureNavigation } from "./navigation-state.js";

export const DEFAULT_CONFIG = {
  enabled: true, autoDisplay: "important", showRepository: true,
  showDecisions: true, showTests: true, showNextAction: true,
  autoSnapshot: true, gitMonitoring: true, conflictDetection: true,
  dependencyAnalysis: true, retentionDays: 30, attentionQueue: true,
  priorityThreshold: 0, summaryProvider: "none", summaryModel: "",
  summaryConsent: false,
  autoResponseSummary: false, responseSummaryModels: {},
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
  view.responseModelOpen = false;
  view.responseModels = {};
  view.responseModelLoading = false;
  view.responseModelError = null;
  view.responseModelFocus = cx.focus_handle();
  view.responseModelListFocus = cx.focus_handle();
  view.summaryModelInput = InputState.new({ placeholder: "CLI default model", value: config().summaryModel });
  view.summaryModelInput.on("submit", (_e, cx) => {
    changeConfig(next => { next.summaryModel = view.summaryModelInput.value().trim().slice(0, 100); });
    cx.notify();
  });
}

function responseModelOptions(view, provider) {
  const current = config().responseSummaryModels?.[provider] || "";
  const inherited = shared("ai.connection")?.models?.[provider] || "CLI 기본 모델";
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

export function switchInterface(mode) {
  const c = config();
  const current = shared("layout") ?? "main";
  const f = focused();
  const navigation = captureNavigation(layout());
  if (mode === "control") {
    if (current !== "agent-control-center") c.classicLayout = current;
    c.interfaceMode = "control";
  } else {
    c.interfaceMode = "classic";
  }
  const target = mode === "control" ? "agent-control-center" : (c.classicLayout || "main");
  setShared("acc.config", c);
  run("layout.switch", { name: target });
  for (const entry of navigation) run(entry.command, entry.args);
  // This strip owns collection and shortcuts. Migrate older hidden-panel state.
  if (mode === "control") run("layout.show", { id: "acc-context" });
  if (f?.pane) run("pane.focus", { pane: f.pane });
  else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
}

function choose(view, t, id, values, current, onChange) {
  return h_flex().flex_wrap().gap(4).children(values.map(([value, label]) =>
    view.button(t, `${id}-${value}`, (current === value ? "✓ " : "") + label,
      (_e, cx) => { onChange(value); cx.notify(); })));
}

export function interfaceRow(view, t) {
  const mode = shared("layout") === "agent-control-center" ? "control" : "classic";
  return view.row(t, "Interface Mode",
    "현재 터미널과 에이전트를 유지한 채 화면을 전환합니다.",
    choose(view, t, "acc-mode", [["classic", "Classic"], ["control", "Control Center"]], mode,
      value => switchInterface(value)));
}

export function renderControlSettings(view, t) {
  const c = config();
  const toggle = (key, title, about) => view.row(t, title, about,
    view.toggle(t, `acc-${key}`, c[key], (_e, cx) => {
      changeConfig(next => { next[key] = !next[key]; });
      cx.notify();
    }));
  const select = (key, title, about, values) => view.row(t, title, about,
    choose(view, t, `acc-${key}`, values, c[key], value => changeConfig(next => { next[key] = value; })));
  return v_flex().w_full()
    .child(view.heading(t, "Agent Control Center"))
    .child(interfaceRow(view, t))
    .child(toggle("enabled", "Context Engine", "끄면 새 이벤트 수집을 중지합니다. 저장한 맥락은 유지합니다."))
    .child(view.heading(t, "Resume Overlay"))
    .child(select("autoDisplay", "Auto Display", "자동 창은 터미널의 키보드 포커스를 가져오지 않습니다.",
      [["always", "Always"], ["important", "Important Changes Only"], ["manual", "Manual Only"]]))
    .child(toggle("showRepository", "Show Repository Changes", null))
    .child(toggle("showDecisions", "Show Decisions", null))
    .child(toggle("showTests", "Show Test Results", null))
    .child(toggle("showNextAction", "Show Suggested Next Action", null))
    .child(view.heading(t, "Context Memory"))
    .child(toggle("autoSnapshot", "Auto Snapshot", "식별된 세션 기록의 새 메시지를 증분으로 읽습니다."))
    .child(view.heading(t, "완료 응답 자동 요약"))
    .child(toggle("autoResponseSummary", "완료 즉시 AI 정제",
      "켜면 완료 응답을 연결된 Codex·Claude 구독 모델로 자동 전송해 정제합니다. 탭을 열기 전에도 동작하며 원래 대화에는 입력하지 않습니다."))
    .child(view.row(t, "AI 연결", "제공자와 로그인은 기존 Herdr AI 설정을 사용합니다.",
      div().text_size(12).text_color(t.foreground).child(shared("ai.connection")?.provider === "codex" ? "Codex · ChatGPT 구독" :
        shared("ai.connection")?.provider === "claude" ? "Claude · Claude 구독" : "설정 → AI에서 연결하세요.")))
    .when(["codex", "claude"].includes(shared("ai.connection")?.provider), element => element
      .child(view.row(t, "응답 요약 모델", "이 기능의 모델만 선택합니다. 원래 코딩 에이전트 모델과 Herdr AI 연결 설정은 바꾸지 않습니다.",
        responseModelPicker(view, t, shared("ai.connection").provider))))
    .when(Boolean(view.responseModelError), element => element.child(div().py(6).text_size(11).text_color(t.dim).child(view.responseModelError)))
    .child(view.heading(t, "고급 Snapshot 요약 · 수동"))
    .child(view.row(t, "Summary Provider",
      "기본은 로컬 규칙입니다. Codex·Claude를 선택하면 마스킹한 새 메시지를 별도 구독 호출로 전송합니다. 원래 에이전트 대화에는 입력하지 않습니다.",
      choose(view, t, "acc-provider", [["none", "Local Rules"], ["codex", "Codex"], ["claude", "Claude"]], c.summaryProvider,
        value => changeConfig(next => {
          next.summaryProvider = value;
          next.summaryConsent = value !== "none";
        }))))
    .when(c.summaryProvider !== "none", element => element.child(view.row(t, "Summary Model",
      "빈 값은 CLI 기본 모델을 사용합니다. 모델 이름을 입력하고 Apply를 누릅니다.",
      h_flex().gap(5).items_center()
        .child(div().w(180).child(Input.new(view.summaryModelInput)))
        .child(view.button(t, "acc-model-apply", "Apply", (_e, cx) => {
          changeConfig(next => { next.summaryModel = view.summaryModelInput.value().trim().slice(0, 100); });
          cx.notify();
        })))))
    .child(div().py(8).text_size(12).text_color(t.dim)
      .child("AI 요약 버튼을 누를 때만 별도 호출합니다. 일반적인 키·토큰은 가리지만 임의의 비밀값을 모두 판별할 수는 없습니다. 기밀 작업에는 Local Rules를 사용하세요. AI 요약은 미검증 보고로 표시하며, 호출 실패 시 로컬 규칙을 사용합니다."))
    .child(select("retentionDays", "Retention", "확인한 이벤트와 종료한 세션을 정리합니다. 미확인 경계는 따로 보존합니다.",
      [[7, "7 days"], [30, "30 days"], [90, "90 days"]]))
    .child(view.heading(t, "Repository Intelligence"))
    .child(toggle("gitMonitoring", "Git Monitoring", "Git 상태와 diff를 읽습니다. Git 파일을 변경하지 않습니다."))
    .child(toggle("conflictDetection", "Conflict Detection", "같은 파일과 변경 심볼을 비교합니다. 잠재 위험과 실제 충돌을 구분합니다."))
    .child(toggle("dependencyAnalysis", "Dependency Analysis", "변경한 계약과 다른 작업의 참조를 제한된 범위에서 비교합니다. 잠재 위험입니다."))
    .child(view.heading(t, "Notifications"))
    .child(toggle("attentionQueue", "Unread Completed Agents", "Herdr의 파란 완료 표시가 켜진 에이전트의 응답만 표시합니다."))
    .child(view.heading(t, "Recovery"))
    .child(div().text_size(12).text_color(t.muted)
      .child("Interface Mode에서 Classic을 선택하면 원래 화면으로 돌아갑니다. 비상 복구는 Ctrl+Alt+Shift+Escape입니다. 설정과 데이터는 acc 이름공간과 data/agent-control-center에 보관합니다."))
    .child(view.button(t, "acc-original-settings", "Open built-in Settings", () => run("app.settings")));
}
