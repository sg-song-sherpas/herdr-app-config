import { nestSpaces, siblingEndTarget } from './hierarchy.js';
import { backlogChange } from './backlog.js';

// Range selection follows rendered space rows, excluding agents and folded groups.
export function pickSelection(state, id, visible, { toggle = false, range = false } = {}) {
  const live = new Set(visible);
  const selected = new Set((state.ids ?? []).filter(id => live.has(id)));
  if (!live.has(id)) return { ids: [...selected], anchor: state.anchor };
  const anchor = live.has(state.anchor) ? state.anchor : id;
  if (range) {
    const a = visible.indexOf(anchor), b = visible.indexOf(id);
    const interval = new Set(visible.slice(Math.min(a, b), Math.max(a, b) + 1));
    return { ids: visible.filter(key => interval.has(key) || (toggle && selected.has(key))), anchor };
  }
  if (toggle) {
    selected.has(id) ? selected.delete(id) : selected.add(id);
    return { ids: visible.filter(key => selected.has(key)), anchor: id };
  }
  return { ids: [id], anchor: id };
}

export function selectionRoots(rows, ids) {
  const selected = new Set(ids), roots = [];
  let covered = null;
  for (const row of rows) {
    if (covered !== null && row.depth <= covered) covered = null;
    if (selected.has(row.w.id) && covered === null) {
      roots.push(row);
      covered = row.depth;
    }
  }
  return roots;
}

function selectionBlock(rows, roots) {
  const ids = new Set(roots.map(row => row.w.id)), block = [];
  let depth = null;
  for (const row of rows) {
    if (depth !== null && row.depth <= depth) depth = null;
    if (ids.has(row.w.id)) depth = row.depth;
    if (depth !== null) block.push(row);
  }
  return block;
}

export function selectionMembers(rows, ids) {
  return new Set(selectionBlock(rows, selectionRoots(rows, ids)).map(row => row.w.id));
}

export function orderMoves(current, target) {
  const order = [...current], moves = [];
  for (let i = 0; i < target.length; i++) {
    const at = order.indexOf(target[i]);
    if (at < 0) throw new Error('Space order changed during the move.');
    if (at === i) continue;
    moves.push({ id: target[i], index: i + 1 });
    order.splice(i, 0, order.splice(at, 1)[0]);
  }
  return moves;
}

// Validate the entire selection before changing parents or native order.
export function selectionDropPlan(list, parents, ids, over, zone, excluded = new Set()) {
  if (!['before', 'inside', 'after'].includes(zone)) return null;
  const unique = [...new Set(ids)], rows = nestSpaces(list, parents);
  const byId = new Map(rows.map(row => [row.w.id, row]));
  if (!unique.length || unique.some(id => !byId.has(id) || excluded.has(id)) || excluded.has(over)) return null;
  const roots = selectionRoots(rows, unique);
  const block = selectionBlock(rows, roots);
  const members = new Set(block.map(row => row.w.id));
  if (members.has(over)) return null;
  // Hidden archived descendants must not silently leave Backlog with a parent.
  if ([...members].some(id => excluded.has(id))) return null;
  const target = byId.get(over);
  if (!target?.w.folder || roots.some(row => !row.w.folder
      || (row.w.machine ?? null) !== (target.w.machine ?? null))) return null;
  const parent = zone === 'inside' ? target : byId.get(target.parentId);
  const normalize = path => /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : path.replace(/\/+$/, '') || '/';
  const identity = (machine, path) => JSON.stringify([machine ?? null, normalize(path)]);
  if (parent && roots.some(row => normalize(row.w.folder) === normalize(parent.w.folder))) return null;
  const sourceKeys = new Set(roots.map(row => identity(row.w.machine, row.w.folder)));
  const next = { ...parents };
  // Scan the registry once for the whole batch, including legacy Windows keys.
  for (const raw of Object.keys(next)) {
    let machine = null, path = raw;
    try { const key = JSON.parse(raw); if (Array.isArray(key) && key.length === 2) [machine, path] = key; } catch {}
    if (typeof path === 'string' && sourceKeys.has(identity(machine, path))) delete next[raw];
  }
  for (const { w } of roots) {
    const key = w.machine ? JSON.stringify([w.machine, w.folder]) : w.folder;
    next[key] = parent ? { machine: parent.w.machine ?? null, path: parent.w.folder } : null;
  }
  const remaining = rows.filter(row => !members.has(row.w.id));
  const at = remaining.findIndex(row => row.w.id === over);
  if (at < 0) return null;
  let insert = at;
  if (zone !== 'before') {
    insert++;
    while (insert < remaining.length && remaining[insert].depth > remaining[at].depth) insert++;
  }
  const order = [...remaining.slice(0, insert), ...block, ...remaining.slice(insert)].map(row => row.w.id);
  return { parents: next, order, roots: roots.map(row => row.w.id), members };
}

export function selectionEndTarget(rows, ids, excluded = new Set()) {
  const roots = selectionRoots(rows, ids);
  if (!roots.length || roots.some(row => row.parentId !== roots[0].parentId
      || (row.w.machine ?? null) !== (roots[0].w.machine ?? null))) return null;
  if (roots.some(row => excluded.has(row.w.id))) return null;
  return siblingEndTarget(rows, roots[0].w.id, new Set([...excluded, ...selectionMembers(rows, ids)]
    .filter(id => id !== roots[0].w.id)));
}

export function selectionBacklogChange(rows, entries, ids, archived) {
  const roots = selectionRoots(rows, ids);
  if (!roots.length) return null;
  let next = entries;
  const before = {}, after = {};
  for (const row of roots) {
    const change = backlogChange(rows, next, row.w.id, archived);
    for (const [key, value] of Object.entries(change.before)) if (!(key in before)) before[key] = value;
    Object.assign(after, change.after);
    next = change.entries;
  }
  return { entries: next, before, after, count: Object.keys(after).length,
    name: roots.length === 1 ? roots[0].w.name : `${roots.length}개 워크트리` };
}
