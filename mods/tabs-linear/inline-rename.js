// Kept identical in both mods: Herdr mods cannot import each other.
import { div } from "gpui-kit";
import { InputState, Input } from "gpui-base";
import { run, panes, exec, appHome, notify } from "herdr";

export class InlineRename {
  constructor(cx, kind = "tab") {
    this.kind = kind;
    this.id = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: kind === "space" ? "워크트리 이름" : "작업 이름" });
    this.input.on("submit", (_e, cx) => this.finish(true, cx));
    this.input.on("blur", (_e, cx) => this.finish(true, cx));
  }

  begin(id, name, cx) {
    this.id = id;
    this.original = name;
    this.input.set_value(name);
    this.input.focus();
    cx.notify();
    // Focus again once the input has joined the rendered focus tree.
    cx.timer.after(30, cx => { if (this.id === id) this.input.focus(); });
  }

  finish(save, cx) {
    if (!this.id) return;
    const id = this.id, name = this.input.value().trim();
    this.id = null;
    if (save && name) {
      if (name !== this.original) run(`${this.kind}.rename`, { id, name });
      const terminals = this.kind === "tab" ? [...new Set(panes().filter(p => p.tab === id && p.terminal
        && (p.app === "codex" || p.program?.key === "codex")).map(p => p.terminal))] : [];
      if (terminals.length) cx.spawn(async () => {
        try {
          const result = await exec("python3", [`${appHome()}/mods/tabs-linear/codex-rename.py`, JSON.stringify({ terminals, name })]);
          if (result.code !== 0) throw new Error(result.stderr?.trim() || "Codex 서버에 연결하지 못했습니다.");
        } catch (error) {
          notify({ title: "탭 이름은 저장했지만 Codex 이름 동기화에 실패했습니다", body: String(error.message ?? error), level: "error" });
        }
      });
    }
    cx.notify();
  }

  render(t) {
    const stop = (_e, cx) => cx.stop_propagation();
    return div().id(`rename-${this.kind === "space" ? "space-" : ""}${this.id}`).track_focus(this.handle).min_w(0).h(23)
      .border(1).border_color(t.accent).rounded(4).bg(t.background)
      .on_mouse_down("left", stop).on_mouse_up("left", stop).on_click(stop)
      .on_key_down((e, cx) => {
        if ((e.keystroke ?? e.key) !== "escape") return;
        cx.stop_propagation();
        this.finish(false, cx);
      })
      .child(Input.new(this.input).size_full().text_size(12.5).text_color(t.foreground));
  }
}
