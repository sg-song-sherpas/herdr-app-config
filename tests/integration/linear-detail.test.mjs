import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { byId, text } from "../fakes/element.mjs";
import { Detail } from "../../mods/linear-issues/detail.js";
import { DETAIL_KEY, MINE_KEY } from "../../mods/linear-issues/common.js";

const issue = (id) => ({
  identifier: id, title: `Title ${id}`, description: `Body ${id}`, state: { name: "Started", type: "started" },
  team: { states: { nodes: [] } }, comments: { nodes: [] }, children: { nodes: [] },
  attachments: { nodes: [] }, labels: { nodes: [] },
});
let requests;
beforeEach(() => {
  host.reset(); localStorage.clear(); requests = [];
  host.shared[MINE_KEY] = { at: Date.now(), issues: [issue("PRD-1"), issue("PRD-2")] };
  host.exec = async (_cmd, args) => {
    const { variables: { id } } = JSON.parse(args[3]);
    return new Promise((resolve) => requests.push({ id, finish: () => resolve({
      code: 0, stderr: "", stdout: JSON.stringify({ data: { issue: issue(id) } }),
    }) }));
  };
});
const pick = (detail, cx, id) => { host.shared[DETAIL_KEY] = id; return detail.render(cx); };

test("detail: responding to selection during render does not request another render", () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  cx.notify = () => { throw new Error("notify is forbidden during render"); };
  assert.doesNotThrow(() => pick(detail, cx, "PRD-1"));
});

test("detail: selection shows the new title and starts loading without a polling tick", async () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  const tree = pick(detail, cx, "PRD-1");
  assert.match(text(tree), /Title PRD-1/);
  await cx.settle();
  assert.deepEqual(requests.map((r) => r.id), ["PRD-1"]);
  requests[0].finish(); await cx.settle();
  assert.match(text(detail.render(cx)), /Body PRD-1/);
  const next = pick(detail, cx, "PRD-2");
  assert.match(text(next), /Title PRD-2/);
  assert.doesNotMatch(text(next), /Body PRD-1/);
});

test("detail: revisiting a recent issue shows its body immediately without another request", async () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  pick(detail, cx, "PRD-1"); await cx.settle(); requests[0].finish(); await cx.settle();
  pick(detail, cx, "PRD-2"); await cx.settle(); requests[1].finish(); await cx.settle();
  assert.match(text(pick(detail, cx, "PRD-1")), /Body PRD-1/);
  await cx.settle();
  assert.equal(requests.length, 2);
  byId(detail.render(cx), "ld-reload").handlers.on_click({}, cx);
  await cx.settle();
  assert.equal(requests.length, 3, "explicit refresh bypasses cache");
});

test("detail: a stale cached issue stays visible while it refreshes", async () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  pick(detail, cx, "PRD-1"); await cx.settle(); requests[0].finish(); await cx.settle();
  pick(detail, cx, "PRD-2"); await cx.settle();
  const now = Date.now;
  try {
    Date.now = () => now() + 120000;
    assert.match(text(pick(detail, cx, "PRD-1")), /Body PRD-1/);
    await cx.settle();
    assert.equal(requests.length, 3);
  } finally { Date.now = now; }
});

test("detail: an older response cannot replace the issue selected most recently", async () => {
  const cx = makeCx(), detail = new Detail(cx, () => {});
  pick(detail, cx, "PRD-1"); await cx.settle();
  pick(detail, cx, "PRD-2"); await cx.settle();
  requests[1].finish(); await cx.settle();
  requests[0].finish(); await cx.settle();
  const tree = detail.render(cx);
  assert.match(text(tree), /Body PRD-2/);
  assert.doesNotMatch(text(tree), /Body PRD-1/);
});
