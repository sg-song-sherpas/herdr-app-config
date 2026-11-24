import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("./context.js", import.meta.url), "utf8");
const { configOf, resumeOf, boundary, unread, resumePolicy, repositoryTasks, attentionFor, detailMarkdown,
  frozenDetail, shouldOpenResume, acknowledgmentAllowed, displaySnapshot, stateSignature, eventSourceAvailable,
  headerDensity, freshnessLabel, unreviewedCount } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

const task = { taskId: "a", address: "t1", repositoryId: "r", lastReviewedEventId: 2, events: [
  { id: 1 }, { id: 3, summary: "first", source: "git" }, { id: 4, summary: "late", source: "agent-report" },
] };
test("frozen acknowledgment boundary excludes concurrently arriving events", () => {
  assert.equal(boundary(task), 4);
  assert.deepEqual(unread(task, 3).map(event => event.id), [3]);
  assert.deepEqual(unread({ ...task, lastReviewedEventId: 3 }).map(event => event.id), [4]);
});
test("manual policy never auto opens; unchanged important skips; progress card is concise", () => {
  assert.equal(resumePolicy(configOf({ autoDisplay: "manual" }), { ...task, status: "blocked" }, {}), "none");
  assert.equal(resumePolicy(configOf({}), { ...task, events: [] }, {}), "none");
  assert.equal(resumePolicy(configOf({}), task, {}), "card");
  assert.equal(resumePolicy(configOf({}), { ...task, status: "blocked" }, {}), "window");
  assert.equal(resumePolicy(configOf({}), task, { conflicts: [{ agents: ["a"] }] }), "window");
});
test("repository and priority filtering keeps unrelated tasks separate", () => {
  const state = { tasks: [task, { taskId: "b", repositoryId: "r" }, { taskId: "c", repositoryId: "other" }],
    attention: [{ taskId: "c", priority: 100 }, { taskId: "a", priority: 10 }, { taskId: "b", priority: 90 }] };
  const tasks = repositoryTasks(state, task);
  assert.deepEqual(tasks.map(item => item.taskId), ["a", "b"]);
  assert.deepEqual(attentionFor(state, tasks).map(item => item.taskId), ["b", "a"]);
});
test("resume identity rejects old foreground PID and invalid metadata", () => {
  assert.equal(resumeOf({ labels: { "herdr.resume": "invalid" } }), null);
  assert.equal(resumeOf({ labels: { "herdr.resume": '{"agent":"codex","id":"s","pid":1}' }, foreground: { pid: 2 } }), null);
  assert.equal(resumeOf({ labels: { "herdr.resume": '{"agent":"codex","id":"s","pid":1}' }, foreground: { pid: 1 } }).id, "s");
});
test("detail preserves source and frozen event evidence without invented facts", () => {
  const text = detailMarkdown(task, {}, "delta", configOf({}), 3);
  assert.match(text, /first/);
  assert.doesNotMatch(text, /late/);
  assert.match(text, /\[git\]/);
  assert.match(text, /Unknown/);
});
test("progress updates cannot reopen the active review window", () => {
  const previous = { address: "t1", signal: "blocked-one" };
  assert.equal(shouldOpenResume(previous, "t1", "blocked-one", "window", false), false);
  assert.equal(shouldOpenResume(previous, "t1", "new-blocker", "window", true), false);
  assert.equal(shouldOpenResume(previous, "t2", "blocked-two", "window", false), true);
  assert.equal(shouldOpenResume(previous, "t1", "new-blocker", "window", false), true);
  assert.equal(shouldOpenResume(null, "t1", "blocked-one", "window", false), false);
});
test("detail freezes content as well as the acknowledgment boundary", () => {
  const mutable = { ...task, decisions: ["first"], events: task.events.map(event => ({ ...event })) };
  const snapshot = frozenDetail(mutable, { tasks: [mutable], conflicts: [], attention: [] }, {});
  mutable.decisions.push("later");
  mutable.events.push({ id: 5, summary: "later" });
  assert.deepEqual(snapshot.task.decisions, ["first"]);
  assert.equal(snapshot.throughEventId, 4);
  assert.equal(snapshot.task.events.length, 3);
});
test("hidden and missing events cannot be acknowledged by a displayed page", () => {
  assert.equal(acknowledgmentAllowed({ ...task, delta: { gap: true } }, configOf({}), 4), false);
  const withGit = { ...task, events: [{ id: 3, type: "git", source: "git_observation" }] };
  assert.equal(acknowledgmentAllowed(withGit, configOf({ showRepository: false }), 3), false);
  assert.equal(acknowledgmentAllowed(withGit, configOf({}), 3), true);
  const decision = { ...task, events: [{ id: 3, type: "report", evidence: { decisions: ["a"] } }] };
  assert.equal(acknowledgmentAllowed(decision, configOf({ showDecisions: false }), 3), false);
});
test("AI snapshot remains distinct and older AI data cannot replace new context", () => {
  const llm = { fields: { goal: "AI goal" }, throughEventId: 4, source: "llm-unverified", at: 5 };
  const original = { ...task, goal: "Original", llmSnapshot: llm };
  assert.equal(displaySnapshot(original).goal, "AI goal");
  assert.equal(original.goal, "Original");
  assert.equal(displaySnapshot({ ...original, events: [...original.events, { id: 5 }] }).goal, "Original");
  assert.notEqual(stateSignature({ tasks: [task] }), stateSignature({ tasks: [original] }));
});
test("source navigation only links exact captured transcript or test evidence", () => {
  const sourceTask = { sourceLog: "/tmp/exact.jsonl" };
  assert.equal(eventSourceAvailable(sourceTask, { evidence: { path: "/tmp/exact.jsonl", byteOffset: 64 } }), true);
  assert.equal(eventSourceAvailable(sourceTask, { evidence: { evidence: { path: "/tmp/exact.jsonl", byteOffset: 64 } } }), true);
  assert.equal(eventSourceAvailable(sourceTask, { evidence: { path: "/tmp/other.jsonl", byteOffset: 64 } }), false);
  assert.equal(eventSourceAvailable(sourceTask, { type: "git", evidence: { files: ["a.ts"] } }), false);
});
test("responsive density keeps the narrow toolbar minimal at exact breakpoints", () => {
  assert.equal(headerDensity(1100), "full");
  assert.equal(headerDensity(900), "full");
  assert.equal(headerDensity(899), "compact");
  assert.equal(headerDensity(620), "compact");
  assert.equal(headerDensity(619), "minimal");
});
test("analysis freshness does not turn a long-running agent into an error", () => {
  assert.equal(freshnessLabel({ status: "working" }), "");
  assert.equal(freshnessLabel({ syncPending: true, git: { stale: true } }), "분석 대기 · Git 관측 오래됨");
  assert.equal(unreviewedCount({ ...task, delta: { totalUnreviewed: 450 } }), 450);
});
test("radar distinguishes both branch integration directions and uncommitted unknown", () => {
  const text = detailMarkdown(task, {
    taskNames: { a: "Auth", b: "Payment" },
    conflicts: [{ agents: ["a", "b"], level: 2, files: ["api.ts"], symbols: ["Token"],
      perAgentIntegrated: { a: "yes", b: "no" }, evidence: { source: "git_diff_heuristic", uncommittedChangesIntegrated: "unknown" } }],
  }, "conflicts", configOf({}), 4);
  assert.match(text, /Auth에서 상대 HEAD 반영 yes/);
  assert.match(text, /Payment에서 상대 HEAD 반영 no/);
  assert.match(text, /미커밋 변경 반영: unknown/);
});
