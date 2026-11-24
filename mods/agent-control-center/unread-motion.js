export function motionMode(value) {
  return ['none', 'fade', 'slide', 'highlight'].includes(value) ? value : 'highlight';
}
export function newlyPresented(previous, current) {
  if (!Array.isArray(previous)) return [];
  const known = new Set(previous);
  return current.filter(key => !known.has(key));
}
export function cardMotion(mode, phase) {
  const entering = phase === 'enter';
  return { opacity: entering && ['fade', 'slide'].includes(mode) ? 0 : 1,
    offset: entering && mode === 'slide' ? 28 : 0,
    highlight: Boolean(phase && mode === 'highlight') };
}
