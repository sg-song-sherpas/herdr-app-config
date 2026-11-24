// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, VirtualListScrollHandle, v_virtual_list, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, shared } from "herdr";

import { parseDiff, diffColors } from "./diff.js";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

function navigation() {
  const request = shared("files.navigation"), f = focused(), space = spaces().find(s => s.active);
  return request && request.space === space?.id && request.tab === f?.tab ? request : null;
}
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const request = navigation();
  if (request) return { cwd: request.root, on: request.on, space: space?.id };
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.diffScroll = VirtualListScrollHandle.new();
    this.mode = "diff"; this.diffRows = [];
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx, line = null) {
    const generation = this.showGeneration = (this.showGeneration ?? 0) + 1;
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.mode = "diff"; this.diffRows = []; this.diffError = null; this.diffBase = null; this.diffLimited = false;
    this.navigationWarning = null; this.requestedLine = line;
    if (!path || !cx) return;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", [...READ, "rev-parse", "--show-toplevel"], {cwd:this.root,on:this.on});
        if (!this.isShowing(path, generation, context)) return;
        if (top.code !== 0) throw new Error("Git 저장소가 아닙니다. 코드 원문을 볼 수 있습니다.");
        let base = "refs/remotes/origin/main";
        const remote = await exec("git", [...READ, "rev-parse", "--verify", base], {cwd:this.root,on:this.on});
        if (remote.code !== 0) {
          base = "refs/heads/main";
          const local = await exec("git", [...READ, "rev-parse", "--verify", base], {cwd:this.root,on:this.on});
          if (local.code !== 0) throw new Error("main 기준을 찾을 수 없습니다. origin/main 또는 main이 필요합니다.");
        }
        const diff = await exec("git", [...READ, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--find-renames", `${base}...HEAD`, "--", path], {cwd:this.root,on:this.on});
        if (!this.isShowing(path, generation, context)) return;
        if (diff.code !== 0) throw new Error(diff.stderr.trim() || "PR diff를 읽을 수 없습니다.");
        this.diffBase = base;
        this.diffRows = parseDiff(diff.stdout.slice(0,400000)).rows.slice(0,10000)
          .map(row => ({...row,text:row.text.length>4000 ? row.text.slice(0,4000)+"…" : row.text}));
        this.diffLimited = diff.stdout.length > 400000 || this.diffRows.length === 10000;
        this.diffWidth = Math.max(300, ...this.diffRows.map(row => row.text.length * 7.5 + 115));
        const index = line ? this.diffRows.findIndex(row => Number(row.next) === line) : -1;
        if (index >= 0) this.diffScroll.scroll_to_item(index,"center");
        else if (line) {
          this.navigationWarning = "선택한 줄은 PR diff에 포함되지 않아 코드 원문으로 열었습니다.";
          this.mode = "code";
          await this.loadCode(path, generation, context, line);
        }
      } catch (error) {
        if (this.isShowing(path, generation, context)) {
          this.diffError = String(error.message ?? error);
          if (line) { this.mode = "code"; await this.loadCode(path,generation,context,line); }
        }
      } finally { cx.notify(); }
    });
  }

  isShowing(path, generation, context) {
    return this.showGeneration === generation && this.file === path && this.current(context);
  }

  async loadCode(path, generation, context, line) {
    try {
      const text = await readTextFile(`${this.root}/${path}`, {on:this.on});
      if (!this.isShowing(path,generation,context)) return;
      if (text === null) {this.fileError="This file is no longer available";return;}
      if (text.includes("\0")) {this.fileError="Binary file · no text preview";return;}
      const t=theme(),ext=path.includes(".")?path.split(".").pop():"txt";
      this.code?.release();
      this.code=EditorState.new({language:LANG[ext]??ext,readonly:true,
        value:text.length>400000 ? text.slice(0,400000)+"\n… (file truncated)" : text,
        font_family:settings().font_family,font_size:12,
        syntax:{keyword:t.ansi5,string:t.ansi2,comment:t.dim,function:t.ansi4,type:t.ansi3,number:t.ansi1,constant:t.ansi6}});
      if (line && typeof this.code.go_to_line === "function") this.code.go_to_line(line);
      else if (line) this.navigationWarning="현재 Herdr 빌드에는 줄 이동 API가 없습니다. 파일만 열었습니다.";
    } catch {if(this.isShowing(path,generation,context))this.fileError="Cannot preview this file (binary, too large, or unreadable)";}
  }

  switchMode(mode,cx) {
    this.mode=mode; this.navigationWarning=null;
    if(mode === "code" && !this.code) {
      const path=this.file,generation=this.showGeneration,context=this.context;
      cx.spawn(async cx => {await this.loadCode(path,generation,context,this.requestedLine);cx.notify();});
    }
    cx.notify();
  }

  diffView(t) {
    const hex=t.background.replace("#","").slice(0,6), dark=parseInt(hex,16)<0x808080;
    const c=diffColors(dark);
    if (!this.diffRows.length) return div().p(12).text_color(t.dim)
      .child(this.diffError || (this.diffBase ? "main 대비 커밋된 변경 없음" : "PR diff 불러오는 중…"));
    return div().id("files-pr-diff").relative().flex_1().min_h(0).font_family(settings().font_family??"Menlo").text_size(12)
      .child(div().size_full().overflow_x_scrollbar().child(div().min_w(this.diffWidth).h_full()
        .child(v_virtual_list("files-pr-lines",this.diffRows.length,22,i=>String(i),range=>
          this.diffRows.slice(range.start,range.end).map(row=> {
            const [bg,ink]=c[row.kind]??[c.background,c.text];
            return h_flex().h(22).w_full().flex_none().bg(bg).text_color(ink).items_center().whitespace_nowrap()
              .child(div().w(42).flex_none().text_right().text_color(c.muted).child(String(row.old)))
              .child(div().w(8).flex_none().child(" "))
              .child(div().w(42).pr(8).flex_none().text_right().text_color(c.muted).child(String(row.next)))
              .child(div().flex_none().child(row.text.replace(/\t/g,"    ")));
          })).track_scroll(this.diffScroll).size_full())))
      .child(Scrollbar.vertical("files-pr-lines").viewport_from_layout().absolute().inset_0());
  }

  close() { this.context=null;this.showGeneration++;this.code?.release();this.diffScroll?.release(); }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files-sketch/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-sketch/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const request = navigation();
    if (request && request.nonce !== this.navigationNonce) {
      this.navigationNonce = request.nonce;
      this.navigationWarning = null;
      const valid = typeof request.path === "string" && !/^(?:[\\/]|[A-Za-z]:)/.test(request.path)
        && !request.path.split(/[\\/]/).includes("..") && !/[\x00-\x1f]/.test(request.path);
      if (valid) this.show(request.path, cx, Math.max(1, Math.floor(Number(request.line) || 1)));
    }
    const t = theme();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(Boolean(this.file),el=>el.child(h_flex().gap(4)
          .children([["diff","PR diff"],["code","코드"]].map(([mode,label])=>div().id(`files-mode-${mode}`)
            .px(6).py(3).rounded(4).bg(this.mode===mode?t.selected:t.chrome).cursor_pointer()
            .on_click((_e,cx)=>this.switchMode(mode,cx)).child(label)))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(Boolean(this.navigationWarning), el => el.child(div().p(8).text_size(12).child(this.navigationWarning)))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file && this.mode === "diff"),el=>el.child(div().px(12).py(4).text_size(11).text_color(t.dim)
        .child(`${this.diffBase === "refs/heads/main" ? "main" : "origin/main"}…HEAD · 공통 조상 기준 · 커밋된 변경`)))
      .when(Boolean(this.file && this.mode === "diff"),el=>el.child(this.diffView(t)))
      .when(Boolean(this.diffLimited && this.mode === "diff"),el=>el.child(div().p(8).text_size(11).child("표시 한도에 도달했습니다. 일부 diff만 표시합니다.")))
      .when(Boolean(this.file && this.mode === "code"), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
