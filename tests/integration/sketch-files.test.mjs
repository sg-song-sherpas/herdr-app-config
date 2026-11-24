import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {host} from 'herdr';
import Sketch from '../../mods/Sketch/main.js';
import {makeCx} from '../fakes/cx.mjs';
import {byId} from '../fakes/element.mjs';
beforeEach(()=>{host.reset();localStorage.clear();});
test('a code shortcut opens Files at the chosen diff row in the Sketch worktree',async()=>{
 host.files.set('/app/data/sketch/board.json',JSON.stringify({version:1,shapes:[{id:'diff',type:'diff',x:0,y:0,w:560,h:280,text:'src/test.js\n@@ -8,2 +8,2 @@\n same\n-old\n+new'}]}));
 const v=new Sketch(),cx=makeCx();v.init({},cx);await cx.settle();await cx.flush();
 host.spaces=[{id:'s1',active:true,folder:'/other'}];host.focused={space:'s1',tab:'tab1',pane:'p1'};
 v.where={root:'/repo',machine:'remote'};
 const link=byId(v.render(),'diff-diff-code-3');assert.ok(link);
 link.handlers.on_click({},cx);
 assert.deepEqual({...host.shared['files.navigation'],nonce:undefined},{root:'/repo',on:'remote',path:'src/test.js',line:9,space:'s1',tab:'tab1',nonce:undefined});
 assert.deepEqual(host.ran('layout.select'),[{stack:'panel-body',child:'files'}]);
 assert.deepEqual(host.ran('layout.show'),[{id:'panel'}]);
});
test('old and new diff line numbers have a visible monospace space between them',async()=>{
 host.files.set('/app/data/sketch/board.json',JSON.stringify({version:1,shapes:[{id:'diff',type:'diff',x:0,y:0,w:560,h:280,text:'src/a.js\n@@ -12 +12 @@\n same'}]}));
 const v=new Sketch(),cx=makeCx();v.init({},cx);await cx.settle();await cx.flush();v.zoom=1.5;
 const gap=byId(v.render(),'diff-diff-number-gap-1');assert.ok(gap);assert.equal(gap.kids[0],' ');assert.equal(gap.props.w,13*0.62*1.5);
});
test('diff cards inside popup sketches inherit the same worktree code target',async()=>{
 const {MiniSketch}=await import('../../mods/Sketch/main.js');
 const v=new MiniSketch(),cx=makeCx();v.init({embedded:{rel:'data/sketch',where:{root:'/repo',machine:null},shapes:[{id:'nested',type:'diff',x:0,y:0,w:560,h:280,text:'a.js\n@@ -1 +1 @@\n same'}]}},cx);
 assert.ok(byId(v.render(),'diff-nested-code-1'));
});
