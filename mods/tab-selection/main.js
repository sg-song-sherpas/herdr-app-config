import { View, div } from 'gpui-kit';
import { v_flex, h_flex } from 'gpui-base';
import { spaces, panes, agents, props, theme, run, closeOverlay, openOverlay } from 'herdr';
import { tabEntries } from './tab-items.js';
export default class TabSelectionMenu extends View {
  init(_props,cx){this.at=0;this.handle=cx.focus_handle();this.handle.focus();}
  targets(){const ids=new Set(props()?.ids??[]);return tabEntries(spaces(),panes(),agents()).filter(entry=>ids.has(entry.tab.id));}
  choose(action){
    const entries=this.targets(),ids=entries.map(entry=>entry.tab.id);if(!ids.length)return;
    const owner=props()?.owner;if(!['spaces-agents','tabs-linear'].includes(owner))return;
    closeOverlay(props()?.overlay);
    const command={name:`${owner}.tabs:${action}:${JSON.stringify(ids)}`};
    if(action!=='close'){run(command.name);return;}
    const selected=new Set(ids),terminals=panes().filter(pane=>selected.has(pane.tab)&&pane.terminal).length;
    const closing=spaces().filter(space=>space.tabs.length&&space.tabs.every(tab=>selected.has(tab.id)));
    openOverlay({mod:'confirm',kind:'dialog',width:480,height:350,props:{title:`${ids.length}개 탭을 닫을까요?`,
      detail:`${entries.map(({name,space})=>`• ${name} · ${space.name}`).join('\n')}\n\n${terminals}개 터미널의 세션을 종료합니다.${closing.length?`\n마지막 탭까지 선택한 ${closing.length}개 작업 공간도 목록에서 닫힙니다.`:''}\nGit 폴더는 유지합니다.`,command}});
  }
  render(cx){
    const t=theme(),items=[['즐겨찾기에 추가','star'],['즐겨찾기 해제','unstar'],['선택한 탭 닫기…','close']];
    return v_flex().id('tab-selection-menu').track_focus(this.handle).w_full().p(6).gap(3).bg(t.popover)
      .on_key_down((e,cx)=>{if(e.key==='escape')closeOverlay(props()?.overlay);else if(e.key==='down'||e.key==='up'){this.at=(this.at+(e.key==='down'?1:2))%3;cx.notify();}else if(e.key==='enter')this.choose(items[this.at][1]);else return;cx.stop_propagation();})
      .child(div().px(8).py(6).text_size(12).text_color(t.muted).child(`${this.targets().length}개 탭 선택됨`))
      .children(items.map(([label,action],i)=>h_flex().id(`tabs-${action}`).h(30).px(8).items_center().rounded(5).text_size(13)
        .text_color(action==='close'?t.blocked:t.foreground).when(this.at===i,el=>el.bg(t.selected)).hover(el=>el.bg(t.hover)).cursor_pointer()
        .on_click(()=>this.choose(action)).child(label)));
  }
}
