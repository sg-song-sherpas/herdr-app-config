import { responseOutcome, responseOutcomePalette } from "./response-outcome.js";
import { createFrameStateReader } from "./frame-state.js";
import { orderUnreadCards, takeNextUnread } from "./unread-order.js";
import { renderUnreadCard } from "./unread-card-view.js";
import { manualUnread, unreadStatus, clearManualUnread } from "./manual-unread.js";
import { issueLabel } from "./issue-label.js";
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, TextView, EditorState, Editor, TextareaState, Textarea } from "gpui-base";
import {
  agents, terminals, panes, spaces, focused, shared, setShared, theme, run,
  props, appHome, exec, openOverlay, closeOverlay, nextCommand, layout, hc, window, notify,
} from "herdr";
import {
  configOf, resumeOf, taskFor, boundary, unread, repositoryTasks,
  attentionFor, conflictsFor, resumePolicy, stateSignature, plain,
  dateLabel, detailMarkdown, frozenDetail, importantSignal, shouldOpenResume,
  acknowledgmentAllowed,
  displaySnapshot,
  eventSourceAvailable,
  headerDensity, freshnessLabel, unreviewedCount,
  collectionNotice, recentReport,
  sharedWorktreeTasks,
  boundedCoreReport,
  attentionTone, agentAttentionBadge,
  goalLabel,
} from "./context.js";

import { contextBrief, attentionBrief } from "./digest.js";
import { controlPalette, unreadCompletedAgents } from "./palette.js";
import { unreadDockAction } from "./unread-dock.js";
import { motionMode, newlyPresented, cardMotion } from "./unread-motion.js";
import { unreadCardValue } from "./unread-card.js";
import { responseIdentity, responsePresentation, headlineSize, preparedHistory } from "./response-presentation.js";

import { noteKey, noteText, notePreview, saveTabNote, MAX_NOTE_LENGTH, noteEditorValue, retainNoteDraft } from "./tab-notes.js";

import { PRIORITY_KEY, worktreePriority, priorityStyle } from "./worktree-priority.js";

const NOTES = "acc.tab-notes", NOTE_DRAFTS = "acc.tab-note-drafts";
const CONFIG = "acc.config", STATE = "acc.state", ACTION = "acc.action";
const selectedAddress = () => focused()?.shown ?? focused()?.terminal ?? focused()?.agent ?? null;
const stateReader = createFrameStateReader(() => shared(STATE) ?? { tasks: [], attention: [], conflicts: [], errors: [] });
const currentState = () => stateReader.get();
const agentName = task => task.tabName ?? task.tab_name ?? task.address;

function request(action) {
  if (action.type === "refresh") setShared("acc.action-error", null);
  const entry = { ...action, nonce: `${Date.now()}-${Math.random()}` };
  const queue = shared("acc.actions") ?? [];
  setShared("acc.actions", [...queue, entry].slice(-64));
  setShared(ACTION, entry);
}

function openDetail(view, task = taskFor(currentState(), selectedAddress())) {
  const snapshot = frozenDetail(task, currentState(), configOf(shared(CONFIG)));
  const id = openOverlay({
    mod: "agent-control-center", kind: "dialog", modal: false, key: "acc-resume",
    width: 760, height: 510,
    props: { role: "detail", view, taskId: task?.taskId ?? null, ...snapshot },
  });
  setShared("acc.open-detail", { id, taskId: task?.taskId ?? null });
}

function focusTask(task, withResume = false) {
  if (!task?.address) return;
  run("agent.focus", { terminal: task.address });
  if (withResume) openDetail("resume", task);
}

function openSource(task, eventId = null) {
  if (!task) return;
  openOverlay({
    mod: "agent-control-center", kind: "dialog", modal: false, key: "acc-source-log",
    width: 840, height: 560,
    props: { role: "source", taskId: task.taskId, taskName: agentName(task), eventId },
  });
}

function openResponseHistory(address, identityKey, title) {
  if (!address || !identityKey) return;
  const id = openOverlay({
    mod: "agent-control-center", kind: "dialog", modal: false, key: "acc-response-history",
    width: 760, height: 560,
    props: { role: "history", address, identityKey, title },
  });
  setShared("acc.response-history-open", { id, address });
}

function tabNoteTarget(address = null) {
  const f = focused(), agent = address ? agents().find(item => item.address === address) : null;
  const space = spaces().find(item => item.id === (agent?.space ?? f?.space));
  const tabId = agent?.tab ?? (address ? null : f?.tab);
  if (!space || !tabId) return null;
  const tab = space.tabs?.find(item => item.id === tabId);
  const key = noteKey(tabId, space?.machine);
  return key ? { key, tabId, machine: space?.machine ?? null, title: tab?.name || agent?.tab_name || "Tab" } : null;
}

function openTabNote(target) {
  if (!target?.key) return;
  openOverlay({ mod: "agent-control-center", kind: "dialog", modal: false, key: `acc-tab-note-${target.key}`,
    width: 640, height: 400, props: { role: "note-editor", target } });
}

function acknowledgeManualUnread(terminal, cx) {
  if (!manualUnread(terminal)) return;
  cx.spawn(async cx => {
    try { await clearManualUnread(terminal, hc); }
    catch (error) { notify({ title: "읽음 표시를 저장하지 못했습니다", body: String(error), level: "error" }); }
    cx.notify();
  });
}

function focusCompleted(address, cx) {
  const terminal = terminals().find(item => item.address === address);
  acknowledgeManualUnread(terminal, cx);
  setShared("acc.completion-focus", { address, identityKey: responseIdentity(terminal, resumeOf(terminal)) });
  run("agent.focus", { terminal: address });
}

function liveAgents() {
  const live = terminals();
  const paneInfo = panes();
  const spaceInfo = spaces();
  return agents().map(agent => {
    const terminal = live.find(item => item.address === agent.address) ?? {};
    const pane = paneInfo.find(item => item.terminal === agent.address);
    const space = spaceInfo.find(item => item.id === agent.space);
    if (terminal.labels?.["herdr.ai-helper"] || terminal.labels?.["acc.helper"]) return null;
    return {
      address: agent.address, pane: agent.pane, space: agent.space, tab: agent.tab,
      tab_name: String(agent.tab_name ?? agent.address).slice(0, 180),
      status: unreadStatus(agent.status, terminal), seq: agent.seq, app: agent.app,
      cwd: pane?.cwd ?? terminal.foreground?.cwd ?? terminal.cwd ?? space?.folder,
      machine: space?.machine ?? null, resume: resumeOf(terminal),
      labels: { "herdr.resume": terminal.labels?.["herdr.resume"] },
      created_ms: terminal.created_ms, created: terminal.created, pid: terminal.pid,
      foreground: { pid: terminal.foreground?.pid, name: terminal.foreground?.name,
        cwd: terminal.foreground?.cwd },
      turn: terminal.turn, report: boundedCoreReport(terminal.report),
    };
  }).filter(Boolean);
}

export default class ControlCenter extends View {
  init(_props, cx) {
    this.busy = false;
    this.summaryBusy = false;
    this.headerWidth = 1000;
    this.contextWidth = 1000;
    this.attentionWidth = 1000;
    this.attentionTab = "decision";
    this.attentionOffset = 0;
    this.lastFocus = null;
    this.lastObservation = "";
    this.lastAction = null;
    this.lastAuto = null;
    this.unreadJumpPending = new Map();
    this.showEvidence = false;
    this.unreadMotion = new Map();
    if (props()?.role === "note-editor") {
      const target = props()?.target, notes = shared(NOTES) ?? {};
      const initial = noteEditorValue(notes, shared(NOTE_DRAFTS), target?.key);
      this.noteVersion = initial.version;
      this.noteRestored = initial.restored;
      this.noteStaleDraft = initial.staleDraft;
      this.noteEditor = TextareaState.new({ placeholder: "이 탭에서 기억할 내용이나 다음에 확인할 일을 적어두세요.",
        value: initial.text, rows: 8 });
      this.noteEditor.on("change", (_event, cx) => { this.noteError = null; this.noteStaleDraft = false; cx.notify(); });
      this.noteEditor.on("submit", (event, cx) => {
        if (event.secondary === true && event.shift !== true) this.saveNote(cx);
      });
      cx.timer.after(50, () => this.noteEditor.focus());
      return;
    }
    if (props()?.role === "history") {
      this.historyLoading = true;
      this.responseHistory = [];
      cx.spawn(async cx => {
        try {
          const p = props() ?? {};
          const result = await exec("python3", [
            `${appHome()}/mods/agent-control-center/engine/response_engine.py`, "history",
            JSON.stringify({ stateDir: `${appHome()}/data/agent-control-center`, identityKey: p.identityKey, limit: 30 }),
          ], { timeout: 10000 });
          const response = JSON.parse(result.stdout);
          if (!response.ok) throw new Error(response.error ?? "정제 이력을 읽지 못했습니다.");
          this.responseHistory = preparedHistory(response.entries ?? response.history);
        } catch (error) { this.historyError = String(error).slice(0, 250); }
        this.historyLoading = false;
        cx.notify();
      });
      return;
    }
    if (props()?.role === "source") {
      this.sourceEditor = EditorState.new({ language: "json", value: "원본 로그를 읽고 있습니다.", readonly: true });
      this.sourceState = { loading: true };
      cx.spawn(async cx => {
        try {
          const p = props() ?? {};
          const response = await exec("python3", [
            `${appHome()}/mods/agent-control-center/engine/bridge.py`, "read-source",
            JSON.stringify({ stateDir: `${appHome()}/data/agent-control-center`, taskId: p.taskId, eventId: p.eventId }),
          ], { timeout: 10000 });
          const source = JSON.parse(response.stdout);
          if (!source.ok) throw new Error(source.error ?? "원본 로그를 읽을 수 없습니다.");
          this.sourceState = source;
          this.sourceEditor = EditorState.new({ language: "json", value: source.excerpt ?? "", readonly: true });
        } catch (error) {
          this.sourceState = { error: String(error).slice(0, 400) };
          this.sourceEditor = EditorState.new({ language: "text", value: this.sourceState.error, readonly: true });
        }
        cx.notify();
      });
      return;
    }
    if (props()?.role !== "context") return;
    this.collect(cx);
    cx.timer.every(10000, cx => this.collect(cx));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        this.command(typeof command === "string" ? command : command?.command ?? command?.name, cx);
      }
    });
  }

  command(command, cx) {
    const state = currentState();
    const task = taskFor(state, selectedAddress());
    if (command === "refresh") { request({ type: "refresh" }); this.collect(cx); }
    else if (command === "summarize") this.summarize(cx);
    else if (["resume", "response-history"].includes(command)) {
      const address = selectedAddress();
      const terminal = terminals().find(item => item.address === address);
      openResponseHistory(address, responseIdentity(terminal, resumeOf(terminal)),
        task ? agentName(task) : address);
    }
    else if (["delta", "conflicts", "review"].includes(command)) openDetail(command, task);
    else if (command === "toggle") run("mod.open", { name: "agent-control-settings" });
    else if (command === "next-attention") {
      const card=takeNextUnread(this.unreadCards(),this.unreadJumpPending);
      if(card)focusCompleted(card.agent.address,cx);
    } else if (command === "previous") {
      const history = shared("acc.history") ?? [];
      const previous = [...history].reverse().find(address => address !== selectedAddress() && state.tasks.some(item => item.address === address));
      if (previous) focusTask(taskFor(state, previous));
    }
  }

  collect(cx) {
    if (this.busy || !configOf(shared(CONFIG)).enabled) return;
    const candidates = liveAgents();
    const focus = selectedAddress();
    const action = (shared("acc.actions") ?? [])[0] ?? shared(ACTION);
    const payload = {
      agents: candidates, focus, config: configOf(shared(CONFIG)),
      stateDir: `${appHome()}/data/agent-control-center`,
      ...(action?.nonce !== this.lastAction ? { action } : {}),
    };
    this.busy = true;
    this.lastObservation = JSON.stringify([candidates.map(agent => [agent.address, agent.status, agent.seq, agent.turn, agent.resume?.id]), focus, action?.nonce]);
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [
          `${appHome()}/mods/agent-control-center/engine/bridge.py`,
          "exchange", JSON.stringify(payload),
        ], { timeout: 45000 });
        const state = JSON.parse(result.stdout);
        if (result.code !== 0 || !state.ok) throw new Error(state.error ?? result.stderr ?? "Context Engine 실패");
        if (stateSignature(state) !== stateSignature(currentState())) setShared(STATE, state);
        if (action?.nonce && payload.action) {
          this.lastAction = action.nonce;
          setShared("acc.actions", (shared("acc.actions") ?? []).filter(entry => entry.nonce !== action.nonce));
        }
        if (state.actionError) setShared("acc.action-error", `요청 적용 실패 · ${plain(state.actionError.error ?? state.actionError)}`);
        setShared("acc.engine-error", null);
        setShared("acc.last-collection", Date.now());
        this.autoResume(focus, state);
      } catch (error) {
        setShared("acc.engine-error", String(error).slice(0, 500));
      }
      this.busy = false;
      cx.notify();
    });
  }

  summarize(cx) {
    const config = configOf(shared(CONFIG));
    const task = taskFor(currentState(), selectedAddress());
    if (this.summaryBusy || !task || !config.enabled || !config.summaryConsent ||
        !["codex", "claude"].includes(config.summaryProvider)) return;
    this.summaryBusy = true;
    setShared("acc.summary-state", { taskId: task.taskId, status: "working" });
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [
          `${appHome()}/mods/agent-control-center/engine/bridge.py`, "summarize",
          JSON.stringify({ stateDir: `${appHome()}/data/agent-control-center`, taskId: task.taskId, config }),
        ], { timeout: 55000 });
        const response = JSON.parse(result.stdout);
        setShared("acc.summary-state", { taskId: task.taskId, status: response.status ?? "failed", metrics: response.metrics });
      } catch (error) {
        setShared("acc.summary-state", { taskId: task.taskId, status: "failed", error: String(error).slice(0, 200) });
      }
      this.summaryBusy = false;
      this.collect(cx);
      cx.notify();
    });
  }

  autoResume(address, state) {
    if (address !== selectedAddress()) return;
    const terminal = terminals().find(item => item.address === address);
    const completion = shared("acc.completion-focus");
    if (completion?.address === address && completion.identityKey === responseIdentity(terminal, resumeOf(terminal))) {
      if (terminal?.status !== "working") return;
      setShared("acc.completion-focus", null);
    }
    const task = taskFor(state, address);
    if (!task) return;
    // A historical failed test or an unread stored review is not a live request.
    if (liveAgents().find(agent => agent.address === address)?.status !== "blocked") return;
    const policy = resumePolicy(configOf(shared(CONFIG)), task, state);
    const signal = importantSignal(state, task);
    const show = shouldOpenResume(this.lastAuto, address, signal, policy,
      Boolean(shared("acc.open-detail") || shared("acc.response-history-open")));
    this.lastAuto = { address, signal };
    setShared("acc.resume-card", policy === "card" ? { taskId: task.taskId, throughEventId: boundary(task) } : null);
    if (show) openDetail("resume", task);
  }

  button(id, text, action, accent = false, layer = this.colors?.toolbar) {
    const c = layer ?? controlPalette(true).toolbar;
    return div().id(`acc-${id}`).px(9).py(4).rounded(6).text_size(11)
      .bg(accent ? c.accent : c.card).text_color(accent ? c.accentText : c.text)
      .cursor_pointer().hover(style => style.bg(c.hover).text_color(c.text))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click(action).child(text);
  }

  header(cx) {
    const state = currentState(), address = selectedAddress();
    const active = window()?.active === true;
    if (active && (address !== this.lastFocus || this.lastWindowActive === false)) {
      acknowledgeManualUnread(terminals().find(item => item.address === address), cx);
    }
    this.lastWindowActive = active;
    if (address !== this.lastFocus) {
      if (shared("acc.completion-focus")?.address !== address) setShared("acc.completion-focus", null);
      if (this.lastFocus) {
        const history = (shared("acc.history") ?? []).filter(item => item !== this.lastFocus);
        setShared("acc.history", [...history, this.lastFocus].slice(-40));
      }
      this.lastFocus = address;
      this.autoResume(address, state);
    }
    const signature = JSON.stringify([liveAgents().map(agent =>
      [agent.address, agent.status, agent.seq, agent.turn, agent.resume?.id]), address,
      (shared("acc.actions") ?? [])[0]?.nonce ?? shared(ACTION)?.nonce]);
    if (signature !== this.lastObservation) this.collect(cx);
    return div();
  }

  sourceCaption(source) {
    return { git_observation: "Git 관측", test_log: "실행 로그 확인", core_status: "에이전트 요청",
      "core_status+agent_report": "실행 상태 + 에이전트 보고",
      agent_report: "최근 보고 · 검증 전", "agent-report": "최근 보고 · 검증 전",
      "llm-unverified": "AI 요약 · 검증 전" }[source] ?? "";
  }

  context(cx) {
    this.header(cx);
    const address = selectedAddress();
    const terminal = terminals().find(item => item.address === address);
    const task = taskFor(currentState(), address);
    const identityKey = responseIdentity(terminal, resumeOf(terminal));
    const entry = shared("acc.response-summary")?.entries?.[address];
    const automatic = configOf(shared(CONFIG)).autoResponseSummary === true;
    const local = task ? contextBrief(task, currentState(), configOf(shared(CONFIG)), boundary(task)) : null;
    const localReport = local && ["최근 보고 발췌 · 검증 전", "보고된 현재 단계 · 검증 전"].includes(local.summarySource) ? local.summary : "최근 응답은 원문 터미널에서 확인하세요.";
    const quota = entry?.state !== "ready" && (shared("acc.response-summary")?.stats?.providerError === "usage_limit" || entry?.error === "usage_limit");
    const presentation = automatic && quota ? {
      state: "quota", chip: "사용량 한도 · 원문 발췌", headline: localReport,
      caption: "Codex 구독 사용량 한도로 AI 정제 대기 · 반복 호출 제한 · 클릭하면 이력",
    } : automatic ? responsePresentation(terminal, entry, identityKey) : {
      state: "disabled", chip: "원문 발췌", headline: localReport,
      caption: "자동 AI 정제 꺼짐 · 기존 대화 발췌 · 클릭하면 응답 요약 이력",
    };
    const outcome = responseOutcome(terminal, entry, identityKey, presentation, localReport);
    const c = { ...this.colors.context, ...responseOutcomePalette(outcome.kind, this.colors.dark) };
    const noteTarget = tabNoteTarget();
    const personalNote = noteText(shared(NOTES), noteTarget?.key);
    const title = task ? agentName(task) : agents().find(item => item.address === address)?.tab_name ?? "에이전트";
    return h_flex().id("acc-context-card").size_full().px(16).py(12).gap(12).items_center()
      .bg(c.card).border(1).border_color(c.border).rounded(12)
      .on_size_change((size, cx) => { if (this.contextWidth !== size.width) { this.contextWidth = size.width; cx.notify(); } })
      .when(Boolean(identityKey), element => element.cursor_pointer().hover(style => style.bg(c.hover))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click(() => openResponseHistory(address, identityKey, title)))
      .child(div().size(36).flex_none().rounded_full().bg(c.orbOuter).flex().items_center().justify_center()
        .child(div().size(25).rounded_full().bg(c.accent).flex().items_center().justify_center()
          .tooltip(outcome.label).child(svg(`mods/agent-control-center/response-${outcome.kind}.svg`).size(16).text_color(c.accentText))))
      .child(v_flex().flex_1().min_w(0).gap(5)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_size(11).font_semibold().text_color(c.muted).truncate().tooltip(title).child(`최근 응답 · ${issueLabel(title).title}`))
          .child(div().px(7).py(2).rounded(5).bg(c.chipBg).text_size(10).text_color(c.chipText).child(presentation.chip))
          .when(Boolean(noteTarget), element => element.child(this.noteButton(noteTarget, c))))
        .child(div().text_size(headlineSize(this.contextWidth)).font_semibold().text_color(c.text)
          .truncate().tooltip(presentation.headline).child(presentation.headline))
        .when(Boolean(personalNote), element => element.child(h_flex().gap(6).items_center()
          .child(svg("mods/agent-control-center/note.svg").size(14).flex_none().text_color(c.accent))
          .child(div().text_size(12).font_semibold().text_color(c.accent).child("내 메모"))
          .child(div().flex_1().min_w(0).text_size(14).text_color(c.text).truncate().tooltip(personalNote).child(notePreview(personalNote)))))
        .when(!personalNote, element => element.child(div().text_size(10).text_color(c.muted).truncate().tooltip(presentation.caption).child(presentation.caption))))
      .when(Boolean(identityKey), element => element.child(div().flex_none().text_size(22).text_color(c.accent).child("›")));
  }

  layoutNode(id, tree = layout()) {
    if (tree?.id === id) return tree;
    for (const child of tree?.children ?? []) {
      const result = this.layoutNode(id, child);
      if (result) return result;
    }
    return null;
  }

  unreadCards() {
    const entries = configOf(shared(CONFIG)).attentionQueue ? unreadCompletedAgents(liveAgents(), currentState().tasks) : [];
    const summaries = shared("acc.response-summary")?.entries ?? {};
    const native = new Map(terminals().map(terminal=>[terminal.address,terminal]));
    const cards = entries.map(({ agent }) => {
      const terminal = native.get(agent.address);
      const identity = responseIdentity(terminal, resumeOf(terminal));
      const entry = summaries[agent.address];
      const response = responsePresentation(terminal, entry, identity);
      const value = unreadCardValue(terminal, entry, identity, response.state);
      return { agent, response, value, key: JSON.stringify([identity ?? agent.address, terminal?.turn ?? agent.turn]) };
    });
    return orderUnreadCards(cards,spaces(),shared(PRIORITY_KEY));
  }

  attention(cx) {
    const t = theme(), c = { ...this.colors.attention, bg: t.chrome, text: this.colors.dark ? "#ffffff" : t.foreground, muted: this.colors.dark ? "#d8d8d8" : t.muted };
    const cards = this.unreadCards();
    const mode = motionMode(shared(CONFIG)?.unreadAnimation);
    const keys = cards.map(card => card.key);
    const previous = shared("acc.unread-presented");
    if (JSON.stringify(previous) !== JSON.stringify(keys)) {
      for (const key of newlyPresented(previous, keys)) {
        if (mode === "none") continue;
        const motion = { mode, phase: "enter" };
        this.unreadMotion.set(key, motion);
        cx.timer.after(32, cx => {
          if (this.unreadMotion.get(key) !== motion) return;
          motion.phase = "active";
          cx.notify();
        });
        cx.timer.after(1600, cx => {
          if (this.unreadMotion.get(key) !== motion) return;
          this.unreadMotion.delete(key);
          cx.notify();
        });
      }
      setShared("acc.unread-presented", keys.slice(-256));
    }
    return v_flex().id("acc-completed-agents").size_full().bg(c.bg).min_w(0).overflow_hidden()
      .border_l(1).border_color(t.border)
      .child(h_flex().h(36).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .text_size(13).font_semibold().text_color(c.text)
        .child(svg("mods/agent-control-center/inbox.svg").size(14)).child("Unread"))
      .child(v_flex().id("acc-completion-scroll").flex_1().min_h(0).px(12).py(12).gap(10).overflow_y_scrollbar()
        .children(cards.map(({ agent, response, value, key }) => {
          const space = spaces().find(item => item.id === agent.space);
          const style = priorityStyle(worktreePriority(shared(PRIORITY_KEY), space), this.colors.dark);
          const activeMotion = mode === "none" ? null : this.unreadMotion.get(key);
          const motion = cardMotion(activeMotion?.mode, activeMotion?.phase);
          const text = response.state === "ready" ? response.headline : "";
          const target = tabNoteTarget(agent.address);
          const personalNote = noteText(shared(NOTES), target?.key);
          const label = issueLabel(agent.tab_name || agent.address || "Unread response");
          return renderUnreadCard({address:agent.address,label,text,note:personalNote,value,style,motion,
            colors:c,dark:this.colors.dark,
            noteButton:target?this.noteButton(target,{...c,accent:style.accent,hover:style.hover}):null,
            onOpen:(_event,cx)=>focusCompleted(agent.address,cx)});

        })));
  }

  noteButton(target, c) {
    return div().id(`note-edit-${target.tabId}`).size(26).flex_none().rounded(5).flex().items_center().justify_center()
      .text_color(c.accent ?? c.text).cursor_pointer().tooltip(noteText(shared(NOTES), target.key) ? "내 메모 편집" : "내 메모 추가")
      .hover(style => style.bg(c.hover)).on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => { cx.stop_propagation(); openTabNote(target); })
      .child(svg("mods/agent-control-center/note.svg").size(16));
  }

  saveNote(cx) {
    const target = props()?.target;
    const result = saveTabNote(shared(NOTES), target?.key,
      { ...target, text: this.noteEditor.value() }, this.noteVersion);
    if (!result.ok) {
      this.noteError = result.error === "conflict" ? "다른 창에서 메모가 변경됐습니다. 닫고 다시 열어 최신 메모를 확인하세요." :
        result.error === "too_long" ? `메모는 ${MAX_NOTE_LENGTH}자까지 저장할 수 있습니다.` : "메모를 저장하지 못했습니다.";
      cx.notify();
      return;
    }
    setShared(NOTES, result.notes);
    this.noteDiscardDraft = true;
    this.clearNoteDraft();
    closeOverlay(props()?.overlay);
  }

  noteEditorView() {
    const c = this.colors.context, target = props()?.target;
    return v_flex().size_full().p(18).gap(12).bg(c.bg)
      .child(div().text_size(17).font_semibold().text_color(c.text).truncate().tooltip(target?.title ?? "Tab").child(`내 메모 · ${issueLabel(target?.title ?? "Tab").title}`))
      .child(div().text_size(12).text_color(c.muted).child("⌘ Enter로 저장하고 닫습니다. 바깥을 누르면 작성 중인 내용을 임시 보관합니다."))
      .child(div().flex_1().min_h(0).p(10).rounded(8).border(1).border_color(c.border).bg(c.card)
        .child(Textarea.new(this.noteEditor).size_full().text_size(15).text_color(c.text)))
      .when(this.noteRestored, element => element.child(div().text_size(12).text_color(c.muted).child("작성 중이던 메모를 복원했습니다.")))
      .when(this.noteStaleDraft, element => element.child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(c.muted).child("저장된 메모가 변경됐습니다. 이전 작성 내용은 임시 보관되어 있습니다."))
        .child(this.button("note-restore-draft", "임시 내용 불러오기", (_event, cx) => {
          const draft = shared(NOTE_DRAFTS)?.[props()?.target?.key];
          if (typeof draft?.text === "string") this.noteEditor.set_value(draft.text);
          this.noteStaleDraft = false;
          this.noteRestored = true;
          cx.notify();
        }, false, c))))
      .when(Boolean(this.noteError), element => element.child(div().text_size(12).text_color(this.colors.failure).child(this.noteError)))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12).text_color(c.muted).child(`${[...this.noteEditor.value()].length} / ${MAX_NOTE_LENGTH}`))
        .child(this.button("note-cancel", "취소", () => { this.noteDiscardDraft = true; this.clearNoteDraft(); closeOverlay(props()?.overlay); }, false, c).text_size(13).px(12).py(7))
        .child(this.button("note-save", "저장 · ⌘ Enter", (_event, cx) => this.saveNote(cx), true, c).text_size(13).px(12).py(7)));
  }

  briefItems(brief, view) {
    const changes = brief.changes.map(item => ({ ...item,
      heading: item.kind === "test_failure" ? "기록된 실패 · 현재 작업 실패 판정 아님" : this.sourceCaption(item.source) }));
    const actions = brief.actions.map(item => ({ ...item, heading: item.kind === "review" ? "완료 리뷰" : "지금 할 일" }));
    const risks = brief.repoRisks.map(item => ({ ...item, heading: "저장소 확인" }));
    const decisions = brief.decisions.map(detail => ({ title: "설계 결정 · 보고", detail, source: "agent_report", heading: "설계 결정" }));
    if (view === "conflicts") return risks.slice(0, 6);
    if (view === "delta") return changes.filter(item => item.sinceReview === true).slice(0, 6);
    if (view === "review") return [...changes, ...actions.filter(item => item.kind === "review"), ...decisions, ...risks].slice(0, 6);
    const resumeActions = actions.filter(item =>
      item.kind !== "review" || item.detail !== brief.summary);
    return [...resumeActions.slice(0, 2), ...changes.slice(0, 2), ...decisions.slice(0, 1), ...risks.slice(0, 1)].slice(0, 6);
  }

  evidence(task, state, through, config, cx) {
    const c = this.colors.evidence;
    const events = unread(task, through);
    return v_flex().px(10).py(8).gap(7).rounded(7).bg(c.card).border(1).border_color(c.border)
      .child(div().text_size(10).text_color(c.muted).child(
        `${freshnessLabel(task) || "저장된 근거"} · 갱신 ${dateLabel(task?.updatedAt)} · 확인 경계 #${through}`))
      .child(this.button("evidence-diff", "Git diff", () => {
        focusTask(task); run("layout.show", { id: "panel" });
        run("layout.select", { stack: "panel-body", child: "changes" });
        closeOverlay(props()?.overlay);
      }, false, c))
      .child(TextView.markdown("acc-detail-evidence", detailMarkdown(task, state, "evidence", config, through))
        .selectable(true).text_size(11))
      .children(events.map(event => v_flex().id(`acc-proof-${event.id}`).gap(3)
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).text_size(11).text_color(c.text).truncate().child(event.summary))
          .when(eventSourceAvailable(task, event), element => element.child(this.button(`event-source-${event.id}`, "원문", () => openSource(task, event.id), false, c))))
        .child(div().text_size(10).text_color(c.muted).child(plain(event.evidence, "")))));
  }

  detail(cx) {
    const p = props() ?? {}, state = p.state ?? currentState();
    const task = p.task ?? currentState().tasks?.find(item => item.taskId === p.taskId);
    const through = Number(p.throughEventId) || 0, config = configOf(p.config ?? shared(CONFIG));
    const brief = contextBrief(task, state, { ...config, deltaOnly: p.view === "delta" }, through);
    const c = this.colors.evidence, teal = this.colors.context;
    const labels = { resume: "최근 응답과 근거", delta: "확인 이후 변화", conflicts: "저장소 영향", review: "완료 응답과 근거" };
    const items = this.briefItems(brief, p.view).slice(0, 5);
    const summary = p.view === "delta" ? items.length ?
      "앞선 확인 이후 Git·실행 로그에서 확인한 변화입니다." : task?.lastReviewedEventId > 0 ?
      "앞선 확인 이후의 확실한 새 변경 근거가 아직 없습니다." :
      "첫 확인입니다. 현재 관측과 기존 기록을 구분합니다." : brief.summary || brief.emptyReason ||
      "구체적인 변경 근거를 기다리고 있습니다.";
    return v_flex().size_full().p(14).gap(9).bg(c.bg)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).text_size(15).font_semibold().text_color(c.text).truncate()
          .child(`${labels[p.view] ?? "작업 맥락"} · ${brief.title || "보고 대기"}`))
        .child(this.button("detail-delta", "변화", () => openDetail("delta", task), false, c))
        .child(this.button("detail-radar", "저장소", () => openDetail("conflicts", task), false, c))
        .child(this.button("detail-close", "닫기", () => closeOverlay(p.overlay), false, c)))
      .child(v_flex().p(11).gap(5).rounded(8).bg(teal.bg).border(1).border_color(teal.border)
        .child(div().text_size(13).font_semibold().text_color(teal.text)
          .child(summary))
        .when(p.view !== "delta" && Boolean(brief.summarySource), element => element.child(div().text_size(10).text_color(teal.muted).child(brief.summarySource))))
      .child(v_flex().id("acc-detail-body").flex_1().min_h(0).gap(7).overflow_y_scrollbar()
        .children(items.map((item, index) => v_flex().id(`acc-brief-${index}`).px(11).py(8).gap(3)
          .rounded(7).bg(c.card).border(1).border_color(item.priority >= 80 ? this.colors.attention.border : c.border)
          .child(h_flex().gap(7).items_center()
            .child(div().text_size(10).text_color(c.muted).child(item.heading))
            .child(div().flex_1())
            .when(Boolean(item.source), element => element.child(div().text_size(9).text_color(c.muted).child(this.sourceCaption(item.source)))))
          .child(div().text_size(12).font_semibold().text_color(c.text).child(item.title))
          .when(Boolean(item.detail), element => element.child(div().text_size(11).text_color(c.text).child(item.detail)))))
        .when(!items.length && !brief.summary, element => element.child(div().text_size(12).text_color(c.muted).child(brief.emptyReason)))
        .when(this.showEvidence, element => element.child(this.evidence(task, state, through, config, cx))))
      .child(h_flex().gap(6).items_center()
        .child(this.button("detail-evidence", this.showEvidence ? "근거 접기" : "근거", (_event, cx) => { this.showEvidence = !this.showEvidence; cx.notify(); }, false, c))
        .when(Boolean(task?.sourceLog), element => element.child(this.button("detail-source-log", "원문", () => openSource(task), false, c)))
        .child(this.button("detail-source", "터미널", () => { focusTask(task); closeOverlay(p.overlay); }, false, c))
        .when(config.summaryConsent && ["codex", "claude"].includes(config.summaryProvider), element =>
          element.child(this.button("detail-ai-summary", "AI 요약", () => run("agent-control-center.summarize"), false, c)))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(c.muted).child(brief.currentReportBeyondBoundary || brief.currentEvidenceBeyondBoundary ?
          "새 요청은 이번 기록 확인에 포함되지 않습니다." : "열어도 확인 처리되지 않습니다."))
        .when(acknowledgmentAllowed(task, config, through), element => element.child(this.button("detail-ack", `기록 #${through}까지 확인`,
          () => { request({ type: "ack", taskId: task.taskId, throughEventId: through }); closeOverlay(p.overlay); }, true, c))));
  }

  clearNoteDraft() {
    const drafts = { ...(shared(NOTE_DRAFTS) ?? {}) };
    delete drafts[props()?.target?.key];
    setShared(NOTE_DRAFTS, drafts);
  }

  close() {
    if (props()?.role === "note-editor" && this.noteEditor && !this.noteDiscardDraft) {
      const key = props()?.target?.key;
      // Preserve a stale draft if the editor was only opened to read the latest note.
      if (!this.noteStaleDraft) {
        setShared(NOTE_DRAFTS, retainNoteDraft(shared(NOTE_DRAFTS), key, this.noteEditor.value(),
          this.noteVersion, noteText(shared(NOTES), key)));
      }
    }
    if (shared("acc.open-detail")?.id === props()?.overlay) setShared("acc.open-detail", null);
    if (shared("acc.response-history-open")?.id === props()?.overlay) setShared("acc.response-history-open", null);
  }

  history() {
    const c = this.colors.context, p = props() ?? {};
    const entries = this.responseHistory ?? [];
    return v_flex().size_full().p(18).gap(12).bg(c.bg)
      .child(h_flex().gap(10).items_center()
        .child(div().flex_1().min_w(0).text_size(17).font_semibold().text_color(c.text).truncate()
          .tooltip(p.title ?? "에이전트").child(`AI 정제 이력 · ${issueLabel(p.title ?? "에이전트").title}`))
        .child(div().id("acc-history-close").size(25).flex_none().rounded(6).flex().items_center().justify_center()
          .text_size(19).text_color(c.muted).tooltip("닫기").cursor_pointer().hover(style => style.bg(c.hover))
          .on_mouse_down("left", (_event, cx) => cx.stop_propagation()).on_click(() => closeOverlay(p.overlay)).child("×")))
      .child(div().text_size(11).text_color(c.muted).child("별도 AI가 정리한 응답 기록입니다. 대화 발췌 이력과 구분합니다."))
      .child(v_flex().id("acc-response-history-list").flex_1().min_h(0).gap(10).overflow_y_scrollbar()
        .when(this.historyLoading, element => element.child(div().py(18).text_size(13).text_color(c.muted).child("정제 이력을 읽고 있습니다.")))
        .when(Boolean(this.historyError), element => element.child(v_flex().py(18).gap(6)
          .child(div().text_size(14).font_semibold().text_color(c.text).child("정제 이력을 읽지 못했습니다."))
          .child(div().text_size(11).text_color(c.muted).child(this.historyError))))
        .when(!this.historyLoading && !this.historyError && !entries.length, element => element.child(v_flex().py(18).gap(6)
          .child(div().text_size(14).font_semibold().text_color(c.text).child("이 실행 세션에 저장된 AI 정제 이력이 없습니다."))
          .child(div().text_size(11).text_color(c.muted).child("과거 대화 원문을 정제 이력으로 대신 표시하지 않습니다."))))
        .children(entries.map(entry => h_flex().id(`acc-history-${entry.id}`).gap(10).items_stretch()
          .child(v_flex().w(12).items_center().pt(16)
            .child(div().size(6).flex_none().rounded_full().bg(entry.ready ? c.accent : c.border))
            .child(div().w(1).flex_1().mt(5).bg(c.border)))
          .child(v_flex().flex_1().min_w(0).px(13).py(12).gap(7).bg(c.card).rounded(10).border(1).border_color(c.border)
            .child(h_flex().gap(8).items_center()
              .child(div().text_size(10).font_semibold().text_color(c.muted).child(`응답 ${entry.turn}`))
              .child(div().flex_1())
              .child(div().text_size(10).text_color(c.muted).child(dateLabel(entry.at))))
            .child(div().text_size(15).font_semibold().text_color(c.text).whitespace_normal().child(entry.headline))
            .child(div().text_size(10).text_color(c.muted).truncate().child(
              `${entry.provider === "claude" ? "Claude" : entry.provider === "codex" ? "Codex" : "AI"}${entry.model ? ` · ${entry.model}` : ""} · ${entry.caption}${entry.ready ? " · 검증 전" : ""}`))
            .when(entry.state === "failed" && Boolean(entry.error), element => element.child(div().text_size(10).text_color(c.muted)
              .child(`정제 오류 · ${plain(entry.error)}`)))))))
      .child(div().text_size(10).text_color(c.muted).child("최대 30개 · 원본 대화와 에이전트 실행 상태는 변경하지 않습니다."));
  }

  source() {
    const c = this.colors.evidence, p = props() ?? {}, state = this.sourceState ?? {};
    return v_flex().size_full().p(12).gap(8).bg(c.bg)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(14).font_semibold().text_color(c.text).child(`원본 기록 · ${p.taskName ?? "작업"}`))
        .child(this.button("source-close", "닫기", () => closeOverlay(p.overlay), false, c)))
      .child(div().text_size(10).text_color(c.muted).truncate().tooltip(state.path ?? "").child(
        state.loading ? "읽는 중" : state.error ? state.error : `${state.path ?? ""} · 읽기 전용${state.truncated ? " · 일부 구간" : ""}`))
      .child(div().id("acc-source-editor").flex_1().min_h(0).child(
        this.sourceEditor ? Editor.new(this.sourceEditor).size_full() : div().text_color(c.muted).child("원본 기록이 없습니다.")))
      .child(div().text_size(10).text_color(c.muted).child("저장된 기록을 로컬에서 읽습니다."));
  }

  render(cx) {
    return stateReader.frame(() => this.renderContent(cx));
  }

  renderContent(cx) {
    this.colors = controlPalette(cx.theme().is_dark);
    const role = props()?.role ?? "detail";
    if (role === "header" || role === "engine") return this.header(cx);
    if (role === "boundary") return div().size_full().bg(this.colors.boundary);
    if (role === "context") return this.context(cx);
    if (role === "attention") return this.attention(cx);
    if (role === "note-editor") return this.noteEditorView();
    if (role === "history") return this.history();
    if (role === "source") return this.source();
    if (role === "terminal-label") return h_flex().size_full().px(10).items_center().bg(this.colors.toolbar.bg)
      .child(div().text_size(11).font_semibold().text_color(this.colors.toolbar.text).child("실행 중인 터미널"));
    return this.detail(cx);
  }
}
