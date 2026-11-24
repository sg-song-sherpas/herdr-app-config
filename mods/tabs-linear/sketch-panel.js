export function sketchPanelTree(tree, space) {
  if (!space) return null;
  const find = node => node?.id === 'sketch-canvas' ? node :
    (node?.children ?? []).map(find).find(Boolean);
  const node = find(tree);
  if (!node || node.content?.mod !== 'Sketch') return null;
  const folder = space.folder ?? null, machine = space.machine ?? null;
  if (node.content.props?.folder === folder && node.content.props?.machine === machine && node.content.props?.panel === true) return null;
  const updated = JSON.parse(JSON.stringify(tree));
  const canvas = find(updated);
  canvas.content.props = { ...(canvas.content.props ?? {}), panel: true, folder, machine };
  return updated;
}
