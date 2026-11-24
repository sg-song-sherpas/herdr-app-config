import { appHome, readTextFile, writeTextFile } from "herdr";

function uniqueSpace(all, name, machine) {
  const matches = all.filter(s => s.name === name && (s.machine ?? null) === (machine ?? null) && s.folder);
  if (matches.length !== 1) throw new Error(`같은 머신에서 ${name} 공간을 하나로 찾지 못했습니다. 부모 공간을 확인해 주세요.`);
  return matches[0];
}

// This legacy rule supplies the dialog default; creation uses the checkbox.
export function isQaIssue(issue) {
  return (issue?.description ?? "").includes("Sentry 에러 자동 인입");
}

// Parent selection does not depend on the current tab or change the Git base.
export function parentLinks(qaIssue, all, machine) {
  const root = uniqueSpace(all, "Sherpas Basecamp", machine);
  if (!qaIssue) return { parent: root.folder, machine: root.machine ?? null };
  const qa = uniqueSpace(all, "QA", machine);
  if (qa.folder === root.folder) throw new Error("QA와 Sherpas Basecamp의 경로가 같습니다. 부모 공간을 확인해 주세요.");
  return { parent: qa.folder, root: root.folder, machine: root.machine ?? null };
}

// Use the same compare-and-write contract as the sidebar's drag-and-drop.
export async function saveParent(path, links) {
  const file = `${appHome()}/data/space-hierarchy/parents.json`;
  const expected = await readTextFile(file);
  const data = expected === null ? { version: 1, parents: {} } : JSON.parse(expected);
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.parents
      || typeof data.parents !== "object" || Array.isArray(data.parents)) {
    throw new Error("부모 관계 파일이 올바르지 않아 기존 내용을 보존했습니다.");
  }
  const key = path => links.machine ? JSON.stringify([links.machine, path]) : path;
  const parent = path => links.machine ? { machine: links.machine, path } : path;
  data.parents[key(path)] = parent(links.parent);
  if (links.root) data.parents[key(links.parent)] = parent(links.root);
  await writeTextFile(file, JSON.stringify(data, null, 2) + "\n", expected);
}
