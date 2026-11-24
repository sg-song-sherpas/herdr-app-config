import {issueLabel} from './issue-label.js';
export function hoverCardData(name,tabId,machine,notes={},fallbackName='') {
 const label=issueLabel(name),fallback=issueLabel(fallbackName);
 const text=notes?.[JSON.stringify([machine||null,tabId])]?.text;
 return {title:label.title,issueId:label.issueId||fallback.issueId,note:typeof tabId==='string'&&typeof text==='string'?text.trim():''};
}
export function insideHover(point,box) {
 return Boolean(point&&box&&point.x>=box.x&&point.x<=box.x+box.width&&point.y>=box.y&&point.y<=box.y+box.height);
}
export function hoverCardGeometry(viewport,anchor,data) {
 const maxWidth=Math.max(220,viewport.width-24);
 let width=Math.min(420,maxWidth),layout;
 const rows=hoverDetailsRows(data.details);
 do {
  const titleLines=cardTextLines(data.title,width-32,17);
  const noteLines=data.note?cardTextLines(data.note,width-56):[];
  const detailRows=rows.map(row=>({...row,lines:cardTextLines(row.value,width-140-(row.diff?100:0),13)}));
  const height=32+titleLines.length*25+(data.details||data.issueId?38:0)
   +(detailRows.length?24+detailRows.reduce((n,row)=>n+row.lines.length*20+7,0):0)
   +(noteLines.length?74+noteLines.length*21:0);
  layout={width,height,titleLines,noteLines,detailRows};
  if(height<=viewport.height-24||width>=maxWidth)break;
  width=Math.min(maxWidth,width+160);
 } while(true);
 const right=anchor.x+anchor.width+10;
 const x=right+width<=viewport.width-12?right:Math.max(12,Math.min(anchor.x-width-10,viewport.width-width-12));
 return {...layout,x,y:Math.max(12,Math.min(anchor.y,viewport.height-layout.height-12))};
}
// Conservatively wrap before rendering so auto-sized windows include every line.
export function cardTextLines(value,width,font=14) {
 const result=[];
 for(const original of String(value??'').split(/\r?\n/)){
  let line='',used=0;
  for(const ch of original){
   const size=/[\u0000-\u007f]/.test(ch)?(ch==='\t'?font*2.4:font*0.65):font*1.08;
   if(line&&used+size>width){result.push(line);line='';used=0;}
   line+=ch;used+=size;
  }
  result.push(line);
 }
 return result;
}
export function hoverDetailsRows(details={}) {
 const rows=[];
 if(details.git?.branch)rows.push({label:'브랜치',value:details.git.branch,diff:details.git.mainDiff});
 if(details.machine)rows.push({label:'머신',value:details.machine});
 if(details.archived)rows.push({label:'보관 상태',value:'Backlog'});
 if(details.move)rows.push({label:'이동 상태',value:details.move.error||details.move.phase,tone:details.move.error?'failure':null});
 return rows;
}

export function hoverIssueBadge(data) {
 const pull=data.details?.pull;
 const match=/\bPR #(\d+)\b/.exec(pull?.label||'');
 const number=Number.isSafeInteger(pull?.number)&&pull.number>0?pull.number:match?Number(match[1]):null;
 return [data.issueId,number?`PR #${number}`:null].filter(Boolean).join(' · ');
}
