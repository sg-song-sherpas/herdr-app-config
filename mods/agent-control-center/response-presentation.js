// Pure display guards. A saved result never crosses a native process/session identity.
const line = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim() : "";

export function responseIdentity(terminal, resume = null) {
  if (!terminal?.address) return null;
  return JSON.stringify([
    terminal.address, terminal.created_ms ?? terminal.created ?? "", terminal.pid ?? "",
    terminal.foreground?.pid ?? "", resume?.id ?? "",
  ]);
}

export function responsePresentation(terminal, entry, identityKey) {
  if (!terminal) return { state: "missing", chip: "세션 확인 중",
    headline: "에이전트의 최근 응답을 기다리고 있습니다.", caption: "원문은 해당 터미널에서 확인할 수 있습니다." };
  const sameIdentity = Boolean(identityKey && entry?.identityKey === identityKey);
  const turn = terminal.turn, savedTurn = entry?.turn;
  const current = sameIdentity && Number.isInteger(turn) && Number.isInteger(savedTurn) && turn === savedTurn;
  const previous = entry?.previous;
  const validPrevious = sameIdentity && Number.isInteger(turn) && Number.isInteger(previous?.turn) &&
    previous.turn >= 0 && previous.turn <= turn && Boolean(line(previous.summary)) &&
    (!previous.identityKey || previous.identityKey === identityKey);
  const previousView = phase => validPrevious ? {
    state: "previous", chip: "지난 응답 · AI 정제", headline: line(previous.summary),
    caption: `${phase} · 지난 ${previous.turn}회차 요약 · 검증 전`,
  } : null;
  if (terminal.status === "working") return previousView("현재 응답 작성 중") ?? { state: "active", chip: "응답 작성 중",
    headline: "새 응답을 작성하고 있습니다.",
    caption: "이전 응답의 AI 요약은 이력에서 확인할 수 있습니다." };
  if (terminal.status === "blocked") return previousView("현재 응답 대기 중") ?? {
    state: "paused", chip: "응답 대기", headline: "에이전트가 응답 대기 상태입니다.",
    caption: "구체적인 요청은 해당 터미널에서 확인하세요.",
  };
  if (terminal.status === "error") return previousView("현재 오류 상태") ?? {
    state: "error", chip: "오류 상태", headline: "에이전트가 오류 상태를 보고했습니다.",
    caption: "오류 내용은 해당 터미널에서 확인하세요.",
  };
  if (current && entry.state === "ready" && line(entry.summary)) return {
    state: "ready", chip: "AI 정제됨", headline: line(entry.summary),
    caption: `${entry.provider === "claude" ? "Claude" : entry.provider === "codex" ? "Codex" : "AI"}${line(entry.model) ? ` · ${line(entry.model)}` : ""} · 원문 기반 요약 · 검증 전`,
  };
  if (current && ["pending", "working"].includes(entry.state)) return previousView("새 응답 정제 중") ?? {
    state: "pending", chip: "정제 중", headline: "최근 응답을 AI로 정리하고 있습니다.",
    caption: "준비되면 한 줄 요약이 표시됩니다. 원문은 터미널에 있습니다.",
  };
  if (current && entry.state === "failed" && entry.error === "usage_limit") return previousView("Codex 구독 사용량 한도 · 새 정제 대기") ?? {
    state: "failed", chip: "사용량 한도", headline: "구독 사용량 한도로 AI 정제를 기다리고 있습니다.",
    caption: "반복 호출을 제한합니다. 원문은 터미널에서 확인할 수 있습니다.",
  };
  if (current && entry.state === "failed") return {
    state: "failed", chip: "정제 실패", headline: "최근 응답을 정리하지 못했습니다.",
    caption: "원문은 터미널에 보존됩니다. 이 섹션에서 이력을 확인하세요.",
  };
  if (current && entry.state === "empty") return previousView("이번 응답은 정리할 내용 없음") ?? {
    state: "empty", chip: "내용 없음", headline: "이번 응답에는 정리할 내용이 없습니다.",
    caption: "응답 원문은 해당 터미널에서 확인할 수 있습니다.",
  };
  return previousView("새 응답 정제 중") ?? { state: "pending", chip: "응답 확인 중", headline: "최근 응답의 AI 정제를 기다리고 있습니다.",
    caption: sameIdentity && entry?.state === "ready" ? "이전 응답의 요약은 이력에서 확인할 수 있습니다." :
      "원문은 해당 터미널에서 확인할 수 있습니다." };
}

export function headlineSize(width) {
  return width < 600 ? 16 : 18;
}

export function preparedHistory(entries) {
  return (Array.isArray(entries) ? entries : []).slice(0, 30).map(entry => {
    const ready = entry.state === "ready" && Boolean(line(entry.summary));
    return { ...entry, ready, headline: ready ? line(entry.summary) :
      entry.state === "failed" && entry.error === "usage_limit" ? "구독 사용량 한도로 정제하지 못한 응답입니다." :
      entry.state === "failed" ? "이 응답의 AI 정제에 실패했습니다." :
      entry.state === "empty" ? "정리할 내용이 없는 응답입니다." : "AI 정제 결과가 아직 없습니다.",
      caption: entry.source === "session" ? "원문 출처 · 저장된 세션 기록" :
        entry.source === "terminal" ? "원문 출처 · 터미널 응답" : "원문 출처 · 확인되지 않음" };
  });
}
