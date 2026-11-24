// Keep the user's persistent navigation geometry when changing interface.
export function findNode(tree, id) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.id === id) return tree;
  for (const child of tree.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function captureNavigation(tree) {
  const result = [];
  for (const id of ["sidebar", "panel"]) {
    const node = findNode(tree, id);
    if (!node) continue;
    const size = node.size ?? {};
    const dimensions = Number.isFinite(size.px) && size.px > 0 ? { px: size.px } :
      Number.isFinite(size.weight) && size.weight > 0 ? { weight: size.weight } : null;
    if (dimensions) result.push({ command: "layout.resize", args: { id, ...dimensions } });
    result.push({ command: node.hidden ? "layout.hide" : "layout.show", args: { id } });
  }
  const stack = findNode(tree, "panel-body");
  const active = stack?.children?.find(child => child.id === stack.active && !child.hidden) ??
    stack?.children?.find(child => !child.hidden);
  if (active?.id) result.push({ command: "layout.select", args: { stack: "panel-body", child: active.id } });
  return result;
}
