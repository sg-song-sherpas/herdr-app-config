import { appHome, readTextFile, writeTextFile, exec, spaces, panes } from "herdr";

// A relationship is between folders on named machines, not between Git branches.
export function locationKey(on, path) {
  if (typeof path !== "string" || !path) throw new Error("워크트리 경로가 없습니다.");
  const normalized = /^[a-z]:[\\/]|^\\\\/i.test(path)
    ? path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    : path.replace(/\/+$/, "") || "/";
  return JSON.stringify([on || null, normalized]);
}

function location(raw) {
  if (typeof raw === "string") return { on: null, path: raw };
  if (!raw || typeof raw !== "object" || typeof raw.path !== "string"
      || (raw.machine != null && typeof raw.machine !== "string")) {
    throw new Error("부모·자식 워크트리 기록이 올바르지 않습니다.");
  }
  return { on: raw.machine || null, path: raw.path };
}

function childLocation(raw) {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === 2) return location({ machine: parsed[0], path: parsed[1] });
    } catch { /* A legacy folder name can start with a bracket. */ }
  }
  return location(raw);
}

async function parentFile() {
  const file = `${appHome()}/data/space-hierarchy/parents.json`;
  const expected = await readTextFile(file);
  const data = expected === null ? { version: 1, parents: {} } : JSON.parse(expected);
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.parents
      || typeof data.parents !== "object" || Array.isArray(data.parents)) {
    throw new Error("부모·자식 워크트리 기록을 읽지 못했습니다. 삭제하지 않았습니다.");
  }
  return { file, data, expected };
}

const RESOLVE_LOCAL_PATHS = "import json, os, sys; paths=json.loads(sys.argv[1]); print(json.dumps({p:os.path.realpath(p) if os.path.isabs(p) else p for p in paths}, ensure_ascii=False))";

async function resolveLocalPaths(locations, resolved) {
  const paths = [...new Set(locations.filter(node => !node.on).map(node => node.path))]
    .filter(path => !resolved.has(path));
  if (!paths.length) return;
  const result = await exec("python3", ["-c", RESOLVE_LOCAL_PATHS, JSON.stringify(paths)], { on: null, timeout: 60000 });
  if (result.code !== 0) throw new Error(result.stderr || "워크트리의 실제 경로를 확인하지 못했습니다.");
  const mapping = JSON.parse(result.stdout);
  for (const path of paths) {
    if (typeof mapping[path] !== "string" || !mapping[path]) throw new Error("워크트리의 실제 경로를 확인하지 못했습니다.");
    resolved.set(path, mapping[path]);
  }
}

async function inventory(main, on) {
  // Run the installed orchestration CLI on this computer; it routes remote
  // Git reads to the requested machine and includes hidden Git worktrees.
  const result = await exec("herdr-orchestrate", ["worktree", "list", "--repo", main,
    ...(on ? ["--on", on] : [])], { timeout: 60000 });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || "워크트리 목록을 조회하지 못했습니다.");
  const rows = JSON.parse(result.stdout);
  if (!Array.isArray(rows)) throw new Error("워크트리 목록 형식이 올바르지 않습니다.");
  return rows;
}

function currentFolder(space, allPanes) {
  const tabs = new Set((space.tabs ?? []).map(tab => tab.id));
  return allPanes.find(pane => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

export async function buildRemovalPlan(root, on, { git, repoOf, submodules }) {
  const { data } = await parentFile();
  const allSpaces = spaces(), allPanes = panes();
  const rawLinks = Object.entries(data.parents).map(([raw, parent]) => [childLocation(raw), parent === null ? null : location(parent)]);
  const rootRows = await inventory(root.main, on || null);
  const rowLocations = rows => rows.flatMap(row => {
    const child = location({ machine: row.machine, path: row.path });
    return row.parent == null ? [child] : [child, location(row.parent)];
  });
  const resolved = new Map();
  await resolveLocalPaths([
    {on:on || null, path:root.top}, ...rawLinks.flatMap(([child, parent]) => parent ? [child, parent] : [child]),
    ...rowLocations(rootRows),
    ...allSpaces.filter(space => space.folder).map(space => ({on:space.machine || null, path:space.folder})),
  ], resolved);
  const canonical = node => ({...node, path:node.on ? node.path : resolved.get(node.path) ?? node.path});
  const canonicalKey = (machine, path) => locationKey(machine, canonical({on:machine || null, path}).path);
  const links = new Map(), explicit = new Set(), nodes = new Map(), registrations = new Map();
  const add = (rawChild, rawParent, override = false) => {
    const child = canonical(rawChild);
    const key = locationKey(child.on, child.path);
    const parent = rawParent === null ? null : canonical(rawParent);
    const parentKey = parent === null ? null : locationKey(parent.on, parent.path);
    if (override && explicit.has(key) && links.get(key) !== parentKey) {
      throw new Error(`${child.path}: 같은 워크트리에 서로 다른 부모 기록이 있습니다. 부모 관계를 확인해 주세요.`);
    }
    if (!override && explicit.has(key)) return;
    nodes.set(key, child);
    links.set(key, parentKey);
    if (override) explicit.add(key);
  };
  for (const [child, parent] of rawLinks) add(child, parent, true);
  const checkedRepos = new Set();
  const loadRepo = async (repo, machine) => {
    const key = locationKey(machine, repo.main);
    if (checkedRepos.has(key)) return;
    checkedRepos.add(key);
    const rows = key === locationKey(on || null, root.main) ? rootRows : await inventory(repo.main, machine);
    await resolveLocalPaths(rowLocations(rows), resolved);
    for (const row of rows) {
      const child = { on: row.machine || null, path: row.path };
      if (child.on !== (machine || null)) throw new Error("워크트리 목록의 머신이 조회 대상과 다릅니다.");
      registrations.set(canonicalKey(child.on, child.path), row);
      add(child, row.parent == null ? null : location(row.parent));
    }
  };
  const rootNode = canonical({ on: on || null, path: root.top });
  const rootKey = locationKey(rootNode.on, rootNode.path);
  await loadRepo(root, rootNode.on);
  const targets = [], order = [], visiting = new Set(), visited = new Set();
  const visit = async (node, depth) => {
    const key = locationKey(node.on, node.path);
    if (visiting.has(key)) throw new Error("부모·자식 워크트리 관계가 순환해 삭제 대상을 확정하지 못했습니다.");
    if (visited.has(key)) return;
    visiting.add(key);
    const repo = key === rootKey ? root : await repoOf(node.path, node.on);
    if (!repo || !repo.linked || locationKey(node.on, repo.top) !== key) {
      throw new Error(`${node.path}: 연결된 Git 워크트리인지 확인하지 못했습니다. 삭제하지 않았습니다.`);
    }
    await loadRepo(repo, node.on);
    const registration = registrations.get(key);
    if (!registration || registration.prunable || registration.locked) {
      throw new Error(`${node.path}: Git 등록이 없거나 접근할 수 없거나 잠긴 워크트리입니다. 삭제하지 않았습니다.`);
    }
    const matches = allSpaces.filter(space => {
      const folder = space.folder || currentFolder(space, allPanes);
      return folder && (space.machine || null) === node.on && canonicalKey(node.on, folder) === key;
    });
    if (key === rootKey && root.space) {
      const selected = allSpaces.find(space => space.id === root.space);
      if (selected && !matches.includes(selected)) {
        const folder = currentFolder(selected, allPanes);
        const here = folder && canonicalKey(node.on, folder);
        const normalizedTop = JSON.parse(key)[1];
        const normalizedFolder = here ? JSON.parse(here)[1] : "";
        if (here !== key && !normalizedFolder.startsWith(normalizedTop + "/")) {
          throw new Error("선택한 공간의 작업 폴더가 바뀌었습니다. 삭제창을 다시 열어 주세요.");
        }
        matches.push(selected);
      }
    }
    const status = await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], node.on);
    if (!status.ok) throw new Error(`${node.path}: ${status.err || "변경 내용을 확인하지 못했습니다."}`);
    const { mods, unpushed } = await submodules(repo.top, node.on);
    const dirty = Boolean(status.out);
    targets.push({
      key, aliases: [...resolved].filter(([raw, physical]) => locationKey(null, physical) === key).map(([raw]) => locationKey(null, raw)),
      on: node.on, top: repo.top, main: repo.main, branch: registration.branch ?? null,
      parent: links.get(key) ?? null, depth, name: matches[0]?.name || registration.branch || node.path.replace(/\\/g, "/").split("/").pop(),
      spaceIds: matches.map(space => space.id), dirty, warned: [...unpushed], force: dirty || mods.length > 0,
    });
    // Loading a different repository may discover more siblings. Revisit the
    // child set after each load, without repeating repository or status reads.
    for (;;) {
      const children = [...links].filter(([child, parent]) => parent === key && !visited.has(child))
        .map(([child]) => nodes.get(child)).sort((a, b) => locationKey(a.on, a.path).localeCompare(locationKey(b.on, b.path)));
      if (!children.length) break;
      for (const child of children) await visit(child, depth + 1);
    }
    visiting.delete(key);
    visited.add(key);
    order.push(key);
  };
  await visit(rootNode, 0);
  return { root: { ...root, on: rootNode.on }, targets, order };
}

export function validateRemovalPlan(approved, current) {
  const manifest = plan => plan.targets.map(target => [target.key, locationKey(target.on, target.main), target.branch, target.parent])
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (JSON.stringify(manifest(approved)) !== JSON.stringify(manifest(current))) {
    const error = new Error("함께 삭제할 워크트리나 부모 관계가 바뀌었습니다. 삭제창을 다시 열어 목록을 확인해 주세요.");
    error.cancelled = true;
    throw error;
  }
  const acknowledged = new Map(approved.targets.map(target => [target.key, target]));
  for (const target of current.targets) {
    const before = acknowledged.get(target.key);
    if ((target.dirty && !before.dirty) || target.warned.some(name => !before.warned.includes(name))) {
      const error = new Error(`${target.top}: 새 변경 내용이 발견됐습니다. 삭제창을 다시 열어 경고를 확인해 주세요.`);
      error.cancelled = true;
      throw error;
    }
  }
}

export async function forgetRemovedParents(removed) {
  if (!removed.length) return;
  const { file, data, expected } = await parentFile();
  const deleted = new Set(removed.flatMap(target => [target.key, ...(target.aliases ?? [])]));
  let changed = false;
  for (const raw of Object.keys(data.parents)) {
    const child = childLocation(raw);
    if (deleted.has(locationKey(child.on, child.path))) {
      delete data.parents[raw];
      changed = true;
    }
  }
  if (changed) await writeTextFile(file, JSON.stringify(data, null, 2) + "\n", expected);
}
