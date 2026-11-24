export function rowKey(row) { return `${row.address}:${row.token}`; }

export function canSelect(row) {
  return row.state === "pending" && row.reason === "ready" && !row.requested;
}

export function selectedTargets(rows, selected) {
  return rows.filter(row => canSelect(row) && selected.has(rowKey(row)))
    .map(({address, token}) => ({address, token}));
}

export function rowLabel(row) {
  if (row.requested && row.state === "pending") return "재개 대기";
  if (row.state === "attempted" || row.state === "uncertain") return "전송 확인 필요";
  return ({
    ready: "재개 가능", settling: "입력 준비 확인 중", unknown: "작업 상태 확인 중",
    different_session: "대화 확인 필요", working: "현재 작업 중",
    blocked: "승인 또는 답변 대기", error: "오류 확인 필요", done: "이미 완료",
  })[row.reason] ?? "확인 필요";
}

export function tabNames(allSpaces) {
  const names = new Map();
  for (const space of allSpaces) for (const tab of space.tabs ?? []) {
    names.set(tab.id, {name: tab.name, space: space.name});
  }
  return names;
}

export function pendingCount(allTerminals) {
  return allTerminals.filter(terminal => {
    if (terminal.state !== "live" || terminal.address?.includes("/")) return false;
    try {
      const saved = JSON.parse(terminal.labels?.["herdr.autoResume"] ?? "null");
      const continuation = saved?.continuation;
      return ["pending", "attempted", "uncertain"].includes(continuation?.state)
        && continuation.recovery_root_pid === terminal.pid;
    } catch { return false; }
  }).length;
}
