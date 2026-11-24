// Explicit workspace parents supplement Herdr's Git-repository groups.
// Folder identity survives renames and newly created space IDs.
export function nestSpaces(list, parents = {}) {
  const mains = new Map();
  for (const r of list) if (r.g && !r.g.linked && !mains.has(r.g.repo)) mains.set(r.g.repo, r.w.id);
  const normalize = (path) => {
    if (typeof path !== "string") return path;
    return /^[a-z]:[\\/]|^\\\\/i.test(path)
      ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      : path.replace(/\/+$/, "") || "/";
  };
  const identity = (machine, path) => JSON.stringify([machine ?? null, normalize(path)]);
  const explicitParents = new Map();
  for (const [raw, value] of Object.entries(parents)) {
    let key = identity(null, raw);
    if (raw.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 2) key = identity(parsed[0], parsed[1]);
      } catch { /* A legacy local folder can start with a bracket. */ }
    }
    explicitParents.set(key, value);
  }
  const byFolder = new Map();
  for (const r of list) {
    const key = identity(r.w.machine, r.w.folder);
    if (r.w.folder && !byFolder.has(key)) byFolder.set(key, r.w.id);
  }
  const parentOf = new Map();
  for (const r of list) {
    const inherited = r.g?.linked ? mains.get(r.g.repo) : null;
    const key = identity(r.w.machine, r.w.folder);
    const explicitKey = explicitParents.has(key) ? key : null;
    const value = explicitParents.get(key);
    const parent = typeof value === "string" ? { machine: null, path: value } : value;
    // Machines retain separate headings; cross-machine lineage stays in metadata.
    const explicit = parent && (parent.machine ?? null) === (r.w.machine ?? null)
      ? byFolder.get(identity(parent.machine, parent.path)) : null;
    const target = explicitKey !== null && value === null ? null : explicit && explicit !== r.w.id ? explicit : inherited;
    if (target && target !== r.w.id) parentOf.set(r.w.id, target);
  }
  // Corrupt or hand-edited relationships must never hide spaces or loop.
  for (const r of list) {
    const chain = [], seen = new Set();
    let id = r.w.id;
    while (parentOf.has(id)) {
      if (seen.has(id)) {
        for (const cyclic of chain.slice(chain.indexOf(id))) parentOf.delete(cyclic);
        break;
      }
      seen.add(id); chain.push(id); id = parentOf.get(id);
    }
  }
  const children = new Map();
  for (const r of list) {
    const parent = parentOf.get(r.w.id) ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(r);
  }
  const out = [];
  const append = (parent, depth) => {
    const kids = children.get(parent) ?? [];
    kids.forEach((r, n) => {
      out.push({ ...r, parentId: parent, depth, tree: depth ? n === kids.length - 1 ? "└─" : "├─" : null });
      append(r.w.id, depth + 1);
    });
  };
  append(null, 0);
  return out;
}

// Compute a drop against the full tree, including hidden/folded descendants.
export function dropPlan(list, parents, from, over, zone) {
  const rows = nestSpaces(list, parents);
  const source = rows.find(r => r.w.id === from);
  const target = rows.find(r => r.w.id === over);
  if (!source || !target || from === over || !source.w.folder || !target.w.folder
      || (source.w.machine ?? null) !== (target.w.machine ?? null)) return null;
  const start = rows.indexOf(source);
  const descendants = new Set();
  for (let i = start + 1; i < rows.length && rows[i].depth > source.depth; i++) descendants.add(rows[i].w.id);
  if (descendants.has(over)) return null;
  const parentId = zone === "inside" ? over : target.parentId;
  const parent = rows.find(r => r.w.id === parentId)?.w ?? null;
  const normalize = path => /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
  if (parent && normalize(parent.folder) === normalize(source.w.folder)) return null;
  const next = { ...parents };
  // Remove equivalent legacy/qualified keys, so one identity has one parent.
  for (const raw of Object.keys(next)) {
    let machine = null, path = raw;
    try {
      const key = JSON.parse(raw);
      if (Array.isArray(key) && key.length === 2) [machine, path] = key;
    } catch {}
    if ((machine ?? null) === (source.w.machine ?? null) && typeof path === "string"
        && normalize(path) === normalize(source.w.folder)) delete next[raw];
  }
  const key = source.w.machine ? JSON.stringify([source.w.machine, source.w.folder]) : source.w.folder;
  next[key] = parent ? { machine: parent.machine ?? null, path: parent.folder } : null;
  return { parents: next, parentId, source: source.w, target: target.w };
}

export function dropZone(event) {
  if (!event.local_position || !event.bounds) return "inside";
  const y = event.local_position.y, height = event.bounds.height;
  return y < height * 0.25 ? "before" : y > height * 0.75 ? "after" : "inside";
}

// Empty sidebar space appends within the source's real group, even when a
// favorites filter hides its parent or some siblings. Never change its parent.
export function siblingEndTarget(rows, from, excluded = new Set()) {
  const source = rows.find(r => r.w.id === from);
  if (!source || excluded.has(from)) return null;
  return [...rows].reverse().find(r => r.w.id !== from && r.parentId === source.parentId
    && (r.w.machine ?? null) === (source.w.machine ?? null)
    && !excluded.has(r.w.id))?.w.id ?? null;
}

// Native space.move uses a 1-based index after removing the source. An after
// drop lands after the target's whole subtree, including hidden descendants.
export function dropMoveIndex(list, parents, from, over, zone) {
  if (!dropPlan(list, parents, from, over, zone)) return null;
  const rows = nestSpaces(list, parents);
  const subtree = id => {
    const start = rows.findIndex(r => r.w.id === id);
    let end = start + 1;
    while (end < rows.length && rows[end].depth > rows[start].depth) end++;
    return rows.slice(start, end).map(r => r.w.id);
  };
  const moving = new Set(subtree(from));
  const candidates = zone === "before" ? [over] : subtree(over).filter(id => !moving.has(id));
  const anchor = zone === "before" ? over : candidates.at(-1);
  const order = list.map(r => r.w.id).filter(id => id !== from);
  const at = order.indexOf(anchor);
  return at < 0 ? null : at + (zone === "before" ? 1 : 2);
}

// Keep matching spaces and their ancestors without changing their hierarchy.
// Unmatched sibling subtrees disappear; parents remain as group headings.
export function filterSpaceAncestors(rows, matches) {
  const parents = new Map(), stack = [], kept = new Set();
  for (const row of rows) {
    while (stack.length && stack.at(-1).depth >= row.depth) stack.pop();
    if (stack.length) parents.set(row, stack.at(-1));
    if (matches(row)) kept.add(row);
    stack.push(row);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (kept.has(rows[i]) && parents.has(rows[i])) kept.add(parents.get(rows[i]));
  }
  return rows.filter(row => kept.has(row));
}
