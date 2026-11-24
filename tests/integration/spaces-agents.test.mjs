// The merged sidebar list against a fake host: agents under their spaces,
// worktrees under their checkout, clicks, navigation order, carried-over times.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { walk, byId, text } from "../fakes/element.mjs";
import Spaces from "../../mods/spaces-agents/main.js";

const claude = { name: "Claude Code", key: "claude-code", agent: true, icon: "icons/claude.svg", tint: true };
const ids = (root) => [...walk(root)].map((e) => e.props.id).filter((id) => /^(space|ag)-/.test(String(id)) && id !== "space-new");

beforeEach(() => {
  host.reset();
  localStorage.clear();
  host.layout = { id: "root", children: [{ id: "sidebar", size: { px: 268 } }] };
  host.spaces = [
    { id: "s1", name: "basecamp", folder: "/r/main", active: true, tabs: [{ id: "t1", name: "1", named: false }] },
    { id: "s2", name: "sotong", folder: "/x", tabs: [{ id: "t2", name: "plan", named: true }] },
  ];
  host.panes = [
    { pane: "p1", tab: "t1", terminal: "a1", cwd: "/r/main", program: claude, title: "✳ Fixing login", focused: true },
    { pane: "p2", tab: "t2", terminal: "a2", cwd: "/x", program: claude, title: "Claude Code" },
  ];
  host.agents = [
    { address: "a1", pane: "p1", space: "s1", space_name: "basecamp", tab: "t1", status: "working", program: claude, focused: true },
    { address: "a2", pane: "p2", space: "s2", space_name: "sotong", tab: "t2", status: "blocked", program: claude },
  ];
  // No repos unless a test says so.
  host.exec = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
});

async function mount() {
  const cx = makeCx();
  const v = new Spaces();
  v.init({}, cx);
  await cx.settle();
  return { v, cx };
}

test("each space is followed by its own agents", async () => {
  const { v } = await mount();
  const root = v.render();
  assert.deepEqual(ids(root), ["space-s1", "ag-a1", "space-s2", "ag-a2"]);
  assert.match(text(byId(root, "ag-a1")), /Fixing login/);
  assert.match(text(byId(root, "ag-a2")), /plan.*Needs you/);
});

test("clicking an agent goes to its pane", async () => {
  const { v, cx } = await mount();
  byId(v.render(), "ag-a2").handlers.on_click({}, cx);
  assert.deepEqual(host.ran("pane.focus"), [{ pane: "p2" }]);
});

for (const zoom of [1, 1.1]) {
  test(`double-clicking an agent renames its tab at zoom ${zoom}`, async () => {
    host.settings.zoom = zoom;
    const { v, cx } = await mount();
    const row = byId(v.render(), "ag-a2");
    row.handlers["on_mouse_down:left"]({ click_count: 1 }, cx);
    row.handlers.on_click({}, cx);
    assert.deepEqual(host.ran("tab.rename"), []);
    assert.deepEqual(host.ran("pane.focus"), [{ pane: "p2" }]);
    row.handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
    assert.deepEqual(host.ran("tab.rename"), []);
    const editor = byId(v.render(), "rename-t2");
    assert.ok(editor);
    const input = [...walk(editor)].find(e => e.kind === "input");
    assert.equal(input.arg.value(), "plan");
    input.arg.type("로그인 수정", cx);
    input.arg.submit(cx);
    assert.deepEqual(host.ran("tab.rename"), [{ id: "t2", name: "로그인 수정" }]);
    assert.equal(byId(v.render(), "rename-t2"), null);
    assert.equal(cx.stopped, 1);

    host.spaces[1].tabs[0].name = "로그인 수정";
    assert.match(text(byId(v.render(), "ag-a2")), /로그인 수정/);
  });
}

test("agent.next / agent.prev follow the list's order", async () => {
  host.agents.reverse();
  const { v } = await mount();
  v.render();
  assert.deepEqual(host.agentOrder, ["a1", "a2"]);
});

test("times carry over from the old agents list", async () => {
  host.agents[0].status = "idle";
  host.files.set("/app/data/agents/store.json", JSON.stringify({ changed: JSON.stringify({ a1: { s: "idle", at: Date.now() - 2 * 3600000 } }) }));
  const { v } = await mount();
  assert.match(text(byId(v.render(), "ag-a1")), /2h/);
});

test("a worktree space sits under its checkout, with its agents indented further", async () => {
  host.spaces.splice(1, 0, { id: "s3", name: "feature-x", folder: "/r/wt", tabs: [{ id: "t3", name: "1", named: false }] });
  host.panes.push({ pane: "p3", tab: "t3", terminal: "a3", cwd: "/r/wt", program: claude, title: "" });
  host.agents.splice(1, 0, { address: "a3", pane: "p3", space: "s3", space_name: "feature-x", tab: "t3", status: "idle", program: claude });
  host.exec = async (cmd, args, { cwd }) => {
    if (args.includes("status")) return { code: 0, stdout: `# branch.head ${cwd === "/r/wt" ? "feature-x" : "main"}\n`, stderr: "" };
    if (args.includes("--show-toplevel")) return { code: 0, stdout: `${cwd}\n`, stderr: "" };
    if (args.includes("--git-common-dir")) return { code: 0, stdout: "/r/main/.git\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const { v, cx } = await mount();
  await cx.tick(); // the 250ms check that starts the git lookups
  await cx.settle();
  const root = v.render();
  assert.deepEqual(ids(root), ["space-s1", "ag-a1", "space-s3", "ag-a3", "space-s2", "ag-a2"]);
  assert.ok([...walk(byId(root, "space-s3"))].some((e) => e.kind === "svg" && /branch\.svg/.test(e.arg)));
  assert.equal(byId(root, "ag-a3").props.pl, 52);
  assert.equal(byId(root, "ag-a1").props.pl, 35);
});

test("the narrow sidebar shows spaces only, with the expand button", async () => {
  host.layout.children[0].size.px = 76;
  const { v } = await mount();
  const root = v.render();
  assert.deepEqual(ids(root).filter((id) => id.startsWith("ag-")), []);
  assert.ok(byId(root, "collapse"));
});

test("space names use the available width while branch names stay out of the sidebar", async () => {
  const { v } = await mount();
  const name = "PRD-10355 Cmd+K를 누르면 검색창을 연다";
  const root = v.row({ w: { ...host.spaces[0], name }, i: 0, tree: "└─",
    g: { name: "basecamp", branch: "feature/prd-10355-cmd-k", ahead: 2, behind: 1 } }, host.theme);
  assert.ok(text(root).includes(name));
  assert.ok(!text(root).includes("feature/prd-10355-cmd-k"));
  assert.match(text(root), /↑2/);
  assert.match(text(root), /↓1/);
  const label = [...walk(root)].find(e => e.kids.includes(name));
  assert.ok(label.calls.some(([method]) => method === "flex_1"));
  assert.equal(label.props.max_w, undefined);
});


test("agent stars toggle independently, survive remounts, and leave navigation alone", async () => {
  const { v, cx } = await mount();
  let root = v.render();
  const star = byId(root, "agent-star-a1");
  assert.ok(star, "each agent has a star toggle");
  assert.equal([...walk(star)].find(e => e.kind === "svg").arg, "mods/spaces-agents/star.svg");
  const row = byId(root, "ag-a1");
  assert.ok(row.kids.indexOf(star) < row.kids.findIndex(e => e.kind === "svg" && e.arg === claude.icon));
  star.handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
  star.handlers.on_click({}, cx);
  assert.deepEqual(host.ran("pane.focus"), []);
  assert.equal(byId(v.render(), "rename-t1"), null);
  assert.deepEqual(host.shared["agents.starred"], { a1: true });
  assert.equal([...walk(byId(v.render(), "agent-star-a1"))].find(e => e.kind === "svg").arg, "mods/spaces-agents/star-filled.svg");
  const { v: reopened, cx: reopenedCx } = await mount();
  assert.equal([...walk(byId(reopened.render(), "agent-star-a1"))].find(e => e.kind === "svg").arg, "mods/spaces-agents/star-filled.svg");
  byId(reopened.render(), "agent-star-a2").handlers.on_click({}, reopenedCx);
  byId(reopened.render(), "agent-star-a1").handlers.on_click({}, reopenedCx);
  assert.deepEqual(host.shared["agents.starred"], { a2: true });
  assert.deepEqual(ids(reopened.render()), ["space-s1", "ag-a1", "space-s2", "ag-a2"]);
});

for (const zoom of [1, 1.1]) {
  test(`double-clicking a worktree edits its name in place without moving it at zoom ${zoom}`, async () => {
    host.settings.zoom = zoom;
    const { v, cx } = await mount();
    const row = v.row({ w: host.spaces[1], i: 1, tree: true }, host.theme);
    row.handlers["on_mouse_down:left"]({ click_count: 1 }, cx);
    row.handlers["on_mouse_up:left"]({}, cx);
    assert.deepEqual(host.ran("space.select"), [{ id: "s2" }]);
    assert.deepEqual(host.ran("space.rename"), []);
    row.handlers["on_mouse_down:left"]({ click_count: 2 }, cx);
    row.handlers["on_mouse_up:left"]({}, cx);
    assert.deepEqual(host.ran("space.rename"), []);
    const editor = byId(v.render(), "rename-space-s2");
    assert.ok(editor);
    const input = [...walk(editor)].find(e => e.kind === "input");
    assert.equal(input.arg.value(), "sotong");
    input.arg.type("로그인 개선", cx);
    input.arg.submit(cx);
    assert.deepEqual(host.ran("space.rename"), [{ id: "s2", name: "로그인 개선" }]);
    assert.equal(byId(v.render(), "rename-space-s2"), null);
    assert.deepEqual(host.ran("space.select"), [{ id: "s2" }]);
    assert.deepEqual(host.ran("space.move"), []);
    assert.deepEqual(host.ran("tab.rename"), []);
  });
}

test("dragging a worktree still reorders it without renaming", async () => {
  const { v, cx } = await mount();
  const from = v.row({ w: host.spaces[1], i: 1, tree: true }, host.theme);
  const to = v.row({ w: host.spaces[0], i: 0 }, host.theme);
  from.handlers["on_mouse_down:left"]({ click_count: 1 }, cx);
  const edge = { local_position: { x: 40, y: 1 }, bounds: { width: 268, height: 30 } };
  to.handlers.on_mouse_move(edge, cx);
  to.handlers["on_mouse_up:left"](edge, cx);
  await cx.settle();
  assert.deepEqual(host.ran("space.move"), [{ id: "s2", index: 1 }]);
  assert.deepEqual(host.ran("space.rename"), []);
});

for (const [command, id] of [["rename:s2", "s2"], ["rename", "s1"]]) {
  test(`sidebar rename command ${command} opens an inline field`, async () => {
    const { v, cx } = await mount();
    host.command(command);
    await cx.settle();
    const editor = byId(v.render(), `rename-space-${id}`);
    assert.ok(editor);
    assert.deepEqual(host.ran("space.rename"), []);
    editor.handlers.on_key_down({ keystroke: "escape" }, cx);
    assert.equal(byId(v.render(), `rename-space-${id}`), null);
    assert.deepEqual(host.ran("space.rename"), []);
  });
}

test("rename shortcut unfolds the active workspace machine group", async () => {
  host.spaces[0].machine = "cloud";
  localStorage.setItem("machines.folded", JSON.stringify(["cloud"]));
  const { v, cx } = await mount();
  host.command("rename");
  await cx.settle();
  assert.ok(byId(v.render(), "rename-space-s1"));
  assert.deepEqual(JSON.parse(localStorage.getItem("machines.folded")), []);
});

test("favorites filter keeps spaces and only starred agents, persists, and restores all agents", async () => {
  host.shared["agents.starred"] = { a2: true };
  const { v, cx } = await mount();
  const toggle = byId(v.render(), "agents-favorites-only");
  assert.ok(toggle, "sidebar header has a favorites filter");
  toggle.handlers.on_click({}, cx);
  assert.equal(host.shared["agents.favoritesOnly"], true);
  assert.deepEqual(ids(v.render()), ["space-s1", "space-s2", "ag-a2"]);
  assert.deepEqual(host.agentOrder, ["a2"]);
  assert.deepEqual(host.runs, []);
  const { v: reopened, cx: reopenedCx } = await mount();
  assert.deepEqual(ids(reopened.render()), ["space-s1", "space-s2", "ag-a2"]);
  byId(reopened.render(), "agents-favorites-only").handlers.on_click({}, reopenedCx);
  assert.deepEqual(ids(reopened.render()), ["space-s1", "ag-a1", "space-s2", "ag-a2"]);
  assert.deepEqual(host.agentOrder, ["a1", "a2"]);
});

test("removing the last favorite clears displayed agents and published order while keeping spaces", async () => {
  host.shared["agents.starred"] = { a1: true };
  host.shared["agents.favoritesOnly"] = true;
  const { v, cx } = await mount();
  assert.deepEqual(ids(v.render()), ["space-s1", "ag-a1", "space-s2"]);
  byId(v.render(), "agent-star-a1").handlers.on_click({}, cx);
  assert.deepEqual(ids(v.render()), ["space-s1", "space-s2"]);
  assert.deepEqual(host.agentOrder, []);
  assert.match(text(v.render()), /No starred agents/);
  assert.ok(byId(v.render(), "agents-favorites-only"));
});

test("favorites filter preserves nested space hierarchy and narrow rail", async () => {
  host.shared["agents.starred"] = { a2: true };
  host.shared["agents.favoritesOnly"] = true;
  host.files.set("/app/data/space-hierarchy/parents.json", JSON.stringify({ parents: { "/x": "/r/main" } }));
  const { v } = await mount();
  assert.deepEqual(ids(v.render()), ["space-s1", "space-s2", "ag-a2"]);
  assert.equal(byId(v.render(), "ag-a2").props.pl, 52);
  host.layout.children[0].size.px = 76;
  const root = v.render();
  assert.deepEqual(ids(root).filter(id => id.startsWith("ag-")), []);
  assert.equal(byId(root, "agents-favorites-only"), null);
  assert.ok(byId(root, "collapse"));
});
