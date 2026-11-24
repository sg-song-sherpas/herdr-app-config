import { div } from "gpui-kit";
import { openOverlay } from "herdr";
import { pendingCount } from "./resume-ui-data.js";

export function resumeControl(allTerminals, t) {
  const count = pendingCount(allTerminals);
  return div().id("interrupted-work-open").h(24).min_w(24).px(5).flex_none()
    .flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(count ? t.accent : t.dim)
    .hover(el => el.bg(t.hover).text_color(t.foreground))
    .tooltip(count ? `중단된 작업 ${count}개 확인·재개` : "중단된 작업 확인·재개")
    .on_click(() => openOverlay({mod: "agent-resume", kind: "dialog", width: 560, height: 460}))
    .child(count ? `▷ ${count}` : "▷");
}
