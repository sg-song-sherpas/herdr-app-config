// Each worktree's pull request, for its card: one `gh pr list` per repo (not
// per worktree), matched to worktrees by branch. Mods can't import from each
// other, so the bits of the GitHub panel's common.js this needs are copied here.

import { exec, home } from "herdr";

// gh lives wherever the person installed it, and the app's PATH may not have it.
let bin = null;
async function ghBin() {
  if (bin) return bin;
  for (const b of ["gh", `${home()}/.nix-profile/bin/gh`, "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try { if ((await exec(b, ["--version"])).code === 0) return (bin = b); } catch { /* not there */ }
  }
  return null;
}

/** owner/repo from a GitHub remote URL (https or ssh), else null. */
export function parseRemote(url) {
  const m = String(url ?? "").trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The GitHub repo of the checkout at `cwd` (its origin), else null. */
export async function slugOf(cwd, on) {
  try {
    const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
    return r.code === 0 ? parseRemote(r.stdout) : null;
  } catch { return null; }
}

/** The repo's recent PRs (open and closed), the open ones with their checks;
 *  null when gh can't say. Two asks: checks for 100 PRs of every state is more
 *  than GitHub answers in time (a 504), and only open PRs show theirs. The
 *  quick one (every state, ~2s) goes to `early` before the checks (~9s) are in. */
export async function listPrs(slug, early = () => {}) {
  const gh = await ghBin();
  if (!gh) return null;
  const ask = async (state, limit, fields) => {
    try {
      const r = await exec(gh, ["pr", "list", "-R", slug, "--state", state, "--limit", String(limit), "--json", fields]);
      return r.code === 0 ? JSON.parse(r.stdout || "[]") : null;
    } catch { return null; }
  };
  const [open, all] = await Promise.all([
    ask("open", 100, "number,title,headRefName,state,isDraft,url,statusCheckRollup"),
    ask("all", 200, "number,title,headRefName,state,isDraft,url").then((all) => { if (all) early(all); return all; }),
  ]);
  if (!open && !all) return null;
  const byNumber = new Map((all ?? []).map((p) => [p.number, p]));
  for (const p of open ?? []) byNumber.set(p.number, p);
  return [...byNumber.values()];
}

/** A branch's PR: its open one, else its newest. */
export function prFor(prs, branch) {
  const mine = (prs ?? []).filter((p) => p.headRefName === branch).sort((a, b) => b.number - a.number);
  return mine.find((p) => p.state === "OPEN") ?? mine[0] ?? null;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
/** A PR's checks in one word: "failure", "pending", "success", or null when it has none. */
export function checkState(rollup) {
  if (!rollup?.length) return null;
  const each = rollup.map((c) => (c.__typename === "StatusContext"
    ? (c.state === "SUCCESS" ? "ok" : FAILED.has(c.state) ? "bad" : "wait")
    : c.status !== "COMPLETED" ? "wait" : FAILED.has(c.conclusion) ? "bad" : "ok"));
  return each.includes("bad") ? "failure" : each.includes("wait") ? "pending" : "success";
}

export function prState(pr) {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

// GitHub's state colors, readable on light and dark (as the GitHub panel's).
export const COLOR = { open: "#2da44e", draft: "#8b949e", merged: "#8957e5", closed: "#e5534b",
  success: "#2da44e", failure: "#e5534b", pending: "#d4a72c" };
