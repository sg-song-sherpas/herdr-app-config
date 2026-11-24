// Unified diff text stays intact in the board. Only its presentation is parsed.
export const DIFF_SAMPLE = "example.js\n@@ -1 +1 @@\n-const enabled = false;\n+const enabled = true;";

export function parseDiff(value = "") {
  const lines = String(value).replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const rows = [], files = new Set();
  let title = "Git diff", previousFile = "", oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0;
  // A hand-written card can begin with a filename, followed by diff lines.
  if (lines[0] && !/^(diff |index |--- |[ +\-@\\])/.test(lines[0])) title = lines.shift();
  for (const text of lines) {
    const hunk = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    let kind = "meta", old = "", next = "";
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldLeft = Number(hunk[2] ?? 1); newLeft = Number(hunk[4] ?? 1);
      kind = "hunk";
    } else if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith("-")) { kind = "remove"; old = oldLine++; oldLeft--; }
      else if (text.startsWith("+")) { kind = "add"; next = newLine++; newLeft--; }
      else if (text.startsWith(" ") || text === "") {
        kind = "context"; old = oldLine++; next = newLine++; oldLeft--; newLeft--;
      }
    } else if (text.startsWith("+++ ") || text.startsWith("--- ")) {
      const file = text.slice(4).split("\t")[0].replace(/^[ab]\//, "");
      if (text.startsWith("--- ")) previousFile = file;
      else if (file !== "/dev/null") files.add(file);
      else if (previousFile && previousFile !== "/dev/null") files.add(previousFile);
    } else if (text.startsWith("+")) kind = "add";
    else if (text.startsWith("-")) kind = "remove";
    else if (text.startsWith(" ")) kind = "context";
    rows.push({ text, kind, old, next });
  }
  if (files.size === 1) title = [...files][0];
  else if (files.size > 1) title = `Git diff · ${files.size} files`;
  return { title, rows };
}

export function diffColors(dark) {
  return dark
    ? { background: "#18202b", header: "#253041", border: "#526176", text: "#e2e8f0", muted: "#a6b2c4",
      add: ["#183d2c", "#a0efb4"], remove: ["#48282d", "#ffb4bb"], hunk: ["#203650", "#a8ceff"], meta: ["#222c39", "#b6c3d4"] }
    : { background: "#ffffff", header: "#f1f5f9", border: "#94a3b8", text: "#243247", muted: "#64748b",
      add: ["#e6f6e9", "#176534"], remove: ["#ffebed", "#a82336"], hunk: ["#e8f1ff", "#245b99"], meta: ["#f8fafc", "#64748b"] };
}

// Targets use the current (new) file. Removed rows point at the following new line.
// Deleted files have no current-file target. Unnumbered handwritten rows use line 1.
export function diffTargets(source = "") {
  const { title, rows } = parseDiff(source);
  const safe = path => typeof path === "string" && path && path !== "/dev/null"
    && !/^(?:\/|[A-Za-z]:|\\)/.test(path) && !path.split(/[\\/]/).includes("..")
    && !/[\x00-\x1f]/.test(path) && !path.startsWith('"') ? path : null;
  const manual = String(source).split(/\r?\n/)[0] === title;
  let path = manual ? safe(title) : null, line = 1;
  return rows.map(row => {
    if (row.text.startsWith("diff --git ")) { path = null; line = 1; }
    if (row.text.startsWith("+++ ") && row.kind === "meta") {
      let file = row.text.slice(4).split("\t")[0];
      if (file.startsWith('"')) { try { file = JSON.parse(file.replace(/(?:\\[0-7]{3})+/g, bytes =>
          decodeURIComponent(bytes.match(/\\[0-7]{3}/g).map(byte => `%${parseInt(byte.slice(1), 8).toString(16).padStart(2, "0")}`).join("")))); } catch { file = null; } }
      path = safe(file?.replace(/^b\//, ""));
    }
    if (row.kind === "hunk") line = Number(row.text.match(/\+(\d+)/)?.[1] ?? 1);
    if (!["add", "remove", "context"].includes(row.kind)) return null;
    const target = path ? { path, line: Math.max(1, Number(row.next) || line) } : null;
    if (row.next !== "") line = Number(row.next) + 1;
    return target;
  });
}
