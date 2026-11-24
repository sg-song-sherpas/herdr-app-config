import { View, div } from "gpui-kit";
import { shared, setShared, run, closeOverlay, props } from "herdr";
// Compatibility entry for old integrations; the application now has one interface.
export default class ControlCenter extends View {
  init(_props, cx) {
    const config = { ...(shared("acc.config") ?? {}), interfaceMode: "control" };
    delete config.classicLayout;
    setShared("acc.config", config);
    if (shared("layout") !== "agent-control-center") run("layout.switch", { name: "agent-control-center" });
    cx.spawn(async () => { closeOverlay(props()?.overlay); });
  }
  render() { return div().w(1).h(1); }
}
