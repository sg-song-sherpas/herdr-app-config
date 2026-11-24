import {div,svg} from 'gpui-kit';
import {h_flex,v_flex} from 'gpui-base';
import {notePreview} from './tab-notes.js';
// A completion is one glance: title, current response summary, personal note.
export function renderUnreadCard({address,label,text,note,value,style,motion,colors,dark,noteButton,onOpen}) {
 const border=dark?'#42464e':'#cdd5e1';
 const muted=dark?'#bac0cb':'#536173';
 const foreground=dark?'#f5f6f8':colors.text;
 let card=v_flex().id(`acc-completed-${address}`).w_full().flex_none().px(15).py(13).gap(10).relative()
  .left(motion.offset).opacity(motion.opacity)
  .transition('left',{duration:320,easing:'ease-out'})
  .transition('opacity',{duration:320,easing:'ease-out'})
  .bg(motion.highlight?(dark?'#343941':'#ffffff'):style.bg)
  .rounded(10).border(1).border_color(motion.highlight?(dark?'#dce3ef':'#526a8e'):border)
  .cursor_pointer().hover(el=>el.bg(style.hover))
  .on_mouse_down('left',(_event,cx)=>cx.stop_propagation())
  .on_click(onOpen)
  .child(div().absolute().left(0).top(14).bottom(14).w(2).rounded(1).bg(style.accent));
 let header=h_flex().gap(7).items_center()
  .child(div().size(14).flex_none().tooltip(`우선순위: ${style.label}`).child(svg(`mods/agent-control-center/${style.icon}`).size(13).text_color(style.accent)))
  .child(div().flex_1().min_w(0).text_size(15.5).font_semibold().text_color(foreground).truncate().tooltip(label.full).child(label.title));
 if(noteButton)header=header.child(noteButton.size(22));
 card=card.child(header);
 if(text)card=card.child(div().text_size(16.5).line_height('23px').font_medium().text_color(foreground).whitespace_normal().tooltip(text).child(notePreview(text,180)));
 if(note)card=card.child(h_flex().gap(6).items_center()
  .child(svg('mods/agent-control-center/note.svg').size(12).flex_none().text_color(style.accent))
  .child(div().flex_1().min_w(0).text_size(13).text_color(muted).truncate().tooltip(note).child(notePreview(note,90))));
 if(label.issueId||value?.priority==='decision'){
  let footer=h_flex().h(20).gap(7).items_center().text_size(11.5);
  if(label.issueId)footer=footer.child(div().px(6).py(2).rounded(4).bg(dark?'#ffffff0b':'#00000008').text_color(muted).child(label.issueId));
  if(value?.priority==='decision')footer=footer.child(div().px(6).py(2).rounded(4).text_color(style.accent).tooltip([value.reason,value.action].filter(Boolean).join('\n')).child('판단 필요'));
  card=card.child(footer);
 }
 return card;
}
