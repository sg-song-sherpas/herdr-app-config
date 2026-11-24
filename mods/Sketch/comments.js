export const clone = (value) => JSON.parse(JSON.stringify(value));

export function makePopup(shapes = []) {
  return { width: 520, height: 380, shapes: clone(shapes) };
}

export function popupSize(popup) {
  const bounded = (v, fallback, min) => Number.isFinite(v) ? Math.min(4096, Math.max(min, v)) : fallback;
  return { width: bounded(popup?.width, 520, 280), height: bounded(popup?.height, 380, 240) };
}

export function resolveComment(comment, rows) {
  const quote = comment.quote;
  if (!Array.isArray(quote) || !quote.length || quote.length > rows.length) return null;
  const matches = (start) => start >= 0 && start + quote.length <= rows.length && quote.every((line, j) => rows[start + j].text === line);
  if (Number.isInteger(comment.startRow) && matches(comment.startRow)) return [comment.startRow, comment.startRow + quote.length - 1];
  let at = null;
  for (let i = 0; i <= rows.length - quote.length; i++) {
    if (!matches(i)) continue;
    if (at !== null) return null;
    at = i;
  }
  return at === null ? null : [at, at + quote.length - 1];
}

export function rangeLabel(rows, start, end) {
  const a = rows[start]?.next || rows[start]?.old, b = rows[end]?.next || rows[end]?.old;
  return a && b ? (a === b ? `줄 ${a}` : `줄 ${a}–${b}`) : `선택한 ${end - start + 1}줄`;
}

// Images inside popup sketches travel with a board copied to another worktree.
export function* nestedShapes(shapes) {
  for (const s of shapes) {
    yield s;
    if (Array.isArray(s.popup?.shapes)) yield* nestedShapes(s.popup.shapes);
    for (const c of s.comments ?? []) if (Array.isArray(c.popup?.shapes)) yield* nestedShapes(c.popup.shapes);
  }
}
