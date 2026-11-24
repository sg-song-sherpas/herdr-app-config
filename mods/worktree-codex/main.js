// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space. { issue } previews a selected
// Linear issue until confirmed; { branch, name?, tab?, argv? } creates immediately.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, Checkbox } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, notify, openOverlay } from "herdr";
import { issueIdentifier, resolveIssueInput, issueLaunch } from "./linear.js";
import { isQaIssue, parentLinks, saveParent } from "./hierarchy.js";
import { buildRemovalPlan, validateRemovalPlan, forgetRemovedParents } from "./removal.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  // space.new uses "" for this computer; exec requires null for local execution.
  const r = await exec("git", args, { cwd, on: on || null, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    if (props()?.removal) {
      this.removal = props().removal;
      cx.spawn(async () => this.finishRemoval());
      return;
    }
    // A shortcut has no explicit target; keep the space selected when it opened.
    this.contextSpace = !props()?.space && !props()?.folder ? spaces().find(s => s.active) : undefined;
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.issue?.identifier ?? props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    const selected = props()?.issue;
    this.qaIssue = isQaIssue(selected);
    this.qaTouched = false;
    this.preview = selected ? { input: this.text, status: "ready", issue: selected, promise: Promise.resolve(selected) } : null;
    this.previewTimer = null;
    // Selected list rows may omit the body. Resolve it as the dialog opens.
    if (selected && !Object.prototype.hasOwnProperty.call(selected, "description")) {
      cx.spawn(async (cx) => { try { await this.lookupIssue(this.text.trim(), cx); } catch {} });
    }
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "Issue number, Linear ID, link, or branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.qaIssue = false; this.qaTouched = false; this.error = ""; this.at = 0; this.schedulePreview(cx); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    if (props()?.action !== "remove") {
      this.input.focus();
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.removalPlan = null;
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (props()?.issue) await this.useBasecamp();
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.issue ? this.repo.top : props()?.folder || place(this.space()) || this.userHome;
        if (this.folder === "~") this.folder = this.userHome;
        else if (this.folder.startsWith("~/")) this.folder = this.userHome + this.folder.slice(1);
        // Enable confirmation only once the repository and its warnings are known.
        const repo = await repoOf(this.folder, this.on);
        this.repo = repo;
        if (repo?.linked && props().action === "remove") {
          this.removalPlan = await buildRemovalPlan({ ...repo, space: this.space()?.id }, this.on, { git, repoOf, submodules });
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        if (props().branch) await this.work(cx);
      } catch (error) {
        if (props()?.action !== "remove" || this.repo === undefined) this.repo = null;
        this.error = String(error); cx.notify();
      }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : this.contextSpace);
  }

  close() {
    this.previewTimer?.cancel();
    this.preview = null;
    closeOverlay(props().overlay);
  }

  schedulePreview(cx) {
    this.previewTimer?.cancel();
    this.preview = null;
    if (this.opening || props()?.action === "remove" || props()?.branch) return;
    const input = this.text.trim();
    try { if (!issueIdentifier(input)) return; }
    catch { return; } // A pasted link may still be incomplete while typing.
    this.previewTimer = cx.timer.after(350, (cx) => {
      cx.spawn(async (cx) => {
        try { await this.lookupIssue(input, cx); }
        catch {} // The request state displays the lookup error.
      });
    });
  }

  lookupIssue(input, cx) {
    if (this.preview?.input === input && this.preview.status !== "error"
        && (this.preview.status === "loading" || Object.prototype.hasOwnProperty.call(this.preview.issue ?? {}, "description"))) return this.preview.promise;
    const request = { input, status: "loading", issue: null, error: "" };
    this.preview = request;
    request.promise = resolveIssueInput(input);
    request.promise.then(issue => {
      if (this.preview !== request) return;
      this.applyQaDefault(issue);
      request.issue = issue;
      request.status = "ready";
      cx.notify();
    }, error => {
      if (this.preview !== request) return;
      request.error = String(error?.message ?? error);
      request.status = "error";
      cx.notify();
    });
    cx.notify();
    return request.promise;
  }

  applyQaDefault(issue) {
    if (!this.qaTouched) this.qaIssue = isQaIssue(issue);
  }

  setQaIssue(checked, cx) {
    if (this.busy) return;
    this.qaTouched = true;
    this.qaIssue = checked;
    cx.notify();
  }

  go(cx) {
    if (this.busy || !this.repo || (props()?.action === "remove" && (!this.repo.linked || !this.removalPlan))) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo || (props()?.action === "remove" && (!this.repo.linked || !this.removalPlan))) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try {
      if (props().action === "remove") {
        this.error = await this.remove(cx);
        if (!this.error) return; // The dialog is closed; do not use its context.
      } else this.error = await this.create(cx);
    }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async useBasecamp() {
    const matches = spaces().filter(s => s.name === "Sherpas Basecamp" && !s.machine && s.folder);
    if (matches.length !== 1) throw new Error("로컬 Sherpas Basecamp 공간을 하나로 찾지 못했습니다. 공간을 확인해 주세요.");
    const repo = await repoOf(matches[0].folder, "");
    if (!repo || repo.linked) throw new Error("Sherpas Basecamp 공간은 로컬 저장소의 기본 체크아웃이어야 합니다.");
    // null inherits the active machine in space.new; an empty string selects this Mac.
    this.on = "";
    this.userHome = home();
    this.repo = repo;
  }

  async create(cx) {
    this.previewTimer?.cancel();
    let branch = this.text.trim();
    if (!branch) return "Type an issue number, Linear ID, link, or branch name.";
    let issue = props().branch ? null : await this.lookupIssue(branch, cx);
    // List/search previews may contain only a title and branch. Fetch the body
    // before choosing a parent, including when Enter used the cached preview.
    if (issue && !Object.prototype.hasOwnProperty.call(issue, "description")) {
      issue = await resolveIssueInput(issue.identifier);
    }
    if (issue) await this.useBasecamp();
    this.applyQaDefault(issue);
    const links = parentLinks(this.qaIssue, spaces(), this.on || null, this.on ? this.repo.main : undefined);
    if (issue) {
      if (!issue.branchName?.trim()) return "This Linear issue has no branch name.";
      branch = issue.branchName;
    }
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
    if (this.createdPath !== path) {
      const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
      const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
      const r = await git(this.repo.top, add, this.on, 600_000);
      if (!r.ok) return r.err || "git worktree add failed.";
      this.createdPath = path;
    }
    try { await saveParent(path, links); }
    catch (error) {
      return `워크트리는 ${path}에 생성됐지만 부모 관계를 저장하지 못했습니다. Create를 다시 누르면 관계 저장을 재시도합니다: ${error.message ?? error}`;
    }
    const p = props();
    // Linear work starts directly in Codex with the same space/tab/session name.
    const launch = issue ? issueLaunch(issue) : { name: p.name, tab: p.tab, argv: p.argv };
    run("space.new", { ...launch, folder: path, machine: this.on });
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on });
  }

  async remove(cx) {
    if (!this.removalPlan) return "삭제 대상 확인이 끝나지 않았습니다.";
    // An independent worker survives closing this confirmation dialog.
    openOverlay({ mod: "worktree-codex", kind: "window", frame: "none",
      width: 340, height: 64, at: { x: 16, y: 16 },
      props: { removal: { plan: this.removalPlan, top: this.repo.top } } });
    this.close();
    return "";
  }

  async finishRemoval() {
    const plan = this.removal.plan;
    const overlay = props().overlay;
    const removed = [];
    let failedTop = this.removal.top;
    try {
      if (!plan) {
        const error = new Error("삭제 대상 확인 방식이 바뀌었습니다. 삭제창을 다시 열어 목록을 확인해 주세요.");
        error.cancelled = true;
        throw error;
      }
      const root = await repoOf(plan.root.top, plan.root.on);
      if (!root?.linked) throw new Error("선택한 Git 워크트리를 다시 확인하지 못했습니다. 삭제하지 않았습니다.");
      const current = await buildRemovalPlan({ ...root, space: plan.root.space }, plan.root.on, { git, repoOf, submodules });
      validateRemovalPlan(plan, current);
      const byKey = new Map(current.targets.map(target => [target.key, target]));
      // Children go first. Any failed deletion leaves its parents untouched.
      for (const key of current.order) {
        const target = byKey.get(key);
        failedTop = target.top;
        // Close every space for this checkout, including spaces with no tabs.
        for (const id of target.spaceIds) run("space.close", { id, confirmed: true });
        const result = await git(target.main, ["worktree", "remove", ...(target.force ? ["--force"] : []), target.top], target.on, 600_000);
        if (!result.ok) throw new Error(result.err || "git worktree remove failed.");
        removed.push(target);
      }
    } catch (error) {
      const partial = removed.length ? `\n삭제 완료: ${removed.map(target => target.top).join(", ")}` : "";
      notify({ title: error.cancelled ? "워크트리 삭제 중단" : "워크트리 삭제 실패",
        body: `${failedTop}: ${String(error?.message ?? error)}${partial}`,
        level: error.cancelled ? "warning" : "error", timeout: 15000 });
    } finally {
      try { await forgetRemovedParents(removed); }
      catch (error) {
        notify({ title: "워크트리 부모 관계 기록 정리 실패",
          body: `폴더 ${removed.length}개는 삭제됐지만 관계 기록을 정리하지 못했습니다: ${String(error?.message ?? error)}`,
          level: "warning", timeout: 15000 });
      }
      closeOverlay(overlay);
    }
  }

  renderRemovalTargets(t) {
    const targets = this.removalPlan?.targets ?? [];
    return v_flex().id("wt-removal-targets").flex_1().min_h(0).gap(8)
      .child(div().flex_none().font_semibold().text_color(t.blocked)
        .child(`함께 삭제되는 워크트리 (${targets.length}개)`))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(6)
        .children(targets.map(target => v_flex().id(`wt-remove-${target.key}`).flex_none().min_w(0)
          .p(10).gap(3).rounded(6).bg(t.surface)
          .child(div().font_medium().text_color(t.foreground).child(`${target.depth ? "하위" : "선택한"} 워크트리 · ${target.name}`))
          .child(div().text_size(11).text_color(t.muted).child(`${target.on || "이 컴퓨터"} · ${target.top}`))
          .when(target.dirty, row => row.child(div().text_size(11).text_color(t.blocked).child("미커밋 변경이 삭제됩니다.")))
          .when(target.warned.length > 0, row => row.child(div().text_size(11).text_color(t.blocked)
            .child(`서브모듈 ${target.warned.join(", ")}의 다른 곳에 보존되지 않은 커밋이 삭제됩니다.`))))));
  }

  key(e, cx) {
    if (e.key === "escape") { if (!this.busy) this.close(); return; }
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.removal) return h_flex().size_full().px(12).gap(10).items_center()
      .rounded(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
      .child(v_flex().min_w(0)
        .child(div().font_semibold().child(`워크트리 ${this.removal.plan?.targets.length ?? 1}개 삭제 중…`))
        .child(div().truncate().text_color(t.muted).child(this.removal.top)));

    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `워크트리 ${s?.name ?? ""} 삭제` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : "선택한 워크트리와 연결된 모든 하위 워크트리의 폴더를 삭제하고 공간과 세션을 닫습니다. 브랜치는 남습니다."
            : `Enter an issue number (10355 → PRD-10355), Linear ID or link, or a branch name. New branches start from this checkout.`;
    const blocked = !r || (remove && !r.linked);
    const disabled = blocked || this.busy || (remove && !this.removalPlan) || (!remove && !this.text.trim());
    const button = (id, label, primary, inactive, action) =>
      h_flex().id(id).flex_none().h(32).px(14).items_center().rounded(8)
        .border_1().border_color(primary ? t.solid : t.input)
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .text_size(12).font_medium()
        .when(inactive, el => el.opacity(0.4))
        .when(!inactive, el => el.cursor_pointer().hover(s => s.opacity(0.88)))
        .on_click((_e, cx) => { if (!inactive) action(cx); })
        .child(label);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && Boolean(this.removalPlan), el => el.child(this.renderRemovalTargets(t)))
      // Keep the focused input mounted while repository discovery is pending.
      .when(!remove, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(!remove && Boolean(this.preview), el => el.child(
        v_flex().id("linear-preview").flex_none().gap(4).p(10).rounded(6).bg(t.surface)
          .when(this.preview?.status === "loading", box => box.child(div().text_color(t.muted).child("Looking up Linear issue…")))
          .when(this.preview?.status === "error", box => box.child(div().text_color(t.blocked).child(this.preview?.error)))
          .when(Boolean(this.preview?.issue), box => box
            .child(div().text_size(11).text_color(t.accent).child(this.preview?.issue?.identifier))
            .child(div().font_semibold().text_color(t.foreground).child(this.preview?.issue?.title))
            .child(div().text_size(11).truncate().text_color(t.muted).child(this.preview?.issue?.branchName))),
      ))
      .when(!remove, el => el.child(
        Checkbox.new("wt-qa-issue").checked(Boolean(this.qaIssue)).disabled(this.busy)
          .accessibility_label("QA 이슈").h_flex().items_center().gap(8).flex_none()
          .when(this.busy, box => box.opacity(0.4))
          .when(!this.busy, box => box.cursor_pointer())
          .on_change((checked, cx) => this.setQaIssue(checked, cx))
          .child(div().size(16).flex_none().rounded(3).border_1()
            .border_color(this.qaIssue ? t.accent : t.input)
            .bg(this.qaIssue ? t.accent : t.background)
            .text_color(t.background).text_size(12).items_center().justify_center()
            .child(this.qaIssue ? "✓" : ""))
          .child(v_flex().gap(2)
            .child(div().text_color(t.foreground).child("QA 이슈"))
            .child(div().text_size(11).text_color(t.muted)
              .child(this.qaIssue ? "QA 하위에 표시합니다." : "Sherpas Basecamp 바로 하위에 표시합니다."))),
      ))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!remove, el => el.child(div().flex_1()))
      .child(
        h_flex()
          .justify_end()
          .items_center()
          .gap(8)
          .when(this.busy, el => el.child(h_flex().items_center().gap(6).text_size(11).text_color(t.dim)
            .child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
            .child("working…")))
          .child(button("wt-cancel", remove ? "취소" : "Cancel", false, this.busy, () => this.close()))
          .child(button("wt-confirm", remove ? `워크트리 ${this.removalPlan?.targets.length ?? 0}개 삭제` : "Create", true, disabled, cx => this.go(cx))),
      );
  }
}
