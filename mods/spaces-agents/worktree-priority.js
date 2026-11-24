// Manual worktree importance is local UI state, independent of AI analysis.
export const PRIORITY_KEY = 'acc.worktree-priorities';
const levels = ['low', 'normal', 'high'];
export function worktreeKey(space) {
  if (!space || !space.id) return null;
  const folder = typeof space.folder === 'string' ? space.folder.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '/' : null;
  return JSON.stringify([space.machine || null, folder ? 'folder' : 'space', folder || space.id]);
}
export function worktreePriority(entries, space) {
  const value = entries?.[worktreeKey(space)]?.level;
  return levels.includes(value) ? value : 'normal';
}
export function cycleWorktreePriority(entries, space) {
  const key = worktreeKey(space);
  if (!key) return entries ?? {};
  const level = levels[(levels.indexOf(worktreePriority(entries, space)) + 1) % levels.length];
  return { ...(entries ?? {}), [key]: { level, folder: space.folder ?? null, machine: space.machine ?? null, updatedAt: Date.now() } };
}
export function priorityStyle(level, dark = true) {
  level = levels.includes(level) ? level : 'normal';
  const colors = dark ? {
    low: { bg: '#272727', hover: '#323232', border: '#535353', accent: '#b3b3b3' },
    normal: { bg: '#252d38', hover: '#303c4d', border: '#607ea8', accent: '#bad4ff' },
    high: { bg: '#3b2b30', hover: '#4b343b', border: '#b57886', accent: '#ffc3d0' },
  } : {
    low: { bg: '#f4f4f4', hover: '#e8e8e8', border: '#acacac', accent: '#606060' },
    normal: { bg: '#eff5ff', hover: '#e1edff', border: '#87a5cf', accent: '#2c528b' },
    high: { bg: '#fff0f3', hover: '#ffe0e8', border: '#c48c9a', accent: '#8d304c' },
  };
  return { ...colors[level], level, label: {low:'낮음',normal:'보통',high:'높음'}[level], icon:`priority-${level}.svg` };
}
