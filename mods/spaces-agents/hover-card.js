import {div,svg} from 'gpui-kit';
import {v_flex,h_flex} from 'gpui-base';
import {openOverlay,shared,setShared} from 'herdr';
import {HOVER_CARD_LEASE,dismissHoverOverlay} from './hover-card-lifecycle.js';
import {insideHover,hoverCardGeometry,hoverIssueBadge} from './hover-card-data.js';
import {priorityStyle} from './worktree-priority.js';
import {theme} from 'herdr';
export class HoverCards {
 constructor(){this.epoch=0;this.id=null;this.key=null;}
 cancel(name){this[name]?.cancel();this[name]=null;}
 dismiss(){
  this.epoch++;
  this.cancel('openTask');this.cancel('closeTask');
  const id=this.id;this.id=null;this.box=null;this.key=null;
  if(id)dismissHoverOverlay(id);
 }
 enter(key,data,anchorOf,cx,valid=()=>true,guard=null){
  this.dismiss();const epoch=this.epoch;this.key=key;
  this.openTask=cx.timer.after(380,()=>{
   if(this.epoch!==epoch)return;
   this.openTask=null;
   const native=globalThis.window,anchor=anchorOf();
   if(!anchor||!valid()||!native.is_window_active()||!insideHover(native.mouse_position(),anchor))return;
   const previous=shared(HOVER_CARD_LEASE)?.id;
   if(previous)dismissHoverOverlay(previous);
   const box=hoverCardGeometry(native.viewport_size(),anchor,data);
   this.box=box;
   this.id=openOverlay({mod:'spaces-agents',kind:'window',frame:'none',width:box.width,height:box.height,
    at:{x:box.x,y:box.y},props:{role:'hover-card',data,anchor:{...anchor},box,guard}});
   setShared(HOVER_CARD_LEASE,{id:this.id});
  });
 }
 leave(key,cx){
  if(this.key!==key)return;
  this.epoch++;this.cancel('openTask');this.cancel('closeTask');
  const id=this.id;
  if(!id){this.key=null;return;}
  this.closeTask=cx.timer.after(140,()=>{
   if(this.id!==id)return;
   this.closeTask=null;
   if(!insideHover(globalThis.window.mouse_position(),this.box))this.dismiss();
  });
 }
 outsidePress(point){if(!insideHover(point,this.box))this.dismiss();}
}
export function renderHoverCard(data,dark,layout,handlers={}) {
 const c=dark?{bg:'#15171b',border:'#393d46',text:'#f3f4f7',muted:'#9ca4b2',badge:'#242e40',accent:'#b5ceff',memo:'#1e2127',line:'#303640'}:
 {bg:'#ffffff',border:'#d5dce7',text:'#1c2533',muted:'#647187',badge:'#e8efff',accent:'#375c9c',memo:'#f4f6fa',line:'#dbe1ea'};
 const box=layout||hoverCardGeometry(globalThis.window.viewport_size(),{x:0,y:0,width:0,height:0},data);
 const t=theme(),details=data.details||{},priority=priorityStyle(details.priority,dark);
 const issueBadge=hoverIssueBadge(data);
 const stop=(_event,cx)=>cx.stop_propagation();
 const colors={failure:t.ansi1,review:t.ansi4,draft:c.muted,merged:'#9333ea',deployed:t.ansi2,closed:t.ansi1};
 const stateLabel={working:'작업 중',blocked:'입력 필요',done:'미확인 완료',idle:'대기'}[details.status];
 const stateColor={working:t.working,blocked:t.blocked,done:t.done,idle:c.muted}[details.status]||c.muted;
 let card=v_flex().id('tab-hover-card').size_full().p(16).gap(12).rounded(14).border(1).border_color(c.border).bg(c.bg).shadow_xl()
  .on_mouse_down('left',stop).on_mouse_down('right',stop)
  .child(div().flex_none().text_size(17).line_height('25px').font_semibold().text_color(c.text).child(box.titleLines.join('\n')));
 if(data.details||issueBadge){
  let header=h_flex().h(26).flex_none().gap(9).items_center();
  if(details.starTier)header=header.child(div().size(18).flex_none().tooltip({blue:'파란별',yellow:'즐겨찾기',none:'별 없음'}[details.starTier])
   .child(svg(`mods/spaces-agents/${details.starTier==='none'?'star':'star-filled'}.svg`).size(15).text_color(details.starTier==='blue'?t.ansi4:details.starTier==='yellow'?t.ansi3:c.muted)));
  if(data.details)header=header.child(div().size(18).flex_none().tooltip(`우선순위: ${priority.label}`).child(svg(`mods/spaces-agents/${priority.icon}`).size(15).text_color(priority.accent)));
  if(details.pull){
   let pr=div().size(18).flex_none().relative().tooltip(details.pull.label).child(svg(`mods/spaces-agents/status-${details.pull.state||'unknown'}.svg`).size(18).text_color(colors[details.pull.state]||c.muted));
   if(details.pull.failed>0)pr=pr.child(div().absolute().right(-2).bottom(-2).size(8).rounded(4).bg(t.ansi1).text_color(t.canvas).text_size(7).line_height('8px').child('×'));
   header=header.child(pr);
  }
  if(details.counts)header=header.child(div().flex_none().h(18).px(5).rounded(5).bg(t.raised).border(1).border_color(t.border).text_size(10.5).text_color(details.counts.working?t.working:t.dim)
   .tooltip(`수행 중 ${details.counts.working} / 전체 ${details.counts.total} · 하위 워크트리 포함`).child(`${details.counts.working}/${details.counts.total}`));
  if(stateLabel){
   const status=details.status==='working'?svg('mods/workspace-chrome/spinner.svg').size(12).text_color(stateColor).spin(900):div().size(6).rounded(3).bg(stateColor);
   header=header.child(div().size(16).flex_none().flex().items_center().justify_center().tooltip(stateLabel).child(status));
  }
  if(details.fast)header=header.child(div().text_size(12).font_weight(700).text_color('#a78bfa').tooltip('Fast mode').child('F'));
  header=header.child(div().flex_1());
  if(issueBadge)header=header.child(h_flex().px(8).h(22).gap(5).rounded(6).bg(c.badge).items_center().child(div().text_size(12).text_color(c.accent).child('◇')).child(div().text_size(12).font_semibold().text_color(c.accent).child(issueBadge)));
  card=card.child(header);
 }
 if(box.detailRows.length){
  let rows=v_flex().flex_none().gap(7).pt(12).border_t(1).border_color(c.line);
  for(const [i,row] of box.detailRows.entries()){
   let value=h_flex().flex_1().min_w(0).gap(8).child(div().flex_1().min_w(0).text_size(13).line_height('20px').text_color(colors[row.tone]||c.text).child(row.lines.join('\n')));
   if(row.diff){
    let diff=h_flex().h(20).flex_none().gap(6).items_center().text_size(12);
    if(row.diff.state==='ready'){
     diff=diff.child(div().text_color(t.ansi2).child(`+${row.diff.added}`)).child(div().text_color(t.ansi1).child(`−${row.diff.deleted}`));
     if(row.diff.binary)diff=diff.child(div().text_color(c.muted).child(`◇ ${row.diff.binary}`));
     diff=diff.tooltip(`${row.diff.reference==='refs/remotes/origin/main'?'origin/main':'main'} 분기점 대비 · 추적 파일의 미커밋 변경 포함 · 미추적 파일 제외`);
    }else diff=diff.child(div().text_color(c.muted).child('Unknown')).tooltip(row.diff.reason||'main 대비 변경 확인 불가');
    value=value.child(diff);
   }
   rows=rows.child(h_flex().id(`hover-detail-${i}`).flex_none().gap(8).child(div().w(92).flex_none().text_size(12).line_height('20px').text_color(c.muted).child(row.label)).child(value));
  }
  card=card.child(rows);
 }
 if(data.note)card=card.child(v_flex().flex_none().gap(9).pt(12).border_t(1).border_color(c.line)
  .child(h_flex().h(16).flex_none().gap(7).items_center().text_color(c.muted).child(svg('mods/spaces-agents/note.svg').size(14)).child(div().text_size(12).font_semibold().child('내 메모')))
  .child(div().id('tab-hover-note').flex_none().p(12).rounded(8).bg(c.memo).child(div().flex_none().text_size(14).line_height('21px').text_color(c.text).child(box.noteLines.join('\n')))));
 if(handlers.hover)card=card.on_hover(handlers.hover);
 if(handlers.outside)card=card.on_mouse_down_out(handlers.outside);
 return card;
}
