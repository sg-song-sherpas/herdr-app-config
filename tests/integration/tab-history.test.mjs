import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { host } from "herdr";
import { makeCx } from "../fakes/cx.mjs";
import { byId, text } from "../fakes/element.mjs";
import Tabs from "../../mods/tabs-linear/main.js";

beforeEach(() => {
  host.reset();
  localStorage.clear();
  host.spaces = [{ id: "s", active: true, tabs: ["a", "b", "c"].map(id => ({ id, name: id, active: id === "a" })) }];
});

async function mount() {
  const cx = makeCx(), v = new Tabs();
  v.init({}, cx);
  v.render();
  await cx.settle();
  return { v, cx };
}

function select(v, id) {
  for (const s of host.spaces) {
    s.active = s.tabs.some(t => t.id === id);
    for (const t of s.tabs) t.active = t.id === id;
  }
  v.render();
}

test("Control+Tab in main-linear uses the last visited tab command", () => {
  const keys = JSON.parse(readFileSync(new URL("../../keys.json", import.meta.url), "utf8"));
  assert.equal(keys["layout:main-linear"]["ctrl-tab"], "tabs-linear.previous");
});

test("previous toggles last visited tabs rather than adjacent tabs", async () => {
  const { v, cx } = await mount();
  select(v, "c");
  v.render(); // Repaints must not replace the previous tab.
  host.command("previous");
  await cx.settle();
  v.render().handlers.on_modifiers_changed({ modifiers: { control: false } }, cx);
  assert.deepEqual(host.ran("tab.select"), [{ id: "a" }]);
  select(v, "a");
  host.command("previous");
  await cx.settle();
  v.render().handlers.on_modifiers_changed({ modifiers: { control: false } }, cx);
  assert.deepEqual(host.ran("tab.select"), [{ id: "a" }, { id: "c" }]);
});

test("previous ignores closed tabs and can return to a tab in another space", async () => {
  const { v, cx } = await mount();
  host.spaces.push({ id: "other", active: false, tabs: [{ id: "d", name: "d" }] });
  select(v, "b");
  select(v, "d");
  host.spaces[0].tabs = host.spaces[0].tabs.filter(t => t.id !== "b");
  host.command("previous");
  await cx.settle();
  v.render().handlers.on_modifiers_changed({ modifiers: { control: false } }, cx);
  assert.deepEqual(host.ran("tab.select"), [{ id: "a" }]);
});

test("previous does nothing before another tab has been visited", async () => {
  const { cx } = await mount();
  host.command("previous");
  await cx.settle();
  assert.deepEqual(host.ran("tab.select"), []);
});


test("holding Control freezes MRU order, previews older tabs, and commits only on release", async () => {
  const { v, cx } = await mount();
  select(v, "b"); select(v, "c");
  host.command("previous"); await cx.settle();
  assert.deepEqual(host.ran("tab.select"), []);
  let strip = byId(v.render(), "tab-switcher");
  assert.ok(strip);
  assert.match(text(strip), /c.*b.*a/);
  assert.equal(byId(strip, "recent-b").props.bg, host.theme.selected);
  host.command("previous"); await cx.settle();
  strip = byId(v.render(), "tab-switcher");
  assert.equal(byId(strip, "recent-a").props.bg, host.theme.selected);
  host.command("previous-reverse"); await cx.settle();
  assert.equal(byId(v.render(), "recent-b").props.bg, host.theme.selected);
  v.render().handlers.on_modifiers_changed({ modifiers: { control: false } }, cx);
  assert.deepEqual(host.ran("tab.select"), [{ id: "b" }]);
  assert.equal(byId(v.render(), "tab-switcher"), null);
});

test("plain Tab and Shift+Tab move the chooser and Escape cancels", async () => {
  const { v, cx } = await mount();
  select(v, "b"); select(v, "c");
  host.command("previous"); await cx.settle();
  v.render().handlers.on_key_down({ key: "tab", modifiers: { shift: false } }, cx);
  assert.equal(byId(v.render(), "recent-a").props.bg, host.theme.selected);
  v.render().handlers.on_key_down({ key: "tab", modifiers: { shift: true } }, cx);
  assert.equal(byId(v.render(), "recent-b").props.bg, host.theme.selected);
  v.render().handlers.on_key_down({ key: "escape", modifiers: {} }, cx);
  assert.equal(byId(v.render(), "tab-switcher"), null);
  assert.deepEqual(host.ran("tab.select"), []);
});

test("a quick Control tap commits even when release precedes keyboard focus", async () => {
  const { v, cx } = await mount();
  select(v, "b");
  host.exec = async () => ({ code: 0, stdout: "released\n", stderr: "" });
  host.command("previous"); await cx.settle();
  assert.deepEqual(host.ran("tab.select"), [{ id: "a" }]);
  assert.equal(byId(v.render(), "tab-switcher"), null);
});

test("a late native release from a cancelled chooser cannot commit a newer chooser", async () => {
  const { v, cx } = await mount();
  select(v, "b");
  const pending = [];
  host.exec = () => new Promise(resolve => pending.push(resolve));
  host.command("previous"); await cx.settle();
  v.render().handlers.on_key_down({ key: "escape", modifiers: {} }, cx);
  host.command("previous"); await cx.settle();
  pending[0]({ code: 0, stdout: "released\n" }); await cx.settle();
  assert.ok(byId(v.render(), "tab-switcher"));
  assert.deepEqual(host.ran("tab.select"), []);
  pending[1]({ code: 0, stdout: "released\n" }); await cx.settle();
  assert.deepEqual(host.ran("tab.select"), [{ id: "a" }]);
});

test("recent tabs open below the intact tab bar as a vertical dropdown", async () => {
  const { v, cx } = await mount();
  select(v, "b"); select(v, "c");
  host.command("previous"); await cx.settle();
  const root = v.render();
  assert.ok(byId(root, "tab-scroll"), "the normal tabs stay visible");
  assert.ok(byId(root, "tab-new"), "the new-tab button stays visible");
  assert.ok(byId(root, "panel-linear"), "panel controls stay visible");
  const popup = byId(root, "recent-tabs-popup");
  assert.equal(popup.props.anchor, "top_left");
  assert.equal(byId(root, "tab-switcher").kind, "v_flex");
  assert.match(text(byId(root, "recent-b")), /b/);
});
