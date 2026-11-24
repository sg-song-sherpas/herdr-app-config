// Keep the user's preference separate from whether there are cards to display.
export function unreadDockAction(enabled, count, visible) {
  const wanted = enabled === true;
  return wanted === visible ? null : wanted ? "show" : "hide";
}
