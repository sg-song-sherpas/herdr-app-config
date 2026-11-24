import { spaces, panes, terminals, run } from "herdr";

// Codex already creates a conversation title. Freeze it as the tab's name
// after a completed response, so later turns do not keep changing the tab.
function candidate(tab, allPanes, allTerminals) {
  // The New menu explicitly names new Codex tabs "Codex".
  if (tab.named && tab.name !== "Codex") return null;
  const lead = allPanes.find(p => p.tab === tab.id && p.terminal && p.program?.agent);
  if (!lead) return null;
  const term = allTerminals.find(t => t.address === lead.terminal);
  if (!term || term.state !== "live" || term.report?.app !== "codex"
      || !["idle", "done"].includes(term.status) || !(term.turn > 0)) return null;
  const name = (term.title ?? "").replace(/^[\u2800-\u28ff✳●◦•✓✔⏺]\s*/, "")
    .split(" | ")[0].replace(/^Codex\s*[·:|—-]\s*/i, "").replace(/\s+/g, " ").trim();
  // The completion event can precede Codex's asynchronous session-title update.
  // At that point OSC still contains only the cwd basename (e.g. songseongwon).
  // Leave the tab eligible so the later title event retries the rename.
  const folders = [term.cwd, term.foreground?.cwd, lead.cwd]
    .filter(Boolean).map(path => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop());
  if (folders.includes(name)) return null;
  if (!name || /^(?:codex|terminal|new (?:chat|thread)|untitled|working|thinking)$/i.test(name)
      || /^[~/]|^[A-Za-z]:\\/.test(name)) return null;
  return { name, terminal: term.address, turn: term.turn };
}

export class CodexAutoName {
  constructor() {
    this.saved = new Set(JSON.parse(localStorage.getItem("codex-auto-named-tabs") ?? "[]"));
    this.pending = new Set();
  }

  sync(cx) {
    if (!cx) return;
    const all = spaces().flatMap(s => s.tabs), ps = panes(), ts = terminals();
    for (const tab of all) {
      if (this.saved.has(tab.id) || this.pending.has(tab.id)) continue;
      const next = candidate(tab, ps, ts);
      if (!next) continue;
      this.pending.add(tab.id);
      // Run outside render and recheck: the person can rename/close/switch
      // the conversation, or start a new turn, before this callback fires.
      cx.timer.after(250, cx => {
        this.pending.delete(tab.id);
        const current = spaces().flatMap(s => s.tabs).find(t => t.id === tab.id);
        const fresh = current && candidate(current, panes(), terminals());
        if (!fresh || this.saved.has(tab.id) || fresh.terminal !== next.terminal
            || fresh.turn !== next.turn) return;
        run("tab.rename", { id: tab.id, name: fresh.name });
        this.saved.add(tab.id);
        // Drop closed tab ids, keeping personal mod state bounded.
        const live = new Set(spaces().flatMap(s => s.tabs.map(t => t.id)));
        this.saved = new Set([...this.saved].filter(id => live.has(id)));
        localStorage.setItem("codex-auto-named-tabs", JSON.stringify([...this.saved]));
        cx.notify();
      });
    }
  }
}
