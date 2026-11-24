import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { host } from 'herdr';
import { makeCx, mouse, key } from '../fakes/cx.mjs';
import { byId, text } from '../fakes/element.mjs';
const root = process.env.BACKLOG_MODS || new URL('../../mods', import.meta.url).pathname;
const { default: Sidebar } = await import(pathToFileURL(`${root}/spaces-agents/main.js`));
const { default: Menu } = await import(pathToFileURL(`${root}/menu-linear/main.js`));
const state = () => host.shared['spaces.backlog'];
beforeEach(() => { host.reset(); localStorage.clear(); });
async function setup() {
 host.spaces = ['root','child','grandchild','other'].map((id,i) => ({ id, name: id, folder: '/'+id, machine: null, active:i===3, tabs: [{id:'tab-'+id,name:id}], status:'idle' }));
 host.files.set('/app/data/space-hierarchy/parents.json',JSON.stringify({parents:{'/child':'/root','/grandchild':'/child'}}));
 const cx=makeCx(), view=new Sidebar(); view.init({},cx); await cx.settle(); view.render(); host.runs=[];
 return {view,cx};
}
async function command(h,c) {host.command('backlog:'+c); await h.cx.settle();assert.deepEqual(h.cx.errors,[]);return h.view.render();}
function click(root,id,cx) {const node=byId(root,id);assert.ok(node,`missing ${id}`);node.handlers.on_click({},cx);}
test('archive hides a subtree under a closed section without ending or selecting terminals',async()=>{
 const h=await setup(),tree=await command(h,'archive:child');
 assert.ok(!byId(byId(tree,'spaces-agents-list'),'space-child'));
 assert.ok(!byId(tree,'space-grandchild'));assert.match(text(byId(tree,'backlog-toggle')),/Backlog \(2\)/);
 assert.ok(!byId(tree,'backlog-list'));assert.ok(byId(tree,'space-other'));
 assert.deepEqual(host.runs,[]);assert.equal(host.spaces.length,4);
});
test('expand, inspect, restore, and undo use actual handlers',async()=>{
 const h=await setup();let tree=await command(h,'archive:child');
 click(tree,'backlog-toggle',h.cx);tree=h.view.render();
 const row=byId(tree,'space-child');assert.ok(row);
 row.handlers['on_mouse_down:left'](mouse(10,10),h.cx);row.handlers['on_mouse_up:left'](mouse(10,10),h.cx);
 assert.deepEqual(host.ran('space.select'),[{id:'child'}]);
 host.spaces.forEach(s=>s.active=s.id==='child');tree=h.view.render();
 assert.ok(byId(tree,'backlog-current'));assert.ok(byId(tree,'space-grandchild'));
 click(tree,'backlog-restore-current',h.cx);tree=h.view.render();
 assert.ok(!byId(tree,'backlog-current'));assert.ok(!byId(tree,'backlog-section'));
 assert.ok(byId(byId(tree,'spaces-agents-list'),'space-child'));
 click(tree,'backlog-undo',h.cx);tree=h.view.render();assert.ok(byId(tree,'backlog-section'));
});
test('favorites do not hide archived worktrees or their blocked attention',async()=>{
 const h=await setup();await command(h,'archive:child');
 host.shared['agents.favoritesOnly']=true;
 host.agents=[{address:'a1',space:'grandchild',tab:'tab-grandchild',status:'blocked'}];
 let tree=h.view.render();assert.match(text(byId(tree,'backlog-toggle')),/응답 필요 1/);
 assert.equal(state().expanded,false);click(tree,'backlog-toggle',h.cx);tree=h.view.render();
 assert.ok(byId(tree,'space-child'));assert.ok(byId(tree,'space-grandchild'));
});
test('renaming, recreated space IDs and a mod reload preserve archive and expansion',async()=>{
 const h=await setup();let tree=await command(h,'archive:child');click(tree,'backlog-toggle',h.cx);
 host.spaces[1].name='새 이름';host.spaces[1].id='new-child';
 const cx=makeCx(),view=new Sidebar();view.init({},cx);await cx.settle();tree=view.render();
 assert.match(text(byId(tree,'backlog-list')),/새 이름/);assert.ok(byId(tree,'space-new-child'));
 assert.ok(!byId(byId(tree,'spaces-agents-list'),'space-new-child'));
});
test('a descendant can resume while its parent stays archived',async()=>{
 const h=await setup();await command(h,'archive:root');const tree=await command(h,'restore:child');
 assert.ok(byId(byId(tree,'spaces-agents-list'),'space-child'));
 assert.ok(byId(byId(tree,'spaces-agents-list'),'space-grandchild'));
 assert.match(text(byId(tree,'backlog-toggle')),/Backlog \(1\)/);
});
test('archiving a parent also includes descendants hidden by favorites',async()=>{
 const h=await setup();host.shared['agents.favoritesOnly']=true;
 const tree=await command(h,'archive:root');assert.match(text(byId(tree,'backlog-toggle')),/Backlog \(3\)/);
});
test('a new child inherits archive, and stale remote snapshots do not prune stored state',async()=>{
 const h=await setup();await command(h,'archive:child');
 host.spaces.push({id:'new',name:'new',folder:'/new',machine:null,tabs:[]});h.view.hierarchy['/new']='/child';
 let tree=h.view.render();assert.match(text(byId(tree,'backlog-toggle')),/Backlog \(3\)/);
 const saved=structuredClone(state());host.spaces=[];h.view.render();assert.deepEqual(state(),saved);
});
test('narrow rail expands the backlog even when it was expanded before collapsing',async()=>{
 const h=await setup();let tree=await command(h,'archive:child');click(tree,'backlog-toggle',h.cx);
 host.layout={id:'sidebar',size:{px:76}};tree=h.view.render();click(tree,'backlog-toggle',h.cx);
 assert.equal(state().expanded,true);assert.ok(host.runs.some(([name])=>name==='layout.resize'));
});
test('menu targets the clicked worktree and supports keyboard restoration',async()=>{
 const h=await setup();await command(h,'archive:child');
 h.view.menu(host.spaces[1]);host.props=host.overlays.at(-1).props;
 const cx=makeCx(), menu=new Menu();menu.init({},cx);await cx.settle();
 let tree=menu.render(cx);assert.match(text(tree),/작업 목록으로 복귀/);
 tree.handlers.on_key_down(key('down'),cx);tree=menu.render(cx);tree.handlers.on_key_down(key('enter'),cx);
 assert.deepEqual(host.runs.at(-1),['spaces-agents.backlog:restore:child',undefined]);
});
test('archive menu makes inclusion of children clear',async()=>{
 const h=await setup();h.view.menu(host.spaces[1]);host.props=host.overlays.at(-1).props;
 const cx=makeCx(),menu=new Menu();menu.init({},cx);await cx.settle();assert.match(text(menu.render(cx)),/Backlog로 이동 \(하위 포함\)/);
});
test('undo expires and an older timer cannot clear a newer action',async()=>{
 const h=await setup();await command(h,'archive:child');await command(h,'restore:child');
 const timers=h.cx.timers.filter(t=>!t.every);timers[0].fn(h.cx);assert.ok(byId(h.view.render(),'backlog-undo'));
 timers.at(-1).fn(h.cx);assert.ok(!byId(h.view.render(),'backlog-undo'));
});
for (const [label,action] of [['New worktree','new'],['Open worktree','open'],['Remove worktree','remove']]) {
 test(`adding archive preserves ${label} and its clicked target`,async()=>{
  const h=await setup();h.view.menu(host.spaces[1]);host.props=host.overlays.at(-1).props;
  const cx=makeCx(),menu=new Menu();menu.init({},cx);await cx.settle();
  const tree=menu.render(cx);
  let item=null;
  const visit=node=>{if(node?.props?.id?.startsWith('mi-') && text(node)===label)item=node;for(const kid of node?.kids??[])visit(kid);};visit(tree);
  assert.ok(item,label);item.handlers.on_click({},cx);
  assert.equal(host.overlays.at(-1).mod,'worktree-codex');
  assert.equal(host.overlays.at(-1).props.space,'child');assert.equal(host.overlays.at(-1).props.action,action);
 });
}
