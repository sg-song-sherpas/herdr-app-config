import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffTargets} from '../../mods/Sketch/diff.js';
test('links track new-side lines, including deletion anchors and separate files',()=>{
 const targets=diffTargets('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -8,2 +8,2 @@\n same\n-old\n+new\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -30 +30 @@\n-old\n+new');
 assert.deepEqual(targets[4],{path:'a.js',line:8});
 assert.deepEqual(targets[5],{path:'a.js',line:9});
 assert.deepEqual(targets[6],{path:'a.js',line:9});
 assert.deepEqual(targets[12],{path:'b.js',line:30});
});
test('deleted files and unsafe or unknown filenames have no code target',()=>{
 for(const path of ['/dev/null','../outside.js','/absolute.js']) assert.equal(diffTargets(`--- a/test.js\n+++ ${path}\n@@ -1 +1 @@\n-old\n+new`)[4],null);
 assert.equal(diffTargets('+unknown')[0],null);
});
test('manual filename titles support spaces and unchanged context rows',()=>{
 assert.deepEqual(diffTargets('src/my file.js\n@@ -3 +3 @@\n context')[1],{path:'src/my file.js',line:3});
});
test('Git-quoted Unicode filenames and renamed files target the new path',()=>{
 assert.deepEqual(diffTargets('--- "a/old name.js"\n+++ "b/new name.js"\n@@ -1 +1 @@\n-old\n+new')[4],{path:'new name.js',line:1});
 assert.deepEqual(diffTargets('--- a/old.js\n+++ "b/\\355\\225\\234.js"\n@@ -1 +1 @@\n-old\n+new')[4],{path:'한.js',line:1});
});
