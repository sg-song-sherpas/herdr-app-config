import { div } from "gpui-kit";
import { h_flex, v_flex, Select, Popup, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { shared, setShared, exec, appHome, hc, openOverlay, run, layout } from "herdr";

const KEY = "ai.connection";
const labels = { none: "사용 안 함", codex: "Codex · ChatGPT 구독", claude: "Claude Code · Claude 구독" };

export function aiConfig() {
  const value = shared(KEY) ?? {};
  return {
    provider: ["codex", "claude"].includes(value.provider) ? value.provider : "none",
    context: value.context !== false,
    authRevision: value.authRevision ?? 0,
    models: { codex: "", claude: "", ...(value.models ?? {}) },
  };
}

function hasContext(node) {
  return node?.id === "ai-context" || (node?.children ?? []).some(hasContext);
}

function change(edit) {
  const next = aiConfig();
  edit(next);
  setShared(KEY, next);
  if (hasContext(layout())) run(next.provider !== "none" && next.context ? "layout.show" : "layout.hide", { id: "ai-context" });
}

export function initAI(view, cx) {
  view.aiModelOpen = false;
  view.aiModelAt = 0;
  view.aiModels = {};
  view.aiModelsLoading = {};
  view.aiModelsError = {};
  view.aiModelTriggerFocus = cx.focus_handle();
  view.aiModelListFocus = cx.focus_handle();
  view.aiModelScroll = VirtualListScrollHandle.new();
  view.aiAvailability = null;
  view.aiNotice = null;
  view.aiLoginBusy = false;
  view.aiAuth = {};
}

export function probeAI(view, cx) {
  if (view.aiProbing) return;
  view.aiProbing = true;
  cx.spawn(async cx => {
    try {
      const r = await exec("python3", [`${appHome()}/mods/ai-context/bridge.py`, "availability"]);
      view.aiAvailability = r.code === 0 ? JSON.parse(r.stdout) : {};
      view.aiNotice = r.code === 0 ? null : "명령줄 도구 설치 상태를 확인하지 못했습니다.";
      probeModels(view, cx);
    } catch { view.aiNotice = "Python 3와 AI 명령줄 도구가 실행 경로에 있는지 확인해 주세요."; }
    view.aiProbing = false;
    cx.notify();
  });
}

export function probeModels(view, cx) {
  const provider = aiConfig().provider;
  if (provider === "none" || view.aiModelsLoading[provider] || view.aiModels[provider] ||
      view.aiAvailability?.[provider] !== true) return;
  view.aiModelsLoading[provider] = true;
  cx.spawn(async cx => {
    try {
      const r = await exec("python3", [`${appHome()}/mods/ai-context/bridge.py`, "models", provider],
        { timeout: 95000 });
      const result = JSON.parse(r.stdout);
      if (!result.ok || !Array.isArray(result.models)) throw new Error("models");
      view.aiModels[provider] = result.models.filter(m => typeof m.id === "string" && typeof m.label === "string");
      delete view.aiModelsError[provider];
    } catch { view.aiModelsError[provider] = "모델 목록을 가져오지 못했습니다."; }
    view.aiModelsLoading[provider] = false;
    cx.notify();
  });
}

export function modelOptions(view, config) {
  const models = view.aiModels[config.provider] ?? [];
  const defaultModel = models.find(m => m.default);
  const options = [{ id: "", label: defaultModel ? `명령줄 도구 기본 · ${defaultModel.label}` : "명령줄 도구 기본 모델" }, ...models];
  const selected = config.models[config.provider] ?? "";
  if (selected && !options.some(m => m.id === selected)) options.push({ id: selected, label: selected });
  return options;
}

export function selectModel(view, model, cx) {
  const provider = aiConfig().provider;
  if (provider === "none") return;
  change(c => { c.models[provider] = model; });
  view.aiModelOpen = false;
  view.aiModelTriggerFocus.focus();
  cx.notify();
}

export function modelKey(view, key, options, cx) {
  if (!view.aiModelOpen) return;
  if (key === "down" || key === "up") {
    view.aiModelAt = Math.max(0, Math.min(options.length - 1, view.aiModelAt + (key === "down" ? 1 : -1)));
  } else if (key === "home") view.aiModelAt = 0;
  else if (key === "end") view.aiModelAt = options.length - 1;
  else if (key === "enter") selectModel(view, options[view.aiModelAt].id, cx);
  else if (key === "escape") { view.aiModelOpen = false; view.aiModelTriggerFocus.focus(); }
  else return;
  if (view.aiModelOpen) view.aiModelScroll.scroll_to_item(view.aiModelAt, "center");
  cx.stop_propagation();
  cx.notify();
}

export function setModelOpen(view, open, options, cx) {
  view.aiModelOpen = open;
  if (open) {
    const config = aiConfig();
    const selected = config.models[config.provider] ?? "";
    view.aiModelAt = Math.max(0, options.findIndex(m => m.id === selected));
    view.aiModelScroll.scroll_to_item(view.aiModelAt, "center");
    view.aiModelListFocus.focus();
  } else view.aiModelTriggerFocus.focus();
  cx.notify();
}

function modelPicker(view, t, config, cx) {
  const options = modelOptions(view, config);
  const selected = config.models[config.provider] ?? "";
  const label = options.find(m => m.id === selected)?.label ?? "명령줄 도구 기본 모델";
  const trigger = h_flex().id("st-ai-model-trigger").w(250).h(32).px(10).gap(8).items_center().rounded(6)
    .track_focus(view.aiModelTriggerFocus)
    .on_click((_e, cx) => {
      setModelOpen(view, !view.aiModelOpen, options, cx);
      cx.stop_propagation();
    })
    .border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground)
    .cursor_pointer().child(div().flex_1().truncate().child(label)).child(div().text_color(t.dim).child("⌄"));
  const option = (m, index) => h_flex().id(`st-ai-model-option-${index}`).role("list_box_option")
      .aria_selected(m.id === selected).when(index === view.aiModelAt, el => el.aria_active_descendant())
      .h(30).px(8).gap(8).items_center().rounded(5).text_size(12.5).text_color(t.foreground)
      .bg(index === view.aiModelAt ? t.selected : t.popover).hover(s => s.bg(t.hover)).cursor_pointer()
      .child(div().flex_1().truncate().child(m.label))
      .child(div().w(14).text_color(t.accent).child(m.id === selected ? "✓" : ""));
  const list = v_flex().id("st-ai-model-options").role("list_box").relative().w(270).p(4)
    .track_focus(view.aiModelListFocus).bg(t.popover).rounded(7).border_1().border_color(t.border)
    .on_key_down((e, cx) => modelKey(view, e.key, options, cx))
    .child(v_virtual_list("st-ai-model-list", options.length, 30, index => options[index].id || "default",
      (range) => options.slice(range.start, range.end).map((m, i) => option(m, range.start + i)))
      .w_full().h(Math.min(300, options.length * 30)).track_scroll(view.aiModelScroll)
      .on_item_click((key, cx) => {
        const model = options.find(m => (m.id || "default") === key);
        if (model) selectModel(view, model.id, cx);
      }))
    .child(Scrollbar.vertical("st-ai-model-list").absolute().inset_0());
  return Select.new("st-ai-model").accessibility_label("요약에 사용할 명령줄 도구 모델")
    .open(view.aiModelOpen).track_focus(view.aiModelTriggerFocus).content_focus_handle(view.aiModelListFocus)
    .on_open_change((open, cx) => setModelOpen(view, open, options, cx))
    .child(Popup.new("st-ai-model-popup", trigger).anchor("top_right")
      .when(view.aiModelOpen, el => el.content(list)));
}

export function probeAuth(view, cx) {
  const provider = aiConfig().provider;
  if (provider === "none" || view.aiCheckingAuth || view.aiAvailability?.[provider] !== true) return;
  view.aiCheckingAuth = true;
  cx.spawn(async cx => {
    try {
      const r = await exec("python3", [`${appHome()}/mods/ai-context/bridge.py`, "status", provider]);
      const status = JSON.parse(r.stdout);
      if (status.ok && aiConfig().provider === provider) {
        const previous = view.aiAuth[provider];
        view.aiAuth[provider] = status;
        const failedLogin = Object.values(shared("ai.context")?.entries ?? {}).some(e => e.error === "login_required");
        if (status.subscription && (previous?.subscription === false || (!previous && failedLogin))) change(c => { c.authRevision = Date.now(); });
      }
    } catch {}
    view.aiCheckingAuth = false;
    cx.notify();
  });
}

function login(view, provider, cx) {
  if (view.aiLoginBusy) return;
  view.aiLoginBusy = true;
  view.aiNotice = null;
  cx.spawn(async cx => {
    try {
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--name", `herdr-ai-login-${provider}`,
        "--label", "herdr.ai-helper=login", "--", "python3",
        `${appHome()}/mods/ai-context/bridge.py`, "login", provider]);
      const address = r.code === 0 ? JSON.parse(r.stdout).address : null;
      if (!address) throw new Error("start");
      openOverlay({ kind: "dialog", width: 700, height: 380,
        layout: { type: "column", children: [
          { type: "block", size: { px: 32 }, content: { mod: "ai-context", props: { loginBar: true, provider, terminal: address } } },
          { type: "block", content: { terminal: address } },
        ] } });
      view.aiNotice = "로그인 창의 안내에 따라 브라우저에서 구독 계정으로 로그인해 주세요.";
    } catch { view.aiNotice = "로그인 창을 열지 못했습니다. 명령줄 도구 설치 상태를 확인해 주세요."; }
    view.aiLoginBusy = false;
    cx.notify();
  });
}

export function renderAI(view, t, cx) {
  const config = aiConfig();
  const provider = config.provider;
  const installed = view.aiAvailability?.[provider];
  const authenticated = view.aiAuth[provider];
  const options = h_flex().gap(6).children(Object.entries(labels).map(([id, text]) =>
    view.button(t, `st-ai-${id}`, text, (_e, cx) => {
      change(c => { c.provider = id; });
      view.aiModelOpen = false;
      view.aiNotice = null;
      probeModels(view, cx);
      cx.notify();
    }).bg(provider === id ? t.selected : t.raised)));
  return v_flex().w_full()
    .child(view.heading(t, "AI 연결"))
    .child(div().pb(12).text_size(13).line_height("19px").text_color(t.muted)
      .child("이 컴퓨터의 Codex·Claude Code 로그인과 구독을 사용합니다. Herdr는 별도 API 키를 저장하지 않습니다."))
    .child(options)
    .when(provider !== "none", el => el
      .child(view.row(t, "브라우저 로그인",
        installed === false ? `${provider === "codex" ? "Codex" : "Claude Code"} 명령줄 도구 설치가 필요합니다.` :
          authenticated?.subscription ? "구독 계정에 로그인되어 있습니다." :
          authenticated?.ok ? "구독 계정으로 로그인해 주세요. API 키 연결은 사용하지 않습니다." :
          "이미 명령줄 도구에 로그인했다면 그대로 사용합니다. 로그인 상태 확인 중…",
        view.button(t, "st-ai-login", view.aiLoginBusy ? "로그인 창 여는 중…" : "브라우저로 로그인",
          (_e, cx) => { if (installed !== false) login(view, provider, cx); })
          .opacity(installed === false || view.aiLoginBusy ? 0.45 : 1)))
      .when(installed === false, el => el.child(div().pt(8).text_size(12).text_color(t.dim)
        .child(`터미널에서 설치: npm install -g ${provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code"}`)))
      )
    .child(div().pt(10).text_size(12.5).line_height("19px").text_color(t.dim)
      .child("아래에서 고른 모델로 응답을 요약합니다. 코딩 에이전트의 모델은 바꾸지 않습니다."))
    .when(Boolean(view.aiNotice), el => el.child(div().pt(12).text_size(12.5).text_color(t.muted).child(view.aiNotice)))
    .child(h_flex().pt(12).child(view.button(t, "st-ai-installation", "명령줄 도구 설치 상태 확인",
      (_e, cx) => { delete view.aiModels[provider]; probeAI(view, cx); })));
}
