import { HOVER_CARD_LEASE, hoverAnchorKey, hoverContextToken, releaseHoverLease, dismissHoverOverlay } from "./hover-card-lifecycle.js";
import { resumeControl } from "./resume-control.js";
import { readMainDiff } from "./main-diff.js";
import { HoverCards, renderHoverCard } from "./hover-card.js";
import { hoverCardData, insideHover } from "./hover-card-data.js";
import { markUnread, manualUnread, unreadStatus, clearManualUnread } from "./manual-unread.js";
import { issueLabel } from "./issue-label.js";
import { PRIORITY_KEY, worktreePriority, cycleWorktreePriority, priorityStyle } from "./worktree-priority.js";
import { TabSelection } from "./tab-selection.js";
import { tabEntries, tabStarred, tabStarTier, matchesStarFilter, activeTabContext } from "./tab-items.js";
import { pickSelection, selectionMembers, selectionDropPlan, selectionEndTarget, selectionBacklogChange, orderMoves } from "./selection.js";
import { BranchStatusCache } from "./branch-status.js";
import { FastModeTracker, FAST_MODE_KEY } from "./fast-mode.js";
import { BACKLOG_KEY, backlogState, backlogPartition, backlogSubtree, backlogChange, backlogUndo } from "./backlog.js";
import { InlineRename } from "./inline-rename.js";
import { nestSpaces, filterSpaceAncestors, dropZone } from "./hierarchy.js";
// Spaces and their agents in one list (a clone of the shipped "spaces" mod,
// with the "agents" list folded in). Each space row (stable colored avatar,
// worktrees under their checkout, grouped by machine, Git counts
// ahead/behind after the name) is followed by its agents: icon, name, time in
// the current state, status. Click a space to switch, an agent to go to it;
// right-click a space for its menu, drag to nest or reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, notify, readTextFile, writeTextFile, appHome, run, openOverlay, exec, hc, theme, shared, setShared, setAgentOrder, watchFolder, window, layout, nextCommand, props, closeOverlay, focused } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail, or back to the width it had (the agents list's » button did this).
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// ---- agents (from the shipped "agents" mod)

import { leadPanes, tabTitle } from "./task-label.js";
export { leadPanes, tabTitle } from "./task-label.js";

export function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function programIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.role === "hover-card") {
      this.hoverCardEntered=false;
      this.hoverCardWatch=cx.timer.every(200,()=>{
        const p=props();
        try {
          const native=globalThis.window,point=native.mouse_position();
          if(shared(HOVER_CARD_LEASE)?.id!==p.overlay || !p.guard ||
             p.guard.token!==this.hoverContext(p.guard.spaceId,p.guard.tabId) || !native.is_window_active() ||
             (!insideHover(point,p.anchor)&&!insideHover(point,p.box))) this.closeHoverCard();
        } catch { this.closeHoverCard(); }
      });
      return;
    }
    this.hoverCards = new HoverCards();
    this.hoverAnchors = new Map();
    this.tabsSelection = new TabSelection("spaces-agents");
    this.unreadPending = new Set();
    this.visibleTabIds = [];
    this.issuePumpBusy = false;
    const pumpIssues = (cx) => {
      if (this.issuePumpBusy) return;
      const active = Object.values(shared("issueMoves") ?? {}).some(s => !["complete", "restored", "cancelled"].includes(s.phase));
      if (!active && Date.now() - (this.lastIssuePump ?? 0) < 30000) return;
      this.lastIssuePump = Date.now();
      this.issuePumpBusy = true;
      cx.spawn(async (cx) => {
        try {
          const r = await exec("python3", [`${appHome()}/mods/agent-issue/move.py`, "pump"], { timeout: 60000 });
          if (r.code !== 0) throw new Error(r.stderr?.trim() || "이동 상태 확인 실패");
          const moves = JSON.parse(r.stdout);
          const previous = shared("issueMoves") ?? {};
          setShared("issueMoves", Object.fromEntries(moves.map(s => [s.id, s])));
          for (const s of moves) {
            if (s.phase === "complete" && previous[s.id] && previous[s.id]?.phase !== "complete")
              notify({ title: `${s.issue.identifier} 워크트리로 이동했습니다`, body: s.name, level: "success", action: { name: "pane.focus", args: { terminal: s.new_terminal } } });
            else if (s.error && s.error !== previous[s.id]?.error)
              notify({ title: "이슈 워크트리 이동이 멈췄습니다", body: s.error, level: "warning" });
          }
        } catch (error) {
          if (String(error) !== this.issuePumpError) {
            this.issuePumpError = String(error);
            notify({ title: "이슈 이동 상태를 확인하지 못했습니다", body: String(error), level: "warning" });
          }
        } finally { this.issuePumpBusy = false; cx.notify(); }
      });
    };
    pumpIssues(cx);
    cx.timer.every(3000, pumpIssues);
    this.rename = new InlineRename(cx);
    this.fastMode = new FastModeTracker(cx);
    this.spaceRename = new InlineRename(cx, "space");
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.hoverCards.dismiss();this.hoverAnchors.clear();
        if (command === "favorites-only") {
          setShared("agents.favoritesOnly", shared("agents.favoritesOnly") !== true);
          continue;
        }
        if (command.startsWith("tabs:")) { this.tabsSelection.command(command.slice(5), cx); continue; }
        if (command.startsWith("selection:")) {
          this.selectionCommand(command.slice("selection:".length), cx);
          continue;
        }
        if (command.startsWith("backlog:")) {
          this.backlogCommand(command.slice("backlog:".length), cx);
          continue;
        }
        if (command !== "rename" && !command.startsWith("rename:")) continue;
        const id = command === "rename" ? spaces().find(s => s.active)?.id : command.slice("rename:".length);
        const space = spaces().find(s => s.id === id);
        if (!space) continue;
        if (narrow()) toggleSidebar();
        if (this.folded.delete(space.machine ?? null)) {
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        }
        if (this.backlogIds?.has(space.id)) {
          const state = backlogState(shared(BACKLOG_KEY));
          setShared(BACKLOG_KEY, { ...state, expanded: true });
        }
        this.spaceRename.begin(space.id, space.name, cx);
      }
    });
    this.hierarchy = {};
    this.savingHierarchy = false;
    cx.spawn(async (cx) => {
      const dir = `${appHome()}/data/space-hierarchy`;
      for (;;) {
        try {
          const data = JSON.parse(await readTextFile(`${dir}/parents.json`) ?? "{}");
          this.hierarchy = data?.parents && typeof data.parents === "object" && !Array.isArray(data.parents) ? data.parents : {};
        } catch { this.hierarchy = {}; }
        cx.notify();
        try { await watchFolder(dir); } catch { break; }
      }
    });
    this.branchStatuses = new BranchStatusCache();
    cx.timer.every(5000, cx => this.refreshBranchStatuses(cx));
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.selectedIds = new Set();
    this.selectionAnchor = null;
    this.selectionContext = activeTabContext(spaces());
    this.visibleSpaceIds = [];
    this.dragIds = [];
    this.dragMembers = new Set();
    this.pointerMoved = false;
    this.machineDrag = null;
    this.machineDragged = false;
    try {
      const saved = JSON.parse(localStorage.getItem("machines.order") ?? "[]");
      this.machineOrder = Array.isArray(saved) ? saved.filter(m => m === null || typeof m === "string") : [];
    } catch { this.machineOrder = []; }
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedSpaces = new Set(JSON.parse(localStorage.getItem("spaces.folded") ?? "[]"));
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    cx.timer.every(30000, (cx) => cx.notify());
    // The shipped agents list kept these too: take its older times for agents
    // still in the same state, so "idle 3h" doesn't restart at "<1m".
    cx.spawn(async (cx) => {
      try {
        const old = JSON.parse(JSON.parse(await readTextFile(`${appHome()}/data/agents/store.json`) ?? "{}").changed ?? "{}");
        let dirty = false;
        for (const [k, c] of Object.entries(old)) {
          const mine = this.changed[k];
          if (!mine || (mine.s === c.s && c.at < mine.at)) { this.changed[k] = c; dirty = true; }
        }
        if (dirty) { localStorage.setItem("changed", JSON.stringify(this.changed)); cx.notify(); }
      } catch {}
    });
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  refreshBranchStatuses(cx) {
    const ps = panes();
    const targets = new Map();
    for (const s of spaces()) {
      if (this.folded.has(s.machine ?? null)) continue;
      const cwd = place(s, ps), g = this.git[where(s, ps)];
      if (g && cwd) targets.set(this.branchStatuses.key(cwd, s.machine, g), { cwd, on: s.machine, g });
    }
    cx.spawn(async cx => { await this.branchStatuses.refresh([...targets.values()], exec, () => cx.notify()); });
  }

  hoverContext(spaceId,tabId) {
    const native=globalThis.window;
    return hoverContextToken({spaceId,tabId,allSpaces:spaces(),focus:focused(),layout:layout(),
      filters:[shared("agents.favoritesOnly"),shared("agents.favoritesTier"),shared(BACKLOG_KEY)?.expanded],
      viewport:native.viewport_size(),bounds:native.bounds()});
  }

  closeHoverCard() {
    if(this.hoverCardClosing)return;
    this.hoverCardClosing=true;
    this.hoverCardWatch?.cancel();
    dismissHoverOverlay(props()?.overlay);
  }

  cardHover(element, name, tabId, machine, fallbackName = '', spaceId = null, trackFold = false) {
    const key=hoverAnchorKey(machine,spaceId,tabId);
    const titleData=hoverCardData(name,tabId,machine,this.tabNotes,fallbackName);
    return element.on_hover((hovered,cx)=>{
      if(trackFold && (hovered || this.hoverRow===spaceId)) {
        const next=hovered?spaceId:null;
        if(this.hoverRow!==next){this.hoverRow=next;cx.notify();}
      }
      if (!hovered) {this.hoverCards.leave(key,cx);return;}
      const allSpaces=spaces(), ps=panes();
      const space=allSpaces.find(s=>spaceId?s.id===spaceId:tabId?s.tabs?.some(tab=>tab.id===tabId):s.machine===machine&&s.name===fallbackName);
      const entry=tabId?tabEntries(allSpaces,ps,agents()).find(e=>e.tab.id===tabId):null;
      const agent=entry?.a, terminal=this.terminalByAddress?.get(agent?.address);
      const git=space?this.git[where(space,ps)]:null;
      const pull=space?this.branchStatuses.get(git?.cwd,space.machine,git):null;
      const move=Object.values(shared("issueMoves")??{}).find(m=>agent&&(m.terminal===agent.address||m.new_terminal===agent.address)&&!["complete","restored","cancelled"].includes(m.phase));
      const data={...titleData,details:{
        starTier:entry?tabStarTier(entry,shared("agents.starred"),shared("tabs.starred"),shared("tabs.blueStarred")):null,
        priority:worktreePriority(shared(PRIORITY_KEY),space),
        status:agent?(manualUnread(terminal)&&["idle","done"].includes(agent.status)?"done":entry?.tab.status||unreadStatus(agent.status,terminal)):space?.status,
        elapsed:agent&&this.changed[agent.address]?.at?duration(Date.now()-this.changed[agent.address].at):null,
        program:agent?.program?.name||entry?.lead?.program?.name,
        fast:agent&&shared(FAST_MODE_KEY)?.[agent.address]===true,
        pull:pull||{state:"unknown",label:"브랜치 상태 확인 중"},git,
        counts:space?this.agentCounts?.get(space.id):null,
        machine:space?.machine||null,directory:git?.cwd||space?.folder,
        archived:space&&this.backlogIds?.has(space.id),move
      }};
      const guard={spaceId,tabId,token:this.hoverContext(spaceId,tabId)};
      if(!guard.token)return;
      this.hoverCards.enter(key,data,()=>this.hoverAnchors.get(key),cx,
        ()=>this.hoverContext(spaceId,tabId)===guard.token,guard);
    });
  }

  close() {
    if(props()?.role==="hover-card") {
      this.hoverCardWatch?.cancel();releaseHoverLease(props()?.overlay);
    } else {this.hoverCards?.dismiss();this.hoverAnchors?.clear();}
  }

  singleTabStar(entry, t) {
    const starred=tabStarred(entry,this.agentStars,this.tabStars);
    const color=starred?(shared("tabs.blueStarred")?.[entry.tab.id]===true?t.ansi4:t.ansi3):t.dim;
    const stop=(_event,cx)=>cx.stop_propagation();
    return div().id(`single-tab-star-${entry.tab.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(color)
      .tooltip(starred?"즐겨찾기 해제 · 우클릭: 파란별/노란별 전환":"즐겨찾기에 추가 · 우클릭: 파란별")
      .hover(el=>el.bg(t.hover))
      .on_mouse_down("left",(_event,cx)=>{cx.stop_propagation();this.tabsSelection.cancel();this.pressed=null;this.over=null;this.hoverCards.dismiss();})
      .on_mouse_up("left",stop)
      .on_click((_event,cx)=>{cx.stop_propagation();this.tabsSelection.toggle(entry);})
      .on_mouse_down("right",(_event,cx)=>{cx.stop_propagation();this.tabsSelection.cancel();this.pressed=null;this.over=null;this.hoverCards.dismiss();this.tabsSelection.toggleBlue(entry);})
      .on_mouse_up("right",stop)
      .child(svg(`mods/spaces-agents/${starred?"star-filled":"star"}.svg`).size(14));
  }

  priorityButton(space, t) {
    const level = worktreePriority(shared(PRIORITY_KEY), space);
    const style = priorityStyle(level, this.priorityDark !== false);
    return div().id(`worktree-priority-${space.id}`).size(20).flex_none().rounded(4)
      .flex().items_center().justify_center().text_color(style.accent).cursor_pointer()
      .tooltip(`우선순위: ${style.label} · 클릭하면 낮음 → 보통 → 높음으로 변경`)
      .hover(element => element.bg(t.hover))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_event, cx) => cx.stop_propagation())
      .on_click((_event, cx) => {
        cx.stop_propagation();
        setShared(PRIORITY_KEY, cycleWorktreePriority(shared(PRIORITY_KEY), space));
        cx.notify();
      })
      .child(svg(`mods/spaces-agents/${style.icon}`).size(15));
  }

  branchIcon(w, g, t) {
    const state = this.branchStatuses.get(g?.cwd, w.machine, g);
    const kind = state?.state ?? "unknown";
    const color = ({ review: t.ansi4, draft: t.muted, merged: "#9333ea", deployed: t.ansi2, closed: t.ansi1 })[kind] ?? t.dim;
    return div().size(18).flex_none().relative()
      .tooltip(state?.label ?? "브랜치 상태 확인 중")
      .child(svg(`mods/spaces-agents/status-${kind}.svg`).size(18).text_color(color))
      .when(state?.failed > 0, el => el.child(div().absolute().right(-2).bottom(-2).size(8).rounded(4).bg(t.ansi1).text_color(t.canvas).text_size(7).line_height(8).child("×")));
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, cwd, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.oid ")) info.oid = line.slice(13);
        else if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      try { info.mainDiff=await readMainDiff(exec,cwd,on); }
      catch { info.mainDiff={state:"unknown",reason:"main 대비 변경 조회 실패"}; }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at
  // a finished agent turns done into idle, which isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Remember discovery separately from stars so manually unstarred agents stay
  // unstarred across reconnects and reloads. The first snapshot preserves the
  // person's existing choices; subsequent discoveries default to starred.
  starNewAgents(list) {
    const known = shared("agents.autoStarKnown");
    const stars = shared("agents.starred") ?? {};
    if (known == null) {
      setShared("agents.autoStarKnown", Object.fromEntries(
        [...Object.keys(stars), ...list.map(a => a.address)].map(address => [address, true])));
      return;
    }
    const added = list.filter(a => !Object.prototype.hasOwnProperty.call(known, a.address));
    if (!added.length) return;
    const nextKnown = { ...known };
    const nextStars = { ...stars };
    for (const a of added) {
      nextKnown[a.address] = true;
      nextStars[a.address] = true;
    }
    setShared("agents.autoStarKnown", nextKnown);
    setShared("agents.starred", nextStars);
  }

  // One row for every Tab, including terminal-only and mod-only tabs.
  tabsBySpace() {
    const list = agents();
    this.starNewAgents(list);
    this.track(list, Date.now());
    const allSpaces = spaces();
    this.tabsSelection.sync(allSpaces);
    const entries = tabEntries(allSpaces, panes(), list);
    const by = new Map(), favoritesOnly = shared("agents.favoritesOnly") === true;
    this.agentStars = shared("agents.starred") ?? {};
    this.tabStars = shared("tabs.starred") ?? {};
    this.tabNotes = shared("acc.tab-notes") ?? {};
    for (const entry of entries) {
      if (!matchesStarFilter(tabStarTier(entry,this.agentStars,this.tabStars,shared("tabs.blueStarred")??{}),favoritesOnly,shared("agents.favoritesTier"))) continue;
      if (!by.has(entry.space.id)) by.set(entry.space.id, []);
      by.get(entry.space.id).push(entry);
    }
    this.hasFilteredTabs = by.size > 0;
    return by;
  }

  beginTabPress(entry, event, cx) {
    this.hoverCards.dismiss();
    this.syncActiveSelection(spaces());
    this.setSelection([], null);
    this.worktreeDragged = false;
    this.tabsSelection.down(entry.tab.id, event, this.visibleTabIds, cx);
  }

  tabRowMove(entry, event, cx) {
    if(event.bounds)this.hoverAnchors.set(hoverAnchorKey(entry.space.machine,entry.space.id,entry.tab.id),{...event.bounds});
    if (this.pressed !== null) {
      this.recordSpaceDrag(event, cx);
      this.hoverDrop(entry.space.id, "after", cx);
    } else this.tabsSelection.hover(entry.tab.id, event, "y", cx);
  }

  tabRowUp(entry, event, cx) {
    if (this.pressed !== null) this.finishDrop(entry.space.id, "after", cx);
    else this.tabsSelection.up(entry.tab.id, event, "y", cx);
  }

  tabSelectionStyle(el, entry, t) {
    return el.when(this.tabsSelection.ids.has(entry.tab.id), el => el.bg(t.selected).border(1).border_color(t.accent))
      .when(this.tabsSelection.pressed !== null && this.tabsSelection.dragging && this.tabsSelection.dragIds.includes(entry.tab.id), el => el.opacity(0.5))
      .when(this.tabsSelection.dragging && this.tabsSelection.over === entry.tab.id, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
        .when(this.tabsSelection.after, el => el.bottom(0)).when(!this.tabsSelection.after, el => el.top(0))));
  }

  ordinaryTabRow(entry, depth, t) {
    const {tab, space, lead, name} = entry, starred = tabStarred(entry, this.agentStars, this.tabStars);
    const pic = programIcon(lead?.program, 14, t.foreground);
    return h_flex().id(`terminal-tab-${tab.id}`).relative().h(26).flex_none().pl(depth ? 52 + (depth - 1) * 18 : 35).pr(8).gap(8)
      .items_center().rounded(7).text_size(12.5).cursor_pointer().text_color(t.foreground)
      .when(tab.active && space.active, el => el.bg(t.raised)).hover(el => el.bg(t.hover))
      .when(true, el => this.tabSelectionStyle(el, entry, t))
      .when(true, el => this.cardHover(el,name,tab.id,space.machine,space.name,space.id))
      .on_mouse_down("left", (e, cx) => {
        if (e.click_count === 2 && !e.modifiers?.platform && !e.modifiers?.shift) {
          cx.stop_propagation();this.tabsSelection.cancel();this.rename.begin(tab.id, name, cx);return;
        }
        this.beginTabPress(entry, e, cx);
      })
      .on_mouse_move((e, cx) => this.tabRowMove(entry, e, cx))
      .on_mouse_up("left", (e, cx) => this.tabRowUp(entry, e, cx))
      .on_mouse_down("right", (_e, cx) => {cx.stop_propagation();this.tabsSelection.menu(tab.id, cx, () => openOverlay({
        mod: "menu-linear", kind: "popup", width: 230, props: {tab: "tab", target: {id: tab.id, space: space.id}}}));})
      .child(div().id(`terminal-tab-star-${tab.id}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(starred ? (shared("tabs.blueStarred")?.[entry.tab.id] === true ? t.ansi4 : t.ansi3) : t.dim).cursor_pointer().tooltip(starred ? "즐겨찾기 해제 · 우클릭: 파란별/노란별 전환" : "즐겨찾기에 추가 · 우클릭: 파란별")
        .on_mouse_down("right", (_e, cx) => {cx.stop_propagation();this.tabsSelection.cancel();this.tabsSelection.toggleBlue(entry);})
        .on_mouse_up("right", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("left", (_e, cx) => {cx.stop_propagation();this.tabsSelection.cancel();})
        .on_mouse_up("left", (_e, cx) => {if(this.tabsSelection.pressed===null)cx.stop_propagation();})
        .on_click((_e, cx) => {cx.stop_propagation();this.tabsSelection.toggle(entry);})
        .child(svg(`mods/spaces-agents/${starred ? "star-filled" : "star"}.svg`).size(14)))
      .child(pic ?? div().w(14).flex_none().text_size(12).text_color(t.dim).child(lead?.mod ? "▣" : "›_"))
      .child(this.rename.id === tab.id ? this.rename.render(t).flex_1() : div().flex_1().min_w(0).truncate().child(issueLabel(name).title));
  }

  status(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (st === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (st === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
  }

  // Explicit unread acts on the response incarnation, without opening its tab.
  agentStatus(t, a, turn) {
    const status = unreadStatus(a.status, this.terminalByAddress?.get(a.address));
    if (status !== "idle" || !(turn > 0)) return this.status(t, status);
    return div().id(`agent-unread-${a.address}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
      .cursor_pointer().tooltip("Mark as unread")
      .hover(el => el.bg(t.hover))
      .on_mouse_down("left", (_event, cx) => {
        cx.stop_propagation();
        this.tabsSelection.cancel();
        this.unreadPress = a.address;
      })
      .on_mouse_up("left", (_event, cx) => {
        cx.stop_propagation();
        if (this.unreadPress !== a.address) return;
        this.unreadPress = null;
        if (this.unreadPending.has(a.address)) return;
        const current = terminals().find(item => item.address === a.address);
        if (!current || !(current.turn > 0)) return;
        this.unreadPending.add(a.address);
        cx.spawn(async cx => {
          try { await markUnread(current, hc); }
          catch (error) { notify({ title: "미확인 표시를 저장하지 못했습니다", body: String(error), level: "error" }); }
          finally { this.unreadPending.delete(a.address); cx.notify(); }
        });
      })
      .child(this.status(t, a.status));
  }

  // One Tab represented by its lead agent, under its Space.
  agentRow(entry, depth, t, now, turn) {
    const { a: originalAgent, name, tab, space } = entry;
    const terminal = this.terminalByAddress?.get(originalAgent.address);
    const pinnedUnread = ["idle", "done"].includes(originalAgent.status) && manualUnread(terminal);
    const a = { ...originalAgent, status: unreadStatus(originalAgent.status, terminal) };
    const move = Object.values(shared("issueMoves") ?? {}).find(s => s.terminal === a.address || s.new_terminal === a.address);
    const moving = move && !["complete", "restored", "cancelled"].includes(move.phase);
    const pic = programIcon(a.program, 14, t.foreground);
    const starred = tabStarred(entry, this.agentStars, this.tabStars);
    const idle = a.status === "idle" && !(tab.active && space.active);
    const when = this.changed[a.address]?.at;
    const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
    return h_flex().id(`ag-${a.address}`).relative().h(26).flex_none().pl(depth ? 52 + (depth - 1) * 18 : 35).pr(8).gap(8).items_center().rounded(7)
      .text_size(12.5).cursor_pointer()
      .when(tab.active && space.active, (el) => el.bg(t.raised))
      .when(true, el => this.tabSelectionStyle(el, entry, t))
      .hover((s) => s.bg(t.hover))
      .when(true, el => this.cardHover(el,name,tab.id,space.machine,space.name,space.id))
      .on_mouse_down("left", (e, cx) => {
        if (e.click_count === 2 && !e.modifiers?.platform && !e.modifiers?.shift) {
          cx.stop_propagation();this.tabsSelection.cancel();this.rename.begin(a.tab, name, cx);return;
        }
        this.beginTabPress(entry, e, cx);
      })
      .on_mouse_move((e, cx) => this.tabRowMove(entry, e, cx))
      .on_mouse_up("left", (e, cx) => {
        if (pinnedUnread && this.tabsSelection.pressed === tab.id && !this.tabsSelection.dragging && this.tabsSelection.navigate) {
          cx.spawn(async () => {
            try { await clearManualUnread(terminal, hc); }
            catch (error) { notify({ title: "읽음 표시를 저장하지 못했습니다", body: String(error), level: "error" }); }
          });
        }
        this.tabRowUp(entry, e, cx);
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();this.tabsSelection.menu(tab.id, cx, () => openOverlay({ mod: "menu-linear", kind: "popup", width: 390, height: 180,
          props: { tab: "agent", target: { id: a.tab, space: a.space, terminal: a.address, name } } }));
      })
      .child(div().id(`agent-star-${a.address}`).size(18).flex_none().flex().items_center().justify_center().rounded(4)
        .text_color(starred ? (shared("tabs.blueStarred")?.[entry.tab.id] === true ? t.ansi4 : t.ansi3) : t.dim).cursor_pointer()
        .tooltip(starred ? "즐겨찾기 해제 · 우클릭: 파란별/노란별 전환" : "즐겨찾기에 추가 · 우클릭: 파란별")
        .hover(el => el.bg(t.hover).text_color(starred ? (shared("tabs.blueStarred")?.[entry.tab.id] === true ? t.ansi4 : t.ansi3) : t.foreground))
        .on_mouse_down("right", (_e, cx) => {cx.stop_propagation();this.tabsSelection.cancel();this.tabsSelection.toggleBlue(entry);})
        .on_mouse_up("right", (_e, cx) => cx.stop_propagation())
        .on_mouse_down("left", (_e, cx) => {cx.stop_propagation();this.tabsSelection.cancel();})
        .on_mouse_up("left", (_e, cx) => {if(this.tabsSelection.pressed===null)cx.stop_propagation();})
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.tabsSelection.toggle(entry);
        })
        .child(svg(`mods/spaces-agents/${starred ? "star-filled" : "star"}.svg`).size(14)))
      .when(Boolean(pic), (el) => el.child(pic))
      .when(shared(FAST_MODE_KEY)?.[a.address] === true, el => el.child(div().flex_none().text_size(12).font_weight(700).text_color("#a78bfa").mr(-4).tooltip("Fast mode").child("F")))
      .child(this.rename.id === a.tab ? this.rename.render(t).flex_1() : div().flex_1().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(issueLabel(name).title))
      .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machine)))
      .when(Boolean(when) && a.status !== "blocked", (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
      .when(Boolean(moving), el => el.child(div().text_size(10).text_color(move.error ? t.blocked : t.accent).tooltip(move.error || "우클릭 메뉴에서 이동 상태를 확인하세요").child(move.error ? "이동 중단" : move.phase === "choice" ? "변경 선택" : "이동 중")))
      .child(pinnedUnread ? this.status(t, "done") : tab.status && tab.status !== a.status ? this.status(t, tab.status) : this.agentStatus(t, a, turn));
  }

  syncActiveSelection(allSpaces) {
    const active = activeTabContext(allSpaces);
    if (this.selectionContext !== undefined && this.selectionContext !== active) {
      this.setSelection([], null);
      this.pressed = null; this.over = null; this.pressStart = null;
      this.dragIds = []; this.dragMembers = new Set();
      this.pointerMoved = false; this.dropZone = null; this.dropAtEnd = false;
      this.worktreeDragged = false;
    }
    this.selectionContext = active;
    this.tabsSelection.sync(allSpaces);
  }

  setSelection(ids, anchor = this.selectionAnchor) {
    this.selectedIds = new Set(ids);
    this.selectionAnchor = anchor;
  }

  beginSpacePress(w, event, cx) {
    this.hoverCards.dismiss();
    cx.stop_propagation();
    this.syncActiveSelection(spaces());
    if (this.tabsSelection?.ids.size) this.tabsSelection.clear();
    const modifier = event.modifiers ?? {};
    const toggle = modifier.platform || (window()?.platform !== "macos" && modifier.control);
    const range = modifier.shift;
    this.pressNavigate = !toggle && !range;
    if (toggle || range || !this.selectedIds.has(w.id)) {
      const picked = pickSelection({ ids: [...this.selectedIds], anchor: this.selectionAnchor },
        w.id, this.visibleSpaceIds, { toggle, range });
      this.setSelection(picked.ids, picked.anchor);
    }
    this.pointerMoved = false;
    this.pressStart = event.position;
    this.dragIds = this.visibleSpaceIds.filter(id => this.selectedIds.has(id));
    this.dragMembers = selectionMembers(this.backlogRows ?? [], this.dragIds);
    this.pressed = this.selectedIds.has(w.id) ? w.id : null;
    this.over = this.pressed;
    this.dropZone = null;
    this.dropAtEnd = false;
    this.worktreeDragged = false;
    cx.notify();
  }

  recordSpaceDrag(event, cx) {
    if (this.pressed === null || this.pointerMoved || !this.pressStart) return;
    if (Math.hypot(event.position.x - this.pressStart.x, event.position.y - this.pressStart.y) < 4) return;
    this.pointerMoved = true;
    cx.notify();
  }

  selectionMenu() {
    openOverlay({ mod: "worktree-selection", kind: "popup", width: 282, height: 190,
      props: { ids: [...this.selectedIds] } });
  }

  selectionCommand(command, cx) {
    const split = command.indexOf(":");
    if (split < 0) return;
    const action = command.slice(0, split);
    let ids;
    try { ids = JSON.parse(command.slice(split + 1)); } catch { return; }
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string")) return;
    const current = new Set(spaces().map(space => space.id));
    ids = [...new Set(ids)].filter(id => current.has(id));
    if (!ids.length) return;
    if (action === "close") {
      // Reached only after the popup's explicit session-ending confirmation.
      for (const id of ids) run("space.close", { id, confirmed: true });
      this.setSelection([...this.selectedIds].filter(id => !ids.includes(id)));
      cx.notify();
    } else if (action === "archive" || action === "restore") {
      const state = backlogState(shared(BACKLOG_KEY));
      const change = selectionBacklogChange(this.ordered(), state.entries, ids, action === "archive");
      if (!change) return;
      this.applyBacklogChange(state, change, action === "archive", cx);
    } else if (/^color-ansi[1-6]$/.test(action)) {
      const colors = { ...(shared("space.colors") ?? {}) };
      for (const id of ids) colors[id] = action.slice("color-".length);
      setShared("space.colors", colors);
    }
  }

  menu(w, cx) {
    if (!this.selectedIds.has(w.id)) this.setSelection([w.id], w.id);
    cx.notify();
    if (this.selectedIds.size > 1) { this.selectionMenu(); return; }
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu-linear", kind: "popup", width: 264, height: 320, props: { tab: "space", target: { id: w.id, backlog: this.backlogIds?.has(w.id) === true, descendants: backlogSubtree(this.backlogRows ?? [], w.id).length - 1 } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const out = nestSpaces(list, this.hierarchy);
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const all = this.ordered();
    // Children precede their parents during accumulation, including nested worktrees.
    for (let index = all.length - 1; index >= 0; index--) {
      const row = all[index];
      if (!row.parentId) continue;
      const child = this.agentCounts.get(row.w.id);
      if (!child) continue;
      const parent = this.agentCounts.get(row.parentId) ?? { total: 0, working: 0 };
      parent.total += child.total;
      parent.working += child.working;
      this.agentCounts.set(row.parentId, parent);
    }
    const partition = backlogPartition(all, backlogState(shared(BACKLOG_KEY)).entries);
    this.backlogRows = all;
    this.spaceChildren = new Map();
    for(const row of all) if(row.parentId) this.spaceChildren.set(row.parentId, (this.spaceChildren.get(row.parentId) ?? 0) + 1);
    this.backlogIds = new Set([...partition.flags].filter(([, archived]) => archived).map(([id]) => id));
    this.archivedRows = partition.archived;
    let rows = partition.active.filter(r => this.shown.has(r.w.id));
    const by = this.tabsBySpace();
    const favoritesOnly = shared("agents.favoritesOnly") === true;
    if (favoritesOnly) rows = filterSpaceAncestors(rows, r => !r.contextOnly && by.has(r.w.id));
    const now = Date.now();
    // terminals() copies every core record: share one lookup across all rows.
    this.terminalByAddress = new Map(collapsed ? [] : terminals().map(item => [item.address, item]));
    const turnByAddress = new Map([...this.terminalByAddress].map(([address, terminal]) => [address, terminal.turn]));
    const order = [];
    const drawRow = (r) => {
      if (collapsed) return [this.compact(r, t)];
      if (!r.contextOnly) this.visibleSpaceIds.push(r.w.id);
      const tabs = r.contextOnly ? [] : by.get(r.w.id) ?? [];
      const singleTab = tabs.length === 1 && !this.spaceChildren.has(r.w.id) ? tabs[0] : null;
      const mine = singleTab ? tabs : this.foldedSpaces.has(r.w.id) ? [] : tabs;
      for (const x of mine) {this.visibleTabIds.push(x.tab.id);if(x.a)order.push(x.a.address);}
      return [this.row({ ...r, singleTab, singleTurn: singleTab?.a ? turnByAddress.get(singleTab.a.address) : null }, t),
        ...(singleTab ? [] : mine.map((x) => x.a ? this.agentRow(x, r.depth, t, now, turnByAddress.get(x.a.address)) : this.ordinaryTabRow(x, r.depth, t)))];
    };
    // Keep each worktree and all its descendants in one visual drop target.
    const draw = (list) => {
      if (collapsed) return list.map(r => this.compact(r, t));
      const roots = [], stack = [];
      for (const r of list) {
        while (stack.length && stack.at(-1).r.depth >= r.depth) stack.pop();
        const node = { r, children: [] };
        (stack.length ? stack.at(-1).children : roots).push(node);
        stack.push(node);
      }
      // Native elements are single-use: finish children before attaching them.
      const drawTree = ({ r, children }) => {
        const dropping = !this.dropAtEnd && this.pressed !== null && this.over === r.w.id && this.pressed !== r.w.id;
        const ownRows = drawRow({ ...r, foldable: this.spaceChildren.has(r.w.id) || (by.get(r.w.id)?.length ?? 0) > 1 });
        const descendants = this.foldedSpaces.has(r.w.id) ? [] : children.map(drawTree);
        return v_flex().id(`worktree-group-${r.w.id}`).relative().flex_none()
          .child(v_flex().id(`worktree-body-${r.w.id}`).flex_none()
            .on_mouse_move((e, cx) => { this.recordSpaceDrag(e, cx); if (!r.contextOnly) this.hoverDrop(r.w.id, "after", cx); })
            .on_mouse_up("left", (_e, cx) => { if (!r.contextOnly) this.finishDrop(r.w.id, "after", cx); })
            .children(ownRows))
          .children(descendants)
          .when(dropping, el => el.child(
            div().id(`worktree-drop-${r.w.id}`).absolute()
              .when(this.dropZone === "inside", box => box.inset_0().rounded(8).border(1).border_color(t.accent))
              .when(this.dropZone !== "inside", line => line.left(0).right(0).h(2).bg(t.accent)
                .when(this.dropZone === "after", line => line.bottom(0))
                .when(this.dropZone === "before", line => line.top(0)))));
      };
      return roots.map(drawTree);
    };
    this.agentOrder = order;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : draw(rows);
    const available = [null, ...remote];
    const machineNames = [...new Set([...this.machineOrder.filter(m => available.includes(m)), ...available])];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      if (favoritesOnly && !mine.length) return [];
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const drag = this.machineDrag;
      const target = drag && this.machineDragged && drag.over === m && drag.from !== m;
      const head = h_flex().relative().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip("Drag to reorder machines · Click to fold")
        .when(drag && this.machineDragged && drag.from === m, el => el.opacity(0.5))
        .when(target, el => el.child(div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(machineNames.indexOf(drag.from) < machineNames.indexOf(m), line => line.bottom(0))
          .when(machineNames.indexOf(drag.from) > machineNames.indexOf(m), line => line.top(0))))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = null;
          this.over = null;
          this.machineDrag = { from: m, over: m, start: e.position };
          this.machineDragged = false;
        })
        .on_mouse_move((e, cx) => {
          const d = this.machineDrag;
          if (!d) return;
          const moved = Math.hypot(e.position.x - d.start.x, e.position.y - d.start.y) >= 4;
          if (d.over !== m || (!this.machineDragged && moved)) {
            d.over = m;
            this.machineDragged = true;
            cx.notify();
          }
        })
        .on_mouse_up("left", (_e, cx) => {
          const d = this.machineDrag;
          this.machineDrag = null;
          if (d && this.machineDragged && d.from !== m && d.over === m) {
            const order = machineNames.filter(name => name !== d.from);
            const at = order.indexOf(m) + (machineNames.indexOf(d.from) < machineNames.indexOf(m) ? 1 : 0);
            order.splice(at, 0, d.from);
            this.machineOrder = order;
            localStorage.setItem("machines.order", JSON.stringify(order));
          }
          cx.notify();
        })
        .on_click((_e, cx) => {
          if (this.machineDragged) return;
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => {
              cx.stop_propagation();
              if (m === "windows") {
                openOverlay({ mod: "worktree-codex", kind: "dialog", width: 460, height: 360,
                  props: { machine: m, folder: "~/basecamp", action: "new" } });
              } else run("space.new", { machine: m ?? "" });
            }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? draw(mine) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Keep Git counts compact so the space name gets the available width.
  gitTail(g, tree, name, t) {
    const repo = tree || g.name.toLowerCase() === name.toLowerCase() ? "" : g.name;
    return h_flex()
      .flex_none()
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(repo), (el) => el.child(div().max_w(72).truncate().child(repo)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  planDrop(parents, from, over, zone, list) {
    if (!list) {
      const ps = panes();
      list = spaces().map(w => ({ w, g: this.git[where(w, ps)] ?? null }));
    }
    return selectionDropPlan(list, parents, from, over, zone, this.backlogIds);
  }

  hoverDrop(over, zone, cx, atEnd = false) {
    if (this.pressed === null) return;
    cx.stop_propagation();
    if (!this.pointerMoved) return;
    const allowed = over && this.planDrop(this.hierarchy, this.dragIds, over, zone);
    const target = allowed ? over : null;
    if (this.over !== target || this.dropZone !== zone || this.dropAtEnd !== atEnd) {
      this.over = target;
      this.dropZone = zone;
      this.dropAtEnd = atEnd;
      cx.notify();
    }
  }

  finishDrop(over, zone, cx) {
    this.syncActiveSelection(spaces());
    if (this.pressed === null) return;
    const ids = [...this.dragIds], moved = this.pointerMoved;
    cx.stop_propagation();
    this.pressed = null;
    this.over = null;
    this.dropAtEnd = false;
    if (moved && over && this.planDrop(this.hierarchy, ids, over, zone)) {
      this.worktreeDragged = true;
      cx.spawn(async cx => this.saveDrop(ids, over, zone, cx));
    }
    cx.notify();
  }

  endTarget() {
    return selectionEndTarget(this.backlogRows ?? [], this.dragIds, this.backlogIds);
  }

  async saveDrop(from, over, zone, cx) {
    if (this.savingHierarchy) return;
    this.savingHierarchy = true;
    try {
      const path = `${appHome()}/data/space-hierarchy/parents.json`;
      const expected = await readTextFile(path);
      const data = expected === null ? { version: 1, parents: {} } : JSON.parse(expected);
      if (!data || typeof data !== "object" || Array.isArray(data)
          || !data.parents || typeof data.parents !== "object" || Array.isArray(data.parents)) {
        throw new Error("Invalid hierarchy data; the existing file was preserved.");
      }
      const ps = panes(), list = spaces().map(w => ({ w, g: this.git[where(w, ps)] ?? null }));
      const plan = this.planDrop(data.parents, from, over, zone, list);
      if (!plan) throw new Error("선택한 워크트리나 이동 대상이 바뀌어 이동을 중단했습니다.");
      const moves = orderMoves(list.map(row => row.w.id), plan.order);
      await writeTextFile(path, JSON.stringify({ ...data, parents: plan.parents }, null, 2) + "\n", expected);
      this.hierarchy = plan.parents;
      for (const args of moves) run("space.move", args);
    } catch (error) {
      notify({ title: "워크트리를 이동하지 못했습니다", body: String(error), level: "error" });
    } finally {
      this.savingHierarchy = false;
      cx.notify();
    }
  }

  toggleSpaceFold(id, cx) {
    this.hoverCards.dismiss();this.hoverAnchors.clear();
    this.foldedSpaces.has(id) ? this.foldedSpaces.delete(id) : this.foldedSpaces.add(id);
    localStorage.setItem("spaces.folded", JSON.stringify([...this.foldedSpaces]));
    cx.notify();
  }

  row({ w, i, g, tree, depth = tree ? 1 : 0, archived = false, contextOnly = false, foldable = false, singleTab = null, singleTurn = null }, t) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    if (contextOnly) return h_flex().id(`space-context-${w.id}`).h(rowHeight({ tree })).flex_none()
      .pl(tree ? 30 + (depth - 1) * 18 : 8).pr(8).gap(9).items_center().text_size(12.5).text_color(t.muted)
      .tooltip(`${w.name} · 이 목록에서는 상위 작업 공간의 위치만 표시합니다`)
      .child(tree ? this.branchIcon(w, g, t)
        : h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().child(issueLabel(w.name).title));
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.selectedIds.has(w.id), el => el.bg(t.selected).border(1).border_color(t.accent))
      .when(this.pressed !== null && this.pointerMoved && this.dragMembers.has(w.id), el => el.opacity(0.5))
      .when(true, el => this.cardHover(el,singleTab?.name ?? w.name,singleTab?.tab.id,w.machine,w.name,w.id,true))
      .on_mouse_down("left", (e, cx) => {
        if (this.savingHierarchy) return;
        if (e.click_count === 2 && !e.modifiers?.platform && !e.modifiers?.shift) {
          cx.stop_propagation();
          this.pressed = null;
          this.over = null;
          this.setSelection([w.id], w.id);
          this.spaceRename.begin(w.id, w.name, cx);
          return;
        }
        this.beginSpacePress(w, e, cx);
      })
      .on_mouse_move((e, cx) => {
        if(e.bounds)this.hoverAnchors.set(hoverAnchorKey(w.machine,w.id,singleTab?.tab.id),{...e.bounds});
        this.recordSpaceDrag(e, cx);
        if (!archived) this.hoverDrop(w.id, dropZone(e), cx);
      })
      .on_mouse_up("left", (e, cx) => {
        this.syncActiveSelection(spaces());
        if (this.pressed === null) return;
        const click = this.pressed === w.id && !this.pointerMoved;
        if (click && this.pressNavigate) this.setSelection([w.id], w.id);
        const navigate = click && this.pressNavigate;
        this.finishDrop(archived ? null : w.id, dropZone(e), cx);
        if (navigate) {
          if (singleTab) {
            const terminal = this.terminalByAddress?.get(singleTab.a?.address);
            if (manualUnread(terminal)) cx.spawn(async () => {
              try { await clearManualUnread(terminal, hc); }
              catch (error) { notify({ title: "읽음 표시를 저장하지 못했습니다", body: String(error), level: "error" }); }
            });
            run("tab.select", { id: singleTab.tab.id });
          }
          else if (foldable) this.toggleSpaceFold(w.id, cx);
          else run("space.select", { id: w.id });
        }
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(w, cx); })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(!tree && foldable, el => el.pl(18))
          .when(Boolean(tree), el => el.pl(22 + (depth - 1) * 18).child(h_flex().gap(3).items_center().flex_none().child(this.priorityButton(w, t)).child(this.branchIcon(w, g, t))))
          .when(!tree, el => el.child(this.priorityButton(w, t)).child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .when(Boolean(singleTab), el => el.child(this.singleTabStar(singleTab,t)))
          .when(Boolean(singleTab), el => el.child(programIcon(singleTab.a?.program ?? singleTab.lead?.program, 14, t.foreground)
            ?? div().w(14).flex_none().text_size(12).text_color(t.dim).child(singleTab.lead?.mod ? "▣" : "›_")))
          .child(this.spaceRename.id === w.id ? this.spaceRename.render(t).flex_1() : div().flex_1().min_w(0).truncate().text_color(t.foreground).child(issueLabel(w.name).title))
          .child(div().id(`space-agent-count-${w.id}`).flex_none().h(18).px(5).rounded(5)
            .bg(t.raised).border(1).border_color(t.border).text_size(10.5)
            .text_color(this.agentCounts?.get(w.id)?.working ? t.working : t.dim)
            .tooltip(`하위 워크트리 포함 · 수행 중 ${this.agentCounts?.get(w.id)?.working ?? 0}개 / 전체 에이전트 ${this.agentCounts?.get(w.id)?.total ?? 0}개`)
            .child(`${this.agentCounts?.get(w.id)?.working ?? 0}/${this.agentCounts?.get(w.id)?.total ?? 0}`))
          .when(archived && w.status === "blocked", el => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child("응답 필요")))
          .when(archived && Boolean(w.machine), el => el.child(div().max_w(60).truncate().text_size(10).text_color(t.dim).child(w.machine)))
          .when(Boolean(singleTab?.a), el => el.child(this.agentStatus(t, singleTab.a, singleTurn)))
          .child(g && !archived ? this.gitTail(g, tree, w.name, t) : div().flex_none()),
      )
      .when(foldable && this.hoverRow===w.id, el => el.child(div().id(`space-fold-${w.id}`).absolute().left(tree?4+(depth-1)*18:2).top((rowHeight({tree})-16)/2).size(16).rounded(4).cursor_pointer()
        .tooltip(this.foldedSpaces.has(w.id)?"워크트리 펼치기":"워크트리 접기")
        .hover(el=>el.bg(t.hover))
        .on_mouse_down("left",(_event,cx)=>cx.stop_propagation())
        .on_mouse_up("left",(_event,cx)=>cx.stop_propagation())
        .on_click((_event,cx)=>{cx.stop_propagation();this.hoverCards.dismiss();this.toggleSpaceFold(w.id,cx);})
        .child(svg(`mods/workspace-chrome/chevron-${this.foldedSpaces.has(w.id)?"right":"down"}.svg`).size(12).text_color(t.dim))));
  }

  compact({ w, i, g, tree, contextOnly = false }, t) {
    if (contextOnly) return div().id(`space-context-${w.id}`).h(26).flex_none()
      .text_size(11).text_color(t.dim).tooltip(`${w.name} · 상위 그룹`).child("·");
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(this.priorityButton(w, t))
      .child(tree ? this.branchIcon(w, g, t) : div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  backlogCommand(command, cx) {
    const state = backlogState(shared(BACKLOG_KEY));
    if (command === "toggle") {
      const expand = narrow() || !state.expanded;
      if (narrow()) toggleSidebar();
      setShared(BACKLOG_KEY, { ...state, expanded: expand });
      return;
    }
    if (command === "undo") {
      if (!this.backlogUndo) return;
      setShared(BACKLOG_KEY, { ...state, entries: backlogUndo(state.entries, this.backlogUndo) });
      this.backlogUndo = null;
      cx.notify();
      return;
    }
    const match = /^(archive|restore):(.+)$/.exec(command);
    if (!match) return;
    const archived = match[1] === "archive";
    const change = backlogChange(this.ordered(), state.entries, match[2], archived);
    if (!change) return;
    this.applyBacklogChange(state, change, archived, cx);
  }

  applyBacklogChange(state, change, archived, cx) {
    setShared(BACKLOG_KEY, { ...state, entries: change.entries });
    const undo = { ...change, archived };
    this.backlogUndo = undo;
    cx.timer.after(12000, cx => {
      if (this.backlogUndo === undo) { this.backlogUndo = null; cx.notify(); }
    });
    cx.notify();
  }

  backlogBanner(t, collapsed) {
    const current = spaces().find(s => s.active && this.backlogIds?.has(s.id));
    if (!current) return null;
    if (collapsed) return div().id("backlog-current-compact").h(26).flex_none().text_size(11).text_color(t.accent)
      .tooltip("Backlog에 보관 중 · 클릭해서 작업 목록으로 복귀")
      .on_click((_e, cx) => this.backlogCommand(`restore:${current.id}`, cx)).child("↥");
    return v_flex().id("backlog-current").mx(8).mb(6).p(9).gap(6).flex_none().rounded(7)
      .border(1).border_color(t.border).bg(t.raised)
      .child(div().text_size(11).text_color(t.muted).child("Backlog에 보관 중"))
      .child(h_flex().id("backlog-restore-current").h(26).px(8).items_center().justify_center().rounded(5)
        .text_size(12).text_color(t.accent).bg(t.selected).cursor_pointer().hover(el => el.bg(t.hover))
        .on_click((_e, cx) => this.backlogCommand(`restore:${current.id}`, cx)).child("작업 목록으로 복귀"));
  }

  backlogSection(t, collapsed) {
    const rows = this.archivedRows ?? [];
    if (!rows.length) return null;
    const state = backlogState(shared(BACKLOG_KEY));
    const ids = this.backlogIds;
    const blocked = new Set(agents().filter(a => ids.has(a.space) && a.status === "blocked").map(a => a.space)).size;
    const title = `Backlog (${ids.size})`;
    return v_flex().id("backlog-section").flex_none().max_h(300).min_h(0).mx(8).mb(6).pt(5).border_t(1).border_color(t.border)
      .child(h_flex().id("backlog-toggle").h(32).flex_none().px(collapsed ? 0 : 8).gap(6).items_center().rounded(6)
        .text_size(12).text_color(t.muted).cursor_pointer().hover(el => el.bg(t.hover).text_color(t.foreground))
        .tooltip(`${title}${blocked ? ` · 응답 필요 ${blocked}` : ""} · 실행 중인 세션은 유지됩니다`)
        .on_click((_e, cx) => this.backlogCommand("toggle", cx))
        .child(svg(`mods/workspace-chrome/chevron-${state.expanded && !collapsed ? "down" : "right"}.svg`).size(11).flex_none())
        .child(div().flex_1().truncate().child(collapsed ? String(ids.size) : title))
        .when(blocked > 0, el => el.child(div().flex_none().text_size(10.5).text_color(t.blocked).child(collapsed ? "●" : `응답 필요 ${blocked}`))))
      .when(state.expanded && !collapsed, el => el.child(v_flex().id("backlog-list").h(Math.min(240, rows.reduce((height, r) => height + rowHeight(r), 0))).min_h(0).overflow_y_scrollbar()
        .children(rows.map(r => this.row({ ...r, archived: true }, t)))));
  }

  render(cx) {
    if (props()?.role === "hover-card") return renderHoverCard(props().data,cx.theme().is_dark,props().box,{
      hover:(hovered)=>{if(hovered)this.hoverCardEntered=true;else if(this.hoverCardEntered)this.closeHoverCard();},
      outside:()=>this.closeHoverCard(),
    });
    this.priorityDark = cx.theme().is_dark;
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    this.syncActiveSelection(sp);
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.agentCounts = new Map();
    for (const agent of agents()) {
      const count = this.agentCounts.get(agent.space) ?? { total: 0, working: 0 };
      count.total += 1;
      if (agent.status === "working") count.working += 1;
      this.agentCounts.set(agent.space, count);
    }
    this.visibleSpaceIds = [];
    this.visibleTabIds = [];
    const rows = this.grouped(t, collapsed);
    if (!collapsed && backlogState(shared(BACKLOG_KEY)).expanded) {
      this.visibleSpaceIds.push(...(this.archivedRows ?? []).filter(row => !row.contextOnly).map(row => row.w.id));
    }
    const visible = new Set(this.visibleSpaceIds);
    this.setSelection([...this.selectedIds].filter(id => visible.has(id)),
      visible.has(this.selectionAnchor) ? this.selectionAnchor : null);
    const recovery = Object.values(shared("issueMoves") ?? {}).filter(s => !["complete", "restored", "cancelled"].includes(s.phase));
    rows.unshift(...recovery.map(s => div().id(`issue-recovery-${s.id}`).h(30).px(8).flex_none().rounded(6)
      .text_size(11).text_color(s.error ? t.blocked : t.accent).hover(el => el.bg(t.hover)).cursor_pointer()
      .tooltip(s.error || s.name).on_click(() => openOverlay({ mod: "agent-issue", kind: "dialog", width: 620, height: 570, props: { operation: s.id } }))
      .child(collapsed ? "↗" : `${s.error ? "이동 중단" : s.phase === "choice" ? "변경 선택" : "이슈 이동"} · ${s.name}`)));
    // Prefer displayed agents for navigation; the app appends other agents.
    if (!collapsed) setAgentOrder(this.agentOrder);
    const favoritesOnly = shared("agents.favoritesOnly") === true;
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(12.5)
      .id("spaces-agents-root")
      .on_scroll_wheel(()=>{this.hoverCards.dismiss();this.hoverAnchors.clear();})
      .on_size_change(()=>{this.hoverCards.dismiss();this.hoverAnchors.clear();})
      .on_hover((hovered, cx) => {
        if (!hovered) { this.hoverCards.leave(this.hoverCards.key,cx); this.hoverRow=null; this.tabsSelection.cancel(); this.machineDrag = null; this.pressed = null; this.over = null; cx.notify(); }
      })
      .on_mouse_move((e, cx) => {this.recordSpaceDrag(e, cx);this.tabsSelection.outside(e, cx);})
      .on_mouse_down_out((e) => { this.hoverCards.outsidePress(e.position); this.machineDrag = null; })
      .on_mouse_up("left", (_e, cx) => {
        if(this.tabsSelection.pressed !== null){this.tabsSelection.cancel();cx.notify();}
        if (this.machineDrag || this.pressed !== null) {
          this.machineDrag = null; this.pressed = null; this.over = null; this.dropAtEnd = false; cx.notify();
        }
      })
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces")
          .child(h_flex().id("agents-favorites-only").h(24).px(6).gap(4).items_center().rounded(6)
            .cursor_pointer().text_color(favoritesOnly ? (shared("agents.favoritesTier") === "blue" ? t.ansi4 : t.ansi3) : t.dim)
            .when(favoritesOnly, el => el.bg(t.selected))
            .hover(el => el.bg(t.hover).text_color(favoritesOnly ? (shared("agents.favoritesTier") === "blue" ? t.ansi4 : t.ansi3) : t.foreground))
            .tooltip((shared("agents.favoritesTier") === "blue" ? "파란별만 표시" : "노란별·파란별 표시") + " · 클릭: 필터 켜기/끄기 · 우클릭: 등급 전환 (⌘⌥S)")
            .on_mouse_down("right", (_e,cx) => {cx.stop_propagation();setShared("agents.favoritesTier", shared("agents.favoritesTier") === "blue" ? "all" : "blue");setShared("agents.favoritesOnly",true);})
            .on_mouse_up("right", (_e,cx) => cx.stop_propagation())
            .on_click(() => setShared("agents.favoritesOnly", !favoritesOnly))
            .child(svg(`mods/spaces-agents/${favoritesOnly ? "star-filled" : "star"}.svg`).size(13))
            .child("Starred only")))
        .child(resumeControl(terminals(), t))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => openOverlay({ mod: "worktree-codex", kind: "dialog", width: 460, height: 360, props: { space: spaces().find(s => s.active)?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } })).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .when(!collapsed && this.tabsSelection.ids.size > 1, el => el.child(h_flex().id("sidebar-tab-selection")
        .h(30).flex_none().mx(8).px(8).gap(6).items_center().rounded(6).bg(t.selected).text_size(11).text_color(t.accent)
        .child(div().flex_1().child(`${this.tabsSelection.ids.size}개 탭 선택됨`))
        .child(div().id("sidebar-tab-actions").px(6).py(4).cursor_pointer().on_click(() => this.tabsSelection.open()).child("작업 ▾"))
        .child(div().id("sidebar-tab-clear").px(6).py(4).cursor_pointer().tooltip("탭 선택 해제")
          .on_click((_e, cx) => {this.tabsSelection.clear();cx.notify();}).child("×"))))
      .when(!collapsed && this.selectedIds.size > 1, el => el.child(h_flex().id("worktree-selection-toolbar")
        .h(30).flex_none().mx(8).px(8).gap(6).items_center().rounded(6).bg(t.selected).text_size(11).text_color(t.accent)
        .child(div().flex_1().child(`${this.selectedIds.size}개 선택됨`))
        .child(div().id("worktree-selection-actions").px(6).py(4).cursor_pointer().hover(el => el.bg(t.hover))
          .on_click(() => this.selectionMenu()).child("작업 ▾"))
        .child(div().id("worktree-selection-clear").px(6).py(4).cursor_pointer().tooltip("선택 해제")
          .hover(el => el.bg(t.hover)).on_click((_e, cx) => { this.setSelection([], null); cx.notify(); }).child("×"))))
      .child(v_flex().id("spaces-agents-list").flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_scroll_wheel(()=>{this.hoverCards.dismiss();this.hoverAnchors.clear();})
        .when(typeof div().drag_autoscroll === "function", el => el.drag_autoscroll(this.pressed !== null || this.tabsSelection.pressed !== null))
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; this.dropAtEnd = false; cx.notify(); })
        .children(rows)
        .when(!collapsed, el => el.child(div().id("worktree-drop-end").relative().flex_1().min_h(28)
          .tooltip("Drag here to move to the end of the current worktree group")
          .on_mouse_move((e, cx) => { this.recordSpaceDrag(e, cx); this.hoverDrop(this.endTarget(), "after", cx, true); })
          .on_mouse_up("left", (_e, cx) => this.finishDrop(this.endTarget(), "after", cx))
          .when(this.pressed !== null && this.dropAtEnd && this.over !== null, target => target.child(
            div().absolute().left(0).right(0).top(0).h(2).bg(t.accent)))))
        .when(!collapsed && favoritesOnly && !this.hasFilteredTabs, el => el.child(
          div().px(8).py(10).text_size(12).text_color(t.dim).child("즐겨찾기한 탭이 없습니다. Starred only를 끄면 모든 탭을 볼 수 있습니다."))))
      .when(Boolean(sp.find(s => s.active && this.backlogIds?.has(s.id))), el => el.child(this.backlogBanner(t, collapsed)))
      .when((this.archivedRows?.length ?? 0) > 0, el => el.child(this.backlogSection(t, collapsed)))
      .when(Boolean(this.backlogUndo), el => el.child(h_flex().id("backlog-feedback").mx(8).mb(6).px(8).h(32).gap(6).flex_none().items_center().rounded(6).bg(t.raised)
        .when(!collapsed, el => el.child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
          .tooltip(`${this.backlogUndo?.name} · ${this.backlogUndo?.count}개 워크트리`)
          .child(this.backlogUndo?.archived ? "Backlog로 옮겼어요" : "작업 목록으로 옮겼어요")))
        .child(div().id("backlog-undo").flex_none().text_size(11).text_color(t.accent).cursor_pointer().hover(el => el.text_color(t.foreground))
          .on_click((_e, cx) => this.backlogCommand("undo", cx)).child(collapsed ? "↶" : "실행 취소"))))
      .when(collapsed, (el) => el.child(h_flex().h(28).flex_none().items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click(toggleSidebar).child("»"))));
  }
}
