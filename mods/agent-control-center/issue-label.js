// Presentation only: source names, search values, and rename input stay unchanged.
export function issueLabel(name) {
  const full = typeof name === 'string' ? name : '';
  const match = /^\s*(?:\[(PRD-\d+)\]|\((PRD-\d+)\)|(PRD-\d+))(?=$|[\s:·|—–-])[\s:·|—–-]*(.*)$/iu.exec(full);
  if (!match || !match[4]?.trim()) return { title: full, issueId: null, full };
  return { title: match[4].trim(), issueId: (match[1] || match[2] || match[3]).toUpperCase(), full };
}
