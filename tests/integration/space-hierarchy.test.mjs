import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { walk, byId } from "../fakes/element.mjs";
import Spaces from "../../mods/spaces-agents/main.js";

beforeEach(() => { host.reset(); localStorage.clear(); });
const config = "/app/data/space-hierarchy/parents.json";
const folder = name => `/Sherpas/${name}`;
const displayed = root => [...walk(root)].map(e => e.props.id).filter(id => /^space-(main|qr|qa|onboarding|saas)$/.test(id));

async function mount(parents) {
  host.layout = { children: [{ id: "sidebar", size: { px: 268 } }] };
  host.spaces = ["main", "qr", "saas", "qa", "onboarding"].map(id => ({ id, name: id, folder: folder(id), tabs: [{ id: `t-${id}` }] }));
  host.agents = [{ address: "agent-qr", space: "qr", tab: "t-qr", pane: "p-qr", status: "idle" }];
  host.files.set(config, JSON.stringify({ version: 1, parents }));
  host.exec = async (_cmd, args, { cwd }) => ({ code: 0, stderr: "", stdout: args.includes("status") ? "# branch.head main\n" : args.includes("--git-common-dir") ? folder("main") + "/.git\n" : cwd + "\n" });
  const cx = makeCx(), v = new Spaces(); v.init({}, cx);
  await cx.settle(); await cx.tick(); await cx.settle();
  return { v, cx };
}

test("restored parents group worktrees and indent their agents at the matching depth", async () => {
  const { v } = await mount({ [folder("qr")]: folder("qa"), [folder("saas")]: folder("onboarding") });
  const root = v.render();
  assert.deepEqual(displayed(root), ["space-main", "space-qa", "space-qr", "space-onboarding", "space-saas"]);
  const label = id => [...walk(byId(root, id))].find(e => e.props.pl !== undefined);
  assert.equal(label("space-qr").props.pl, 40);
  assert.equal(label("space-qa").props.pl, 22);
  assert.equal(byId(root, "ag-agent-qr").props.pl, 70);
  assert.deepEqual(host.agentOrder, ["agent-qr"]);
  assert.deepEqual(host.ran("space.close"), []);
});

test("missing parents fall back to the Git repository group", async () => {
  const { v } = await mount({ [folder("qr")]: folder("missing") });
  assert.equal(v.ordered().find(r => r.w.id === "qr").depth, 1);
});

test("cycles never drop spaces or recurse forever", async () => {
  const { v } = await mount({ [folder("qr")]: folder("qa"), [folder("qa")]: folder("qr") });
  const ids = displayed(v.render());
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
});

test("parent changes reload without restarting sessions", async () => {
  const { v, cx } = await mount({});
  v.render(); host.runs = [];
  host.files.set(config, JSON.stringify({ parents: { [folder("qr")]: folder("qa") } }));
  host.fireWatch(); await cx.settle();
  assert.equal(v.ordered().find(r => r.w.id === "qr").depth, 2);
  assert.deepEqual(host.ran("space.new"), []);
});
