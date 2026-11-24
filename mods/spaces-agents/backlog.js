import { filterSpaceAncestors } from "./hierarchy.js";

// Personal list organization only: no terminal, Git, or native layout mutations.
export const BACKLOG_KEY = "spaces.backlog";

export function backlogState(value) {
  const entries = value?.entries;
  return {
    entries: entries && typeof entries === "object" && !Array.isArray(entries)
      ? Object.fromEntries(Object.entries(entries).filter(([, v]) => typeof v === "boolean")) : {},
    expanded: value?.expanded === true,
  };
}

export function backlogIdentity(space) {
  let path = space.folder;
  if (typeof path !== "string" || !path) return JSON.stringify([space.machine ?? null, "id", space.id]);
  path = /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
  return JSON.stringify([space.machine ?? null, "folder", path]);
}

// The input is the complete preorder, before favorites, machine folds or Git loading.
export function backlogPartition(rows, entries = {}) {
  const flags = new Map();
  const stack = [];
  for (const row of rows) {
    while (stack.length && stack.at(-1).depth >= row.depth) stack.pop();
    const own = entries[backlogIdentity(row.w)];
    const archived = typeof own === "boolean" ? own : stack.at(-1)?.archived ?? false;
    flags.set(row.w.id, archived);
    stack.push({ depth: row.depth, archived });
  }
  // Repeat ancestors as context headings in the other list, without moving them.
  const select = archived => filterSpaceAncestors(rows, row => flags.get(row.w.id) === archived)
    .map(row => ({ ...row, contextOnly: flags.get(row.w.id) !== archived }));
  return { active: select(false), archived: select(true), flags };
}

export function backlogSubtree(rows, id) {
  const at = rows.findIndex(row => row.w.id === id);
  if (at < 0) return [];
  let end = at + 1;
  while (end < rows.length && rows[end].depth > rows[at].depth) end++;
  return rows.slice(at, end);
}

export function backlogChange(rows, entries, id, archived) {
  const affected = backlogSubtree(rows, id);
  if (!affected.length) return null;
  const next = { ...entries }, before = {}, after = {};
  for (const row of affected) {
    const key = backlogIdentity(row.w);
    before[key] = entries[key] ?? null;
    next[key] = archived;
    after[key] = archived;
  }
  return { entries: next, before, after, name: affected[0].w.name, count: affected.length };
}

// Revert only this action's keys, and never overwrite a newer choice.
export function backlogUndo(entries, change) {
  const next = { ...entries };
  for (const key of Object.keys(change.after)) {
    if (entries[key] !== change.after[key]) continue;
    if (change.before[key] === null) delete next[key];
    else next[key] = change.before[key];
  }
  return next;
}
