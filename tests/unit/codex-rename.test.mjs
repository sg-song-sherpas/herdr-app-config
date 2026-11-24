import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Codex bridge selects exact conversations, handles races and verifies persisted names", () => {
  const result = spawnSync("python3", [new URL("./codex_rename_test.py", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
