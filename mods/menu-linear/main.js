// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, spaces, panes, exec, agents, notify } from "herdr";

import { inspectPull, safePull } from "./git-pull.js";
import { pullRequestTarget, readPullRequest } from "./pull-request.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

function items(p, git, pull, pr) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A terminal shown outside a tab (a layout terminal block, a window) has
      // no pane to split, zoom or close: its pane is the block's id.
      const inTab = panes().some((pane) => pane.pane === tg.pane);
      return [
        ...(inTab
          ? [
              ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
              ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
              ["Zoom", "pane.zoom", { pane: tg.pane }],
            ]
          : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        ...(inTab ? [["Close pane", "pane.close", { pane: tg.pane }]] : []),
      ];
    }
    case "agent":
      return [
        ["PR 바로가기", "pr.open", { url: pr?.url }, !pr?.url],
        ["Create Linear Issue & Move…", "agent.issue", tg],
        ["Rename", "tab.rename", { id: tg.id }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "tab":
      return [
        ["PR 바로가기", "pr.open", { url: pr?.url }, !pr?.url],
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["PR 바로가기", "pr.open", { url: pr?.url }, !pr?.url],
        ["Rename", "space.rename", { id: tg.id }],
        ...(git && pull?.branch === "main" ? [[`Pull · ${pull.upstream}`, "git.pull", { id: tg.id }]] : []),
        [tg.backlog ? "작업 목록으로 복귀" : `Backlog로 이동${tg.descendants > 0 ? " (하위 포함)" : ""}`, tg.backlog ? "backlog.restore" : "backlog.archive", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

function menuIcon(command) {
  const name = command === "pr.open" ? "git-branch" : command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : (command === "worktree" || command === "git.pull") ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || (name === "space.rename" && b.action === "spaces-agents.rename") || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.pull = null;
    this.pr = null;
    this.busy = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const target = pullRequestTarget(p, spaces(), panes());
    const space = target?.space;
    const folder = target?.folder;
    if (folder) cx.spawn(async (cx) => {
      this.pr = await readPullRequest(exec, folder, space.machine).catch(() => null);
      cx.notify();
    });
    if (folder && p?.tab === "space")
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        this.folder = folder;
        this.on = space.machine || null;
        if (this.git) this.pull = await inspectPull(this.gitCommand()).catch(() => null);
        cx.notify();
      });
  }

  gitCommand() {
    return async (args, options = {}) => {
      const r = await exec("git", ["--no-optional-locks", ...args], { cwd: this.folder, on: this.on, timeout: 120000 });
      if (r.code !== 0) throw new Error(r.stderr?.trim() || "Git 작업에 실패했습니다. 원격 추적 브랜치와 연결 상태를 확인해 주세요.");
      if (options.exists) {
        const exists = await exec("sh", ["-c", 'test -e "$1"', "herdr-pull", r.stdout.trim()], { cwd: this.folder, on: this.on });
        if (exists.code !== 0 && exists.code !== 1) throw new Error("진행 중인 Git 작업을 확인할 수 없습니다.");
        return exists.code === 0;
      }
      return r.stdout.trim();
    };
  }

  async checkAgents(top) {
    const target = spaces().find(s => s.id === props()?.target?.id);
    if (!target) throw new Error("스페이스가 닫혔습니다.");
    for (const a of agents().filter(a => a.status === "working" || a.status === "blocked")) {
      const space = spaces().find(s => s.id === a.space);
      if (!space || (space.machine || null) !== this.on) continue;
      const cwd = panes().find(p => p.terminal === a.address)?.cwd
        || terminals().find(t => t.address === a.address)?.cwd || space.folder;
      if (!cwd) throw new Error("작업 중인 에이전트의 폴더를 확인할 수 없습니다.");
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: this.on });
      if (r.code === 0 && r.stdout.trim() === top)
        throw new Error("main 작업 폴더에서 에이전트가 작업 중이거나 응답을 기다리고 있습니다.");
    }
  }

  choose(i, cx) {
    if (this.busy) return;
    const it = items(props(), this.git, this.pull, this.pr)[i];
    if (!it || it[3]) return;
    if (it[1] === "pr.open") {
      cx.open_url(it[2].url);
      closeOverlay(props()?.overlay);
      return;
    }
    if (it[1] === "git.pull") {
      this.busy = true;
      cx.notify();
      cx.spawn(async (cx) => {
        try {
          if (!this.pull) throw new Error("원격 추적 브랜치가 없거나 현재 브랜치를 확인할 수 없습니다.");
          const result = await safePull(this.gitCommand(), this.pull, top => this.checkAgents(top));
          notify({ title: result.changed ? "Pull 완료" : "이미 최신 상태입니다", body: result.upstream, level: "success" });
          closeOverlay(props()?.overlay);
        } catch (e) {
          notify({ title: "Pull을 중단했습니다", body: String(e.message || e), level: "warning", timeout: 12000 });
        } finally {
          this.busy = false;
          cx.notify();
        }
      });
      return;
    }
    closeOverlay(props()?.overlay);
    if (it[1] === "agent.issue") openOverlay({ mod: "agent-issue", kind: "dialog", width: 620, height: 570, props: it[2] });
    else if (it[1] === "worktree") openOverlay({ mod: "worktree-codex", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: it[2].action === "new" ? 360 : 560 }), props: it[2] });
    else if (it[1].startsWith("backlog.")) run(`spaces-agents.backlog:${it[1].slice("backlog.".length)}:${it[2].id}`);
    else if (it[1] === "space.rename") run(`spaces-agents.rename:${it[2].id}`);
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git, this.pull, this.pr);
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(it[3] ? t.dim : t.foreground)
            .when(!it[3] && i === this.at, (el) => el.bg(t.selected))
            .when(!it[3], el => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().child(this.busy && it[1] === "git.pull" ? "Pull 중…" : it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      );
  }
}
