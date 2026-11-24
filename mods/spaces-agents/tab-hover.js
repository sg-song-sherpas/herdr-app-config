import { issueLabel } from './issue-label.js';
// Native hover labels accept text only. Bound width and height at the source.
export function hoverLines(value, width=38) {
  return String(value??'').split(/\r?\n/).map(line=>{
    const chars=[...line];const lines=[];
    for(let i=0;i<chars.length;i+=width)lines.push(chars.slice(i,i+width).join(''));
    return lines.join('\n');
  }).join('\n');
}
export function tabHover(name, tabId, machine, notes={}, fallbackName='') {
  const label=issueLabel(name),fallback=issueLabel(fallbackName);
  const issue=label.issueId||fallback.issueId;
  const parts=[hoverLines(label.title)];
  if(issue)parts.push(`◇  ${issue}`);
  const key=typeof tabId==='string'&&tabId?JSON.stringify([machine||null,tabId]):null;
  const text=key&&notes?.[key]?.text;
  if(typeof text==='string'&&text.trim()){
    const lines=hoverLines(text.trim()).split('\n');
    const preview=lines.slice(0,10).join('\n');
    parts.push(`\n✎  내 메모\n${preview}${lines.length>10?'\n…':''}`);
  }
  return parts.join('\n');
}
