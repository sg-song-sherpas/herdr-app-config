// Card colors express how to read a response, never summarizer availability.
const clean = (value, limit = 180) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const priorities = new Set(['decision', 'impact', 'routine']);
const contexts = new Set(['small', 'medium', 'large']);

export function unreadCardValue(terminal, entry, identityKey, responseState) {
  const unknown = { priority: 'unknown', context: 'unknown', reason: '', action: '', evidence: '', label: '', contextLabel: '', rank: 3 };
  if (responseState !== 'ready' || !identityKey || entry?.identityKey !== identityKey ||
      !Number.isInteger(terminal?.turn) || terminal.turn !== entry?.turn) return unknown;
  const analysis = entry?.analysis;
  if (!analysis || !priorities.has(analysis.priority)) return unknown;
  const reason = clean(analysis.reason), evidence = clean(analysis.evidence, 300);
  // An importance claim must carry source evidence and a readable explanation.
  if (!reason || !evidence) return unknown;
  const priority = analysis.priority;
  const context = contexts.has(analysis.context) ? analysis.context : 'unknown';
  return { priority, context, reason, evidence, action: clean(analysis.action),
    label: { decision: '판단 필요', impact: '영향 확인', routine: '결과 확인' }[priority],
    contextLabel: { small: '간단한 문맥', medium: '흐름 확인', large: '넓은 문맥' }[context] ?? '',
    rank: { decision: 0, impact: 1, routine: 2 }[priority] };
}

export function unreadCardStyle(priority, dark = true) {
  const tone = priorities.has(priority) ? priority : 'unknown';
  const colors = dark ? {
    decision: { bg: '#292929', hover: '#353535', border: '#6d5935', accent: '#ebcc91' },
    impact: { bg: '#292929', hover: '#353535', border: '#405e86', accent: '#b5d1ff' },
    routine: { bg: '#292929', hover: '#353535', border: '#606060', accent: '#ededed' },
    unknown: { bg: '#292929', hover: '#353535', border: '#606060', accent: '#ededed' },
  } : {
    decision: { bg: '#fff6e8', hover: '#ffedcf', border: '#bea16d', accent: '#78561b' },
    impact: { bg: '#eff5ff', hover: '#e1edff', border: '#87a5cf', accent: '#2c528b' },
    routine: { bg: '#f4f6f9', hover: '#e8edf4', border: '#a1acbc', accent: '#46566d' },
    unknown: { bg: '#f4f6f9', hover: '#e8edf4', border: '#a1acbc', accent: '#46566d' },
  };
  return { ...colors[tone], tone };
}
