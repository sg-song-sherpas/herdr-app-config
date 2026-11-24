import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff } from "../../mods/Sketch/diff.js";

test("hunks reset line numbers, including an insertion into an empty file", () => {
  const { rows } = parseDiff("@@ -0,0 +1,2 @@\n+가\n+나\n@@ -20 +22 @@\n-다\n+라");
  assert.deepEqual(rows.map(({ old, next }) => [old, next]), [["", ""], ["", 1], ["", 2], ["", ""], [20, ""], ["", 22]]);
});

test("file markers are metadata but code beginning with --- or +++ is still code inside a hunk", () => {
  const { title, rows } = parseDiff("--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n---old\n+++new");
  assert.equal(title, "app.js");
  assert.deepEqual(rows.map((r) => r.kind), ["meta", "meta", "hunk", "remove", "add"]);
});

test("a multi-file patch stays intact and restarts numbering for each file", () => {
  const patch = "--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n--- a/b.js\n+++ b/b.js\n@@ -8 +9 @@\n-c\n+d";
  const { title, rows } = parseDiff(patch);
  assert.equal(title, "Git diff · 2 files");
  assert.equal(rows[6].kind, "meta");
  assert.equal(rows.at(-1).next, 9);
});

test("manual filenames, CRLF, empty patches and no-newline markers are supported", () => {
  const { title, rows } = parseDiff("설정.js\r\n@@ -1 +1 @@\r\n-가\r\n\\ No newline at end of file\r\n+나\r\n");
  assert.equal(title, "설정.js");
  assert.equal(rows[2].kind, "meta");
  assert.equal(rows.at(-1).next, 1);
  assert.deepEqual(parseDiff(), { title: "Git diff", rows: [] });
});

test("a renamed file counts once and a deleted file keeps its original filename", () => {
  assert.equal(parseDiff("--- a/old.js\n+++ b/new.js\n").title, "new.js");
  assert.equal(parseDiff("--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-deleted").title, "old.js");
});
