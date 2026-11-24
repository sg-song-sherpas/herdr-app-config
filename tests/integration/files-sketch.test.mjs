import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {host} from 'herdr';
import Files from '../../mods/files-sketch/main.js';
import {makeCx} from '../fakes/cx.mjs';
beforeEach(()=>host.reset());
test('Files consumes a scoped navigation and opens the exact worktree file and line',async()=>{
 host.spaces=[{id:'s',active:true,folder:'/other'}];host.focused={space:'s',tab:'t',pane:'p'};
 host.shared['files.navigation']={space:'s',tab:'t',root:'/repo',on:null,path:'src/a.js',line:42,nonce:'one'};
 host.files.set('/repo/src/a.js','first\nsecond');
 const v=new Files(),cx=makeCx();v.init({},cx);v.render(cx);await cx.settle();
 assert.equal(v.file,'src/a.js');assert.equal(v.code?.line,42);assert.equal(v.code.value(),'first\nsecond');
 const first=v.code;v.render(cx);await cx.settle();assert.equal(v.code,first,'navigation only runs once');
 host.shared['files.navigation']={...host.shared['files.navigation'],line:1,nonce:'two'};
 v.render(cx);await cx.settle();assert.equal(v.code.line,1);
});
test('another tab cannot consume a Sketch navigation',async()=>{
 host.spaces=[{id:'s',active:true,folder:'/other'}];host.focused={space:'s',tab:'other',pane:'p'};
 host.shared['files.navigation']={space:'s',tab:'t',root:'/repo',on:null,path:'src/a.js',line:42,nonce:'one'};
 const v=new Files(),cx=makeCx();v.init({},cx);v.render(cx);await cx.settle();assert.equal(v.file,null);
});
test('a missing native line API still opens the file and explains the limitation',async()=>{
 host.spaces=[{id:'s',active:true,folder:'/repo'}];host.focused={space:'s',tab:'t',pane:'p'};
 host.files.set('/repo/a.js','first');
 const {EditorState}=await import('gpui-base');const create=EditorState.new;
 EditorState.new=options=>{const state=create(options);delete state.go_to_line;return state;};
 try {
  const v=new Files(),cx=makeCx();v.init({},cx);await cx.settle();
  host.shared['files.navigation']={space:'s',tab:'t',root:'/repo',on:null,path:'a.js',line:42,nonce:'missing'};
  v.render(cx);await cx.settle();assert.equal(v.code.value(),'first');assert.match(v.navigationWarning,/줄 이동/);
 } finally {EditorState.new=create;}
});
