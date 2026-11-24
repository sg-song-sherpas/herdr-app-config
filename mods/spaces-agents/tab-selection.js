import { spaces, panes, agents, shared, setShared, run, openOverlay, window } from 'herdr';
import { tabEntries, tabStarred, tabStarTier, blueStarChange, rememberTabStars, pickTabs, tabDropPlan, tabEndPlan, activeTabContext } from './tab-items.js';
export const TAB_SELECTION_KEY = 'tabs.selection';

export class TabSelection {
  constructor(owner) { this.owner=owner;this.cancel();this.ids=new Set();this.anchor=null; }
  sync(allSpaces) {
    const tabStars = shared('tabs.starred') ?? {};
    const saved = rememberTabStars(agents(), shared('agents.starred') ?? {}, tabStars, shared('agents.autoStarKnown') ?? {});
    if (saved !== tabStars) setShared('tabs.starred', saved);
    const active=activeTabContext(allSpaces);
    if(this.activeContext!==undefined && this.activeContext!==active)this.cancel();
    this.activeContext=active;
    let state=shared(TAB_SELECTION_KEY)??{};
    // Stamp selections with their context so a delayed sidebar render cannot
    // erase a new selection that was already made in the newly active tab.
    if(state.active!==undefined && state.active!==active) {
      this.clear();state=shared(TAB_SELECTION_KEY)??{};
    }
    const live=new Set(allSpaces.flatMap(space=>space.tabs.map(tab=>tab.id)));
    const ids=(Array.isArray(state.ids)?state.ids:[]).filter(id=>live.has(id));
    if(this.pressed!==null&&!live.has(this.pressed))this.cancel();
    this.ids=new Set(ids);this.anchor=live.has(state.anchor)?state.anchor:null;
    if(ids.length!==(state.ids?.length??0) || state.active===undefined)this.set(ids,this.anchor);
  }
  set(ids,anchor=this.anchor) { this.ids=new Set(ids);this.anchor=anchor;setShared(TAB_SELECTION_KEY,{ids:[...this.ids],anchor,active:activeTabContext(spaces())}); }
  clear() { this.set([],null);this.cancel(); }
  cancel() { this.pressed=null;this.dragging=false;this.over=null;this.after=null;this.dragIds=[];this.start=null; }
  down(id,event,visible,cx) {
    cx.stop_propagation();
    this.sync(spaces());
    const mod=event.modifiers??{},toggle=mod.platform||(window()?.platform!=='macos'&&mod.control),range=mod.shift;
    this.navigate=!toggle&&!range;
    if(toggle||range||!this.ids.has(id)) {
      const state=pickTabs({ids:[...this.ids],anchor:this.anchor},id,visible,{toggle,range});
      this.set(state.ids,state.anchor);
    }
    this.pressed=this.ids.has(id)?id:null;this.start=event.position;this.dragging=false;this.over=null;
    this.dragIds=visible.filter(id=>this.ids.has(id));cx.notify();
  }
  markDragging(event) {
    if(this.pressed!==null && this.start && Math.hypot(event.position.x-this.start.x,event.position.y-this.start.y)>=4)this.dragging=true;
  }
  hover(id,event,axis,cx) {
    if(this.pressed===null)return;
    cx.stop_propagation();
    this.markDragging(event);
    if(!this.dragging)return;
    const local=event.local_position, bounds=event.bounds;
    const after=Boolean(local&&bounds&&(axis==='x'?local.x>bounds.width/2:local.y>bounds.height/2));
    const plan=tabDropPlan(spaces(),this.dragIds,id,after);
    const target=plan?id:null;
    if(this.over!==target||this.after!==after){this.over=target;this.after=after;cx.notify();}
  }
  outside(event,cx) {
    if(this.pressed===null)return;
    const wasDragging=this.dragging;
    this.markDragging(event);
    if(this.over!==null||this.dragging!==wasDragging){this.over=null;cx.notify();}
  }
  up(id,event,axis,cx) {
    this.sync(spaces());
    if(this.pressed===null)return;
    cx.stop_propagation();
    this.markDragging(event);
    const click=this.pressed===id&&!this.dragging;
    if(this.dragging) {
      const local=event.local_position,bounds=event.bounds;
      const after=Boolean(local&&bounds&&(axis==='x'?local.x>bounds.width/2:local.y>bounds.height/2));
      const plan=tabDropPlan(spaces(),this.dragIds,id,after);
      if(plan)for(const args of plan.moves)run('tab.move',args);
    } else if(click&&this.navigate) {this.set([id],id);run('tab.select',{id});}
    this.cancel();cx.notify();
  }
  hoverEnd(spaceId,event,cx) {
    if(this.pressed===null)return;
    cx.stop_propagation();this.markDragging(event);
    if(!this.dragging)return;
    const target=tabEndPlan(spaces(),this.dragIds,spaceId)?`end:${spaceId}`:null;
    if(this.over!==target||!this.after){this.over=target;this.after=true;cx.notify();}
  }
  upEnd(spaceId,event,cx) {
    this.sync(spaces());
    if(this.pressed===null)return;
    cx.stop_propagation();this.markDragging(event);
    const plan=this.dragging?tabEndPlan(spaces(),this.dragIds,spaceId):null;
    if(plan)for(const args of plan.moves)run('tab.move',args);
    this.cancel();cx.notify();
  }
  menu(id,cx,single) {
    this.sync(spaces());if(!this.ids.has(id))this.set([id],id);
    if(this.ids.size>1)this.open();else single();cx.notify();
  }
  open() {openOverlay({mod:'tab-selection',kind:'popup',width:282,height:172,props:{ids:[...this.ids],owner:this.owner}});}
  starred(entries,on) {
    const agentStars={...(shared('agents.starred')??{})},tabStars={...(shared('tabs.starred')??{})};
    let agentChanged=false,tabChanged=false;
    let blueStars=shared('tabs.blueStarred')??{};
    for(const entry of entries) {
      tabStars[entry.tab.id]=on;tabChanged=true;
      if(!on)blueStars=blueStarChange(blueStars,entry.tab.id,false);
      if(entry.agents.length) {
        for(const agent of entry.agents){if(on)agentStars[agent.address]=true;else delete agentStars[agent.address];}
        agentChanged=true;
      }
    }
    if(agentChanged)setShared('agents.starred',agentStars);
    if(tabChanged)setShared('tabs.starred',tabStars);
    if(!on && tabChanged)setShared('tabs.blueStarred',blueStars);
  }
  toggleBlue(entry) {
    const blueStars=shared('tabs.blueStarred')??{};
    const blue=tabStarTier(entry,shared('agents.starred'),shared('tabs.starred'),blueStars)!=='blue';
    this.starred([entry],true);
    setShared('tabs.blueStarred',blueStarChange(blueStars,entry.tab.id,blue));
  }
  toggle(entry) {this.starred([entry],!tabStarred(entry,shared('agents.starred'),shared('tabs.starred')));}
  command(command,cx) {
    const split=command.indexOf(':');if(split<0)return;
    const action=command.slice(0,split);let ids;
    try{ids=JSON.parse(command.slice(split+1));}catch{return;}
    if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'))return;
    const all=spaces();this.sync(all);
    const selected=new Set(ids),entries=tabEntries(all,panes(),agents()).filter(entry=>selected.has(entry.tab.id));
    if(action==='close') {
      for(const entry of entries)run('tab.close',{id:entry.tab.id,confirmed:true});
      this.set([...this.ids].filter(id=>!selected.has(id)));cx.notify();
    } else if(action==='star'||action==='unstar')this.starred(entries,action==='star');
  }
}
