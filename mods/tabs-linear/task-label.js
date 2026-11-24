// Kept identical in both mods: Herdr mods cannot import each other.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// Each tab's lead pane: its first agent, else its focused terminal, else its first.
export function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

// A tab someone named, else the agent's own title when it says something.
export function tabTitle(tab, l, spaceName = "") {
  const prog = l?.program?.name;
  const raw = (l?.title ?? "").trim();
  const live = clean(raw);
  // A path (~/src, /usr, C:\) is a shell's title, not news: check before
  // clean() strips its leading ~/ or /.
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(raw) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  const strip = value => clean(value).replace(/^(?:Codex|Claude(?: Code)?|Gemini|OpenCode)\s*[·:|—-]\s*/i, "");
  const selected = strip((tab.name === prog || !tab.named) && telling ? live : tab.name);
  if (/^Linked Linear issue\s*:/i.test(selected)) {
    return spaceName.replace(/^[A-Z][A-Z0-9]*-\d+\s*/, "").trim() || selected.replace(/^Linked Linear issue\s*:\s*/i, "");
  }
  return selected;
}
