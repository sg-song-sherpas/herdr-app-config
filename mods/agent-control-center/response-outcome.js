const outcomes = {
  completed: '응답 완료',
  failed: '실패 · 원문 확인',
  attention: '판단 또는 입력 필요',
  working: '응답 작성 중',
  neutral: '응답 확인 중',
};

// Classify the latest report, never an old test log or the summarizer's error.
function unresolvedFailure(text) {
  const failures = [...text.matchAll(/(?:실패했|실패합니다|실패한 상태|실패로|완료하지 못|해결하지 못|실행하지 못|could not complete|unable to complete|\bfailed\b)/gi)];
  if (!failures.length) return false;
  const resolved = [...text.matchAll(/(?:모두 통과|전체.{0,8}통과|재실행.{0,15}통과|해결했습니다|고쳤습니다|성공했습니다|\ball (?:tests|checks) passed\b)/gi)];
  return (failures.at(-1)?.index ?? -1) > (resolved.at(-1)?.index ?? -1);
}

export function responseOutcome(terminal, entry, identityKey, presentation, localReport = '') {
  let kind = 'neutral';
  const current = Boolean(identityKey && entry?.identityKey === identityKey &&
    Number.isInteger(terminal?.turn) && terminal.turn === entry?.turn && entry?.state === 'ready');
  if (terminal?.status === 'working') kind = 'working';
  else if (terminal?.status === 'error') kind = 'failed';
  else if (terminal?.status === 'blocked') kind = 'attention';
  else if (terminal && ['done', 'idle'].includes(terminal.status)) {
    const report = current ? entry.summary : localReport;
    const text = typeof report === 'string' ? report.slice(0, 1000) : '';
    if (unresolvedFailure(text)) kind = 'failed';
    else if (current && entry.analysis?.priority === 'decision' && entry.analysis?.evidence) kind = 'attention';
    else if (/(?:승인|결정|입력|선택).{0,15}(?:필요합니다|해 주세요|해주세요)|(?:작업|배포|구현).{0,12}(?:보류|차단|미완료)/.test(text)) kind = 'attention';
    else if (terminal.status === 'done' || current ||
      presentation?.state === 'previous' || text && !text.includes('최근 응답은 원문 터미널에서 확인')) kind = 'completed';
  }
  return { kind, label: outcomes[kind] };
}

export function responseOutcomePalette(kind, dark = true) {
  const colors = dark ? {
    completed: { card: '#12251a', hover: '#193123', border: '#356d50', accent: '#7fe0a5', accentText: '#10251a', orbOuter: '#234631', chipBg: '#244332', chipText: '#b6ecc8', text: '#eefcf2', muted: '#b0cab8' },
    failed: { card: '#2b1719', hover: '#3a2024', border: '#81434b', accent: '#ff969f', accentText: '#331316', orbOuter: '#55292f', chipBg: '#4a272d', chipText: '#ffc7cb', text: '#fff2f3', muted: '#dfb2b7' },
    attention: { card: '#292215', hover: '#39301e', border: '#75603a', accent: '#e9c679', accentText: '#2b210d', orbOuter: '#4b3e23', chipBg: '#493b21', chipText: '#f2d9a5', text: '#fff8e8', muted: '#d1c1a2' },
    working: { card: '#171e28', hover: '#202c3b', border: '#344158', accent: '#87aaff', accentText: '#0d1a32', orbOuter: '#24344f', chipBg: '#243650', chipText: '#bbd0ff', text: '#f0f5ff', muted: '#adbbd0' },
    neutral: { card: '#1b1d21', hover: '#262a30', border: '#434951', accent: '#c0c9d5', accentText: '#1b222c', orbOuter: '#343c47', chipBg: '#333b46', chipText: '#dce2eb', text: '#f2f4f8', muted: '#b7bfcb' },
  } : {
    completed: { card: '#effaf2', hover: '#e1f3e6', border: '#8db79b', accent: '#287345', accentText: '#ffffff', orbOuter: '#d2e9d9', chipBg: '#d9efdf', chipText: '#285b39', text: '#193c26', muted: '#48624f' },
    failed: { card: '#fff1f2', hover: '#ffe2e5', border: '#d79ba2', accent: '#b53043', accentText: '#ffffff', orbOuter: '#f3d3d8', chipBg: '#f7dade', chipText: '#8a2737', text: '#4c2027', muted: '#79545a' },
    attention: { card: '#fff8e9', hover: '#fff0d1', border: '#c3a66c', accent: '#8a6018', accentText: '#ffffff', orbOuter: '#f1e2bd', chipBg: '#f6e6bf', chipText: '#795213', text: '#493711', muted: '#6f5c38' },
    working: { card: '#f2f6ff', hover: '#e5edff', border: '#becdeb', accent: '#2d58ca', accentText: '#ffffff', orbOuter: '#e0e8ff', chipBg: '#e7efff', chipText: '#24478e', text: '#162641', muted: '#4e627d' },
    neutral: { card: '#f5f6f8', hover: '#e9edf2', border: '#a8b1bd', accent: '#516175', accentText: '#ffffff', orbOuter: '#dfe4ec', chipBg: '#e3e8f0', chipText: '#40516a', text: '#273445', muted: '#5e6876' },
  };
  return colors[kind] ?? colors.neutral;
}
