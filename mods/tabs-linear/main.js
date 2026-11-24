import { issueLabel } from "./issue-label.js";
import { TabSelection } from "./tab-selection.js";
import { tabEntries, tabStarred, tabStarTier, matchesStarFilter } from "./tab-items.js";
import { CodexAutoName } from "./codex-auto-name.js";
import { InlineRename } from "./inline-rename.js";
import { leadPanes, tabTitle } from "./task-label.js";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Popup } from "gpui-base";
import { spaces, panes, agents, focused, exec, appHome, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand } from "herdr";

// The shown tab's Sketch pane, if it has one.
function sketchPane() {
  const tab = spaces().find(s => s.active)?.tabs?.find(c => c.active);
  return panes().find(p => p.mod === "Sketch" && p.tab === tab?.id);
}

// Closes the shown tab's Sketch, or opens one beside the focused pane, told
// the space's folder so it shows that worktree's board.
function toggleSketch() {
  const open = sketchPane();
  if (open) { run("pane.close", { pane: open.pane }); return; }
  const space = spaces().find(s => s.active);
  run("pane.split", { direction: "right", mod: "Sketch", props: { folder: space?.folder ?? null, machine: space?.machine ?? null } });
}


function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.tabsSelection = new TabSelection("tabs-linear");
    this.rename = new InlineRename(cx);
    this.autoName = new CodexAutoName();
    this.history = [];
    this.visits = [];
    this.visitCursor = -1;
    this.pendingVisit = null;
    this.switcher = null;
    this.handle = cx.focus_handle();
    this.rememberTab();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.linearOpen = JSON.parse(localStorage.getItem("linear-panel-open") ?? "null");
    // "tabs-linear.linear" (a key): open or close the Linear panel.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command.startsWith("tabs:")) {this.tabsSelection.command(command.slice(5), cx);continue;}
        if (command === "star") {
          const tab = spaces().find(s => s.active)?.tabs?.find(c => c.active);
          const entry = tab && tabEntries(spaces(), panes(), agents()).find(entry => entry.tab.id === tab.id);
          if (entry) this.tabsSelection.toggle(entry);
          continue;
        }
        if (command === "sketch") { toggleSketch(); continue; }
        if (command === "history-back" || command === "history-forward") {
          this.cycleTab(command === "history-back" ? 1 : -1, cx, "visits");
          continue;
        }
        if (command === "previous" || command === "previous-reverse") {
          this.cycleTab(command === "previous" ? 1 : -1, cx);
          continue;
        }
        if (command !== "linear") continue;
        const panel = find(layout(), "panel"), body = find(layout(), "panel-body");
        if (panel && !panel.hidden && body?.active === "linear") run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "linear" }); run("layout.show", { id: "panel" }); }
      }
    });
  }

  cycleTab(direction, cx, mode = "recent") {
    const nativeModifiers = typeof globalThis.window?.modifiers === "function";
    const beginning = !this.switcher || (mode === "visits" && this.switcher.mode !== "visits");
    if (beginning) {
      this.rememberTab();
      const ids = mode === "visits" ? [...this.visits].reverse() : [...this.history];
      const index = mode === "visits" ? ids.length - 1 - this.visitCursor : 0;
      if (ids.length < 2 || (mode === "visits" && (index + direction < 0 || index + direction >= ids.length))) return;
      const focus = this.switcher?.focus ?? focused();
      this.switcher = { ids, index, focus, mode };
      this.handle.focus();
      // Commands arrive asynchronously: a quick tap can release Control before
      // this view receives focus. Read only the modifier flag, never typed keys.
      if (!nativeModifiers && window().platform === "macos") {
        const session = this.switcher;
        cx.spawn(async (cx) => {
          try {
            const result = await exec("/usr/bin/python3", [`${appHome()}/mods/tabs-linear/control-release.py`]);
            if (this.switcher === session && result.code === 0) {
              if (result.stdout.trim() === "released") this.finishSwitch(true, cx);
              else if (result.stdout.trim() === "timeout") this.finishSwitch(false, cx);
            }
          } catch (_) { /* Native modifier/key-up handlers still handle release. */ }
        });
      }

    }
    const s = this.switcher;
    s.index = s.mode === "visits"
      ? Math.max(0, Math.min(s.ids.length - 1, s.index + direction))
      : (s.index + direction + s.ids.length) % s.ids.length;
    // Both keyboard Control and a held trackpad gesture live in the GPUI
    // window. A quick tap may already be released before this command arrives.
    if (nativeModifiers && !globalThis.window.modifiers().control) this.finishSwitch(true, cx);
    else cx.notify();
    // Focus can return to a pane before the release reaches this copy. Watch
    // the same effective modifier used by keys and touches, only while this
    // chooser is open. A check never redraws; committing/cancelling does once.
    if (beginning && nativeModifiers && this.switcher === s) {
      cx.spawn(async (cx) => {
        while (this.switcher === s) {
          await cx.sleep(20);
          if (this.switcher !== s) return;
          if (!globalThis.window.is_window_active()) { this.finishSwitch(false, cx); return; }
          if (!globalThis.window.modifiers().control) { this.finishSwitch(true, cx); return; }
        }
      });
    }
  }

  finishSwitch(commit, cx) {
    const s = this.switcher;
    if (!s) return;
    this.switcher = null;
    const id = s.ids[s.index];
    if (commit && spaces().some(p => p.tabs.some(t => t.id === id))) {
      if (s.mode === "visits") {
        const from = spaces().find(p => p.active)?.tabs.find(t => t.active)?.id;
        // run() is queued. Ignore the old selection until the destination is
        // observed, so a render before command delivery cannot append it again.
        this.pendingVisit = { from, id };
        this.visits = [...s.ids].reverse();
        this.visitCursor = s.ids.length - 1 - s.index;
      }
      run("tab.select", { id });
    } else if (s.focus?.pane) {
      run("pane.focus", { pane: s.focus.pane });
    } else if (s.focus?.terminal) {
      run("pane.focus", { terminal: s.focus.terminal });
    }
    cx.notify();
  }

  rememberTab() {
    const all = spaces();
    const live = new Set(all.flatMap(s => s.tabs.map(t => t.id)));
    this.history = this.history.filter(id => live.has(id));
    const current = all.find(s => s.active)?.tabs.find(t => t.active)?.id;
    if (current && this.history[0] !== current) {
      this.history = [current, ...this.history.filter(id => id !== current)];
    }
    // Unlike MRU order, visits keep a cursor and retain the forward branch.
    // A direct selection replaces that branch, just like browser navigation.
    this.visits ??= [];
    this.visitCursor ??= -1;
    if (this.pendingVisit) {
      if (current === this.pendingVisit.from && current !== this.pendingVisit.id) return;
      this.pendingVisit = null;
    }
    let cursor = -1;
    this.visits = this.visits.filter((id, index) => {
      const keep = live.has(id);
      if (keep && index <= this.visitCursor) cursor++;
      return keep;
    });
    this.visitCursor = cursor;
    if (current && this.visits[cursor] !== current) {
      this.visits = this.visits.slice(0, cursor + 1);
      this.visits.push(current);
      // Bound both the history and the chooser snapshot in long-lived windows.
      if (this.visits.length > 256) this.visits.splice(0, this.visits.length - 256);
      this.visitCursor = this.visits.length - 1;
    }
  }

  // Linear belongs to the whole workspace. Only Files and Changes follow a space.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    // Unread is workspace-wide and stays open across spaces, including when empty.
    if (now === "acc-attention") { this.space = space.id; this.pending = null; return; }
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!first || this.linearOpen !== null || space.id in this.panels) {
        const stored = this.panels[space.id] ?? null;
        // On upgrade, keep the currently visible Linear panel. Ignore stale
        // per-space Linear entries once a global preference has been recorded.
        const linear = this.linearOpen ?? now === "linear";
        const want = linear ? "linear" : stored !== "linear" && enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    const linear = now === "linear";
    if (this.linearOpen !== linear) {
      this.linearOpen = linear;
      localStorage.setItem("linear-panel-open", JSON.stringify(linear));
    }
    // Opening Linear must not erase this space's Files/Changes preference.
    if (linear) return;
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render(cx) {
    this.autoName.sync(cx);
    this.rememberTab();
    const t = theme();
    const allSpaces = spaces();
    this.tabsSelection.sync(allSpaces);
    const allPanes = panes();
    const entries = new Map(tabEntries(allSpaces, allPanes, agents()).map(entry => [entry.tab.id, entry]));
    const agentStars = shared("agents.starred") ?? {}, tabStars = shared("tabs.starred") ?? {};
    const space = allSpaces.find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const visibleTabIds = shown.map(tab => tab.id);
    const item = (c, i) => {
      const entry = entries.get(c.id), pane = entry?.lead, program = pane?.program, agent = entry?.a;
      const starred = entry && tabStarred(entry, agentStars, tabStars);
      const name = entry?.name ?? c.name;
      // Keep natural widths until the row fills, then shrink titles to fit.
      return h_flex().id(`tab-${c.id}`).relative().h(29).px(10).gap(7).rounded(7).items_center().min_w(0).flex_shrink(1).overflow_hidden().text_size(12.8)
        .tooltip(c.zoomed ? `${name} Z` : name)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .when(this.tabsSelection.dragging && this.tabsSelection.over === c.id, el => el.child(div().id(`tab-drop-${c.id}`).absolute().top(0).bottom(0).w(2).bg(t.accent)
          .when(this.tabsSelection.after, el => el.right(0)).when(!this.tabsSelection.after, el => el.left(0))))
        .when(this.tabsSelection.ids.has(c.id), el => el.bg(t.selected).border_color(t.accent))
        .when(this.tabsSelection.dragging && this.tabsSelection.dragIds.includes(c.id), el => el.opacity(0.5))
        .on_mouse_down("left", (e, cx) => {
          if (e.click_count === 2 && !e.modifiers?.platform && !e.modifiers?.shift) {cx.stop_propagation();this.tabsSelection.cancel();this.rename.begin(c.id, name, cx);}
          else if (this.rename.id !== c.id) this.tabsSelection.down(c.id, e, visibleTabIds, cx);
        })
        .on_mouse_move((e, cx) => this.tabsSelection.hover(c.id, e, "x", cx))
        .on_mouse_up("left", (e, cx) => {if(this.rename.id!==c.id)this.tabsSelection.up(c.id, e, "x", cx);})
        .on_mouse_down("right", (_e, cx) => {cx.stop_propagation();this.tabsSelection.menu(c.id, cx, () => openOverlay({mod:"menu",kind:"popup",width:200,props:{tab:"tab",target:{id:c.id,space:space.id}}}));})
        .when(Boolean(entry), el => el.child(div().id(`tab-star-${c.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
          .text_color(starred ? (shared("tabs.blueStarred")?.[entry.tab.id] === true ? t.ansi4 : t.ansi3) : t.dim).cursor_pointer()
          .tooltip(starred ? "즐겨찾기 해제 (⌘⇧S) · 우클릭: 파란별/노란별 전환" : "즐겨찾기에 추가 (⌘⇧S) · 우클릭: 파란별")
          .hover(el => el.bg(t.hover).text_color(starred ? (shared("tabs.blueStarred")?.[entry.tab.id] === true ? t.ansi4 : t.ansi3) : t.foreground))
          .on_mouse_down("right", (_e, cx) => {cx.stop_propagation();this.tabsSelection.cancel();this.tabsSelection.toggleBlue(entry);})
          .on_mouse_up("right", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.tabsSelection.cancel(); })
          .on_mouse_up("left", (_e,cx) => {if(this.tabsSelection.pressed===null)cx.stop_propagation();})
          .on_click((_e, cx) => {
            cx.stop_propagation();
            this.tabsSelection.toggle(entry);
          })
          .child(svg(`mods/spaces-agents/${starred ? "star-filled" : "star"}.svg`).size(14))))
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).flex_none().text_color(t.muted) : image(program.icon).size(14).flex_none()))
        .when(Boolean(agent && shared("agents.fast-mode")?.[agent.address]), el => el.child(div().flex_none().text_size(12).font_weight(700).text_color("#a78bfa").mr(-4).tooltip("Fast mode").child("F")))
        .child(this.rename.id === c.id ? this.rename.render(t).w(170).min_w(0).flex_shrink(1) : div().min_w(0).max_w(170).flex_shrink(1).truncate().tooltip(name).child(c.zoomed ? `${issueLabel(name).title} Z` : issueLabel(name).title))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).flex_none().rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).flex_none().text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "linear"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (id === "acc-attention") {
            setShared("acc.unread-dock.enabled", !on);
            if (!on) run("layout.show", { id: "acc-attention" });
          }
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    // Sketch is a split pane, not a side panel: opens one beside the focused
    // pane of this tab, or closes the one already there.
    const tab = shown.find(c => c.active);
    const sketch = panes().find(p => p.mod === "Sketch" && p.tab === tab?.id);
    const sketchButton = () => h_flex().id("pane-sketch").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(sketch ? t.selected : t.chrome).text_color(sketch ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => {
        toggleSketch();
      }).child(svg("mods/Sketch/sketch.svg").size(14)).child("Sketch");
    const bar = h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_move((e,cx) => this.tabsSelection.outside(e,cx))
      .on_mouse_up("left", (_e,cx) => {this.tabsSelection.cancel();cx.notify();})
      .on_hover((hovered,cx) => {if(!hovered){this.tabsSelection.cancel();cx.notify();}})
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).children(shown.map(item))
        .child(div().id("tab-drop-end").relative().h_full().flex_1().min_w(8)
          .on_mouse_move((e,cx) => this.tabsSelection.hoverEnd(space?.id,e,cx))
          .on_mouse_up("left", (e,cx) => this.tabsSelection.upEnd(space?.id,e,cx))
          .when(this.tabsSelection.dragging && this.tabsSelection.over===`end:${space?.id}`, el => el.child(div().absolute().left(0).top(6).bottom(6).w(2).bg(t.accent)))))
      .when(this.tabsSelection.ids.size > 1, el => el.child(h_flex().id("tab-selection-actions").h(26).px(7).gap(6).flex_none().items_center().rounded(6).bg(t.selected).text_size(11).text_color(t.accent)
        .on_mouse_down("left", stop).on_click(() => this.tabsSelection.open()).cursor_pointer()
        .child(div().child(`${this.tabsSelection.ids.size}개 탭 ▾`))
        .child(div().id("tab-selection-clear").px(3).tooltip("탭 선택 해제").on_mouse_down("left", stop)
          .on_click((_e, cx) => {cx.stop_propagation();this.tabsSelection.clear();cx.notify();}).child("×"))))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu-linear", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(panelButton("linear", "Linear", "mods/linear-issues/linear.svg"))
      .child(sketchButton())
      .when(Boolean(find(root, "acc-attention")), el => el.child(panelButton("acc-attention", "Unread", "mods/agent-control-center/inbox.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-linear/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-linear/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-linear/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
    return this.keyboard(h_flex().size_full().min_w(0))
      .child(Popup.new("recent-tabs-popup", bar).size_full().anchor("top_left")
        .when(Boolean(this.switcher), el => el.content(this.renderSwitcher(t))));
  }

  keyboard(root) {
    return root.track_focus(this.handle)
      .on_modifiers_changed((e, cx) => {
        if (!e.modifiers.control) this.finishSwitch(true, cx);
      })
      .on_key_up((e, cx) => {
        if (!e.modifiers.control) this.finishSwitch(true, cx);
      })
      .on_key_down((e, cx) => {
        if (!this.switcher) return;
        if (e.key === "escape") { cx.stop_propagation(); this.finishSwitch(false, cx); }
        else if (e.key === "enter") { cx.stop_propagation(); this.finishSwitch(true, cx); }
        else if (e.key === "swipeleft" || e.key === "swiperight") {
          cx.stop_propagation();
          this.cycleTab(e.key === "swipeleft" ? 1 : -1, cx, "visits");
        }
        else if (e.key === "tab") {
          cx.stop_propagation();
          this.cycleTab(e.modifiers.shift ? -1 : 1, cx);
        }
      });
  }

  renderSwitcher(t) {
    const s = this.switcher;
    const tabs = new Map(spaces().flatMap(space => space.tabs.map(tab => [tab.id, { tab, space }])));
    const leads = leadPanes(panes());
    const start = Math.max(0, Math.min(s.index - 3, s.ids.length - 8));
    return v_flex().id("tab-switcher").w(440).p(6).gap(3)
      .bg(t.popover).border(1).border_color(t.border).rounded(9).shadow_lg()
      .child(h_flex().px(8).h(26).items_center().justify_between()
        .child(div().text_size(11).text_color(t.muted).child(s.mode === "visits" ? "탭 방문 기록" : "최근 사용한 탭"))
        .child(div().text_size(11).text_color(t.dim).child(`${s.index + 1} / ${s.ids.length}`)))
      .children(s.ids.slice(start, start + 8).map((id, offset) => {
        const entry = tabs.get(id);
        const title = entry ? tabTitle(entry.tab, leads.get(id), entry.space.name) : "닫힌 탭";
        const selected = start + offset === s.index;
        return h_flex().id(`recent-${start + offset}-${id}`).w_full().min_w(0).h(48).px(10).gap(10).items_center().rounded(6)
          .border(1).border_color(selected ? t.accent : t.border)
          .bg(selected ? t.selected : t.surface).text_color(selected ? t.foreground : t.muted)
          .text_size(12).tooltip(`${entry?.space.name ?? ""} · ${title}`)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { s.index = start + offset; this.finishSwitch(true, cx); })
          .child(div().w(16).flex_none().text_color(t.accent).child(selected ? "›" : ""))
          .child(v_flex().flex_1().min_w(0).gap(3)
            .child(div().truncate().text_color(selected ? t.foreground : t.muted).child(issueLabel(title).title))
            .child(div().truncate().text_size(10).text_color(t.dim).tooltip(entry?.space.name ?? "").child(issueLabel(entry?.space.name ?? "").title)));
      }))
      .child(div().px(8).py(6).text_size(10).text_color(t.dim).child(s.mode === "visits" ? "이전/다음 제스처 · 손가락 놓아 선택 · Esc 취소" : "Tab 다음 · ⇧Tab 이전 · Control 놓아 선택 · Esc 취소"));
  }
}
