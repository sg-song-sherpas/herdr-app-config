import { exec, appHome, terminals, shared, setShared } from "herdr";

export const FAST_MODE_KEY = "agents.fast-mode";

function identity(term) {
  return JSON.stringify([term?.foreground?.pid, term?.foreground?.cwd ?? term?.cwd, term?.title]);
}

// One sidebar reader publishes the address map for both visible lists.
export class FastModeTracker {
  constructor(cx) {
    this.previous = {};
    this.busy = false;
    this.refresh(cx);
    cx.timer.every(3000, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy) return;
    const targets = [];
    for (const term of terminals()) {
      if (term.state !== "live" || term.address.includes("/") || term.report?.app !== "codex") continue;
      let session = null;
      try {
        const resume = JSON.parse(term.labels?.["herdr.resume"] ?? "null");
        if (resume?.agent === "codex" && resume.id && resume.pid === term.foreground?.pid) session = resume.id;
      } catch (_) {}
      // Resumed clients can use the shared daemon without producing a hook
      // label. The helper resolves those against exact loaded thread metadata.
      targets.push({ address: term.address, session, title: term.title,
        cwd: term.foreground?.cwd ?? term.cwd, identity: identity(term) });
    }
    this.busy = true;
    cx.spawn(async cx => {
      const modes = {};
      try {
        const result = await exec("/usr/bin/python3", [`${appHome()}/mods/spaces-agents/fast-mode.py`, JSON.stringify({
          targets, previous: this.previous,
        })], { timeout: 15000 });
        if (result.code !== 0) throw new Error(result.stderr);
        const response = JSON.parse(result.stdout);
        this.previous = response.states;
        const current = new Map(terminals().map(t => [t.address, t]));
        for (const target of targets) {
          const term = current.get(target.address);
          const session = response.resolved[target.address];
          // A process, title or cwd change during I/O requires a fresh lookup.
          if (term?.state === "live" && term.report?.app === "codex" && identity(term) === target.identity
              && this.previous[session]?.fast === true) modes[target.address] = true;
        }
      } catch (_) { this.previous = {}; }
      finally { this.busy = false; }
      if (JSON.stringify(shared(FAST_MODE_KEY) ?? {}) !== JSON.stringify(modes)) setShared(FAST_MODE_KEY, modes);
    });
  }
}
