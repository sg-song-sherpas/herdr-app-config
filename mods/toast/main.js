// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, run, theme, shared } from "herdr";

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    // Control Center completion notification filter v2.
    if (shared("acc.config")?.sidebarCompletionNotifications === false &&
        p.level === "success" && typeof p.title === "string" &&
        p.title.startsWith("finished: ") && p.action?.name === "agent.focus" &&
        p.action?.args?.terminal) {
      if (!this.dismissQueued) {
        this.dismissQueued = true;
        cx.spawn(async () => { closeOverlay(p.overlay); });
      }
      return div().w(0).h(0);
    }
    const compact = (this.width ?? 340) < 96;
    return h_flex()
      .id("toast")
      .size_full()
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } })
      .px(compact ? 4 : 12)
      .gap(compact ? 0 : 8)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .when(!compact, el => el.child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"])))
      .when(!compact, el => el.child(
        v_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(p.title ?? ""))
          .when(Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? ""))),
      ))
      .child(div().id("toast-close").size(28).flex_none().flex().items_center().justify_center()
        .rounded(5).text_color(t.muted).hover(s => s.bg(t.raised).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); closeOverlay(p.overlay); })
        .child(svg("mods/pane/close.svg").size(12)));
  }
}
