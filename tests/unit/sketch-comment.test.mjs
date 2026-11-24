import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveComment } from "../../mods/Sketch/comments.js";

test("comments follow a unique unchanged line range when other rows are inserted", () => {
  const rows = ["intro", "-before", "+after", "end"].map((text) => ({ text }));
  assert.deepEqual(resolveComment({ startRow: 0, endRow: 1, quote: ["-before", "+after"] }, rows), [1, 2]);
});

test("changed or ambiguous ranges stay unplaced instead of attaching to unrelated lines", () => {
  assert.equal(resolveComment({ startRow: 0, endRow: 0, quote: ["old"] }, [{ text: "new" }]), null);
  assert.equal(resolveComment({ startRow: 2, endRow: 2, quote: ["same"] }, [{ text: "same" }, { text: "same" }]), null);
});
