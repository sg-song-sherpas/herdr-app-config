import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {host} from 'herdr';
import Files from '../../mods/files-sketch/main.js';
import {makeCx} from '../fakes/cx.mjs';
import {byId,text} from '../fakes/element.mjs';
const PATCH='diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -8,2 +8,2 @@\n same\n-old\n+new';
beforeEach(()=>{
 host.reset();host.spaces=[{id:'s',active:true,folder:'/repo'}];host.focused={space:'s',tab:'t',pane:'p'};
 host.exec=async(_,args)=>({code:0,stdout:args.includes('--show-toplevel')?'/repo\n':args.includes('diff')?PATCH:'',stderr:''});
});
async function mount(){const v=new Files(),cx=makeCx();v.init({},cx);await cx.settle();return {v,cx};}
test('Files defaults to PR-style main merge-base diff and reveals the requested new line',async()=>{
 const {v,cx}=await mount();v.show('a.js',cx,9);await cx.settle();
 assert.equal(v.mode,'diff');assert.equal(v.diffRows[6].next,9);assert.equal(v.diffScroll.index,6);
 const command=host.execs.find(e=>e[1]?.includes('diff'));
 assert.ok(command[1].includes('refs/remotes/origin/main...HEAD'));
 assert.ok(command[1].includes('--no-ext-diff'));assert.ok(command[1].includes('--no-textconv'));
 assert.match(text(v.render(cx)),/PR diff/);assert.ok(byId(v.render(cx),'files-pr-diff'));
});
test('a line absent from PR context opens the original code at that exact line',async()=>{
 const {v,cx}=await mount();host.files.set('/repo/a.js','first\nsecond');v.show('a.js',cx,42);await cx.settle();
 assert.equal(v.mode,'code');assert.equal(v.code.line,42);assert.match(v.navigationWarning,/PR diff/);
});
test('main is used when no origin/main ref is locally available',async()=>{
 host.exec=async(_,args)=>({code:args.includes('refs/remotes/origin/main')?1:0,stdout:args.includes('--show-toplevel')?'/repo\n':args.includes('diff')?PATCH:'',stderr:''});
 const {v,cx}=await mount();v.show('a.js',cx);await cx.settle();
 assert.equal(v.diffBase,'refs/heads/main');assert.ok(host.execs.some(e=>e[1]?.includes('refs/heads/main...HEAD')));
});
test('no committed change has an explicit empty diff instead of an unrelated working-tree patch',async()=>{
 host.exec=async(_,args)=>({code:0,stdout:args.includes('--show-toplevel')?'/repo\n':'',stderr:''});
 const {v,cx}=await mount();v.show('a.js',cx);await cx.settle();assert.match(text(v.render(cx)),/main 대비 커밋된 변경 없음/);
});
