import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.env.BACKLOG_MODS || new URL('../../mods', import.meta.url).pathname;
const {backlogIdentity:key,backlogState,backlogChange,backlogPartition:partition,backlogUndo} = await import(pathToFileURL(`${root}/spaces-agents/backlog.js`));
const row=(id,depth=0,machine=null,folder='/'+id)=>({w:{id,name:id,machine,folder},depth,tree:depth?'└─':null});
test('identity isolates machines, normalizes Windows paths and preserves Unix case',()=>{
 assert.equal(key(row('a',0,'win','C:\\Repo\\Foo\\').w),key(row('b',0,'win','c:/repo/foo').w));
 assert.notEqual(key(row('a',0,'one','/repo').w),key(row('a',0,'two','/repo').w));
 assert.notEqual(key(row('a',0,null,'/Repo').w),key(row('a',0,null,'/repo').w));
 assert.notEqual(key(row('a',0,null,'').w),key(row('b',0,null,'').w));
});
test('malformed state cannot silently hide spaces',()=>{
 for(const state of [null,[],false,{entries:[]},{entries:{x:'true',y:1}}])assert.deepEqual(backlogState(state),{entries:{},expanded:false});
});
test('split lists preserve their own ancestry without mutating native hierarchy',()=>{
 const rows=[row('parent'),row('child',1),row('grandchild',2),row('sibling',1)];
 const original=structuredClone(rows);
 let result=partition(rows,backlogChange(rows,{},'child',true).entries);
 assert.deepEqual(result.archived.map(r=>[r.w.id,r.depth]),[['child',0],['grandchild',1]]);
 assert.deepEqual(result.active.map(r=>[r.w.id,r.depth]),[['parent',0],['sibling',1]]);
 assert.deepEqual(rows,original);
});
test('restored subtree stays restored under an archived parent including newly opened descendants',()=>{
 const rows=[row('parent'),row('child',1),row('grandchild',2)];
 let entries=backlogChange(rows,{},'parent',true).entries;
 entries=backlogChange(rows,entries,'child',false).entries;
 const result=partition([...rows,row('new',2)],entries);
 assert.deepEqual(result.active.map(r=>r.w.id),['child','grandchild','new']);
 assert.deepEqual(result.archived.map(r=>r.w.id),['parent']);
});
test('undo preserves unrelated choices and skips keys changed after its action',()=>{
 const rows=[row('one'),row('two')],first=backlogChange(rows,{},'one',true);
 const second=backlogChange(rows,first.entries,'two',true);
 assert.deepEqual(backlogUndo(second.entries,first),{[key(rows[1].w)]:true});
 const newer=backlogChange(rows,first.entries,'one',false);
 assert.deepEqual(backlogUndo(newer.entries,first),newer.entries);
 assert.equal(backlogChange(rows,{},'missing',true),null);
});
