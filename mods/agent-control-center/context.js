export const DEFAULT_CONFIG = {
  enabled: true,
  autoDisplay: "important", showRepository: true, showDecisions: true,
  showTests: true, showNextAction: true, autoSnapshot: true,
  gitMonitoring: true, conflictDetection: true, dependencyAnalysis: true,
  attentionQueue: true, priorityThreshold: 0, summaryProvider: "none", summaryModel: "", summaryConsent: false,
  retentionDays: 30, classicLayout: "main-linear",
};

export function configOf(value) {
  const valueSafe = value && typeof value === "object" ? value : {};
  const result = { ...DEFAULT_CONFIG, ...valueSafe };
  if (!["always", "important", "manual"].includes(result.autoDisplay)) result.autoDisplay = "important";
  result.retentionDays = Math.max(1, Math.min(365, Number(result.retentionDays) || 30));
  return result;
}

export function resumeOf(terminal) {
  try {
    const resume = JSON.parse(terminal?.labels?.["herdr.resume"] ?? "null");
    if (resume?.pid && terminal?.foreground?.pid && resume.pid !== terminal.foreground.pid) return null;
    return ["codex", "claude"].includes(resume?.agent) && typeof resume.id === "string" ? resume : null;
  } catch { return null; }
}

export function boundedCoreReport(report) {
  if (!report || typeof report !== "object") return null;
  const result = {};
  if (["permission", "question", "auth", "none"].includes(report.kind)) result.kind = report.kind;
  for (const key of ["message", "msg"]) {
    if (typeof report[key] === "string") result[key] = report[key].replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 800);
  }
  return Object.keys(result).length ? result : null;
}

export function taskFor(state, address) {
  return state?.tasks?.find(task => task.address === address) ?? null;
}

export function boundary(task) {
  return Math.max(Number(task?.lastReviewedEventId) || 0, ...(task?.events ?? []).map(event => Number(event.id) || 0));
}

export function unread(task, through = boundary(task)) {
  return (task?.events ?? []).filter(event => event.id > (task.lastReviewedEventId ?? 0) && event.id <= through);
}

export function repositoryTasks(state, task) {
  if (!task) return state?.tasks ?? [];
  if (!task.repositoryId || task.repositoryId === "Unknown") {
    const machine = item => item.machine ?? (String(item.address ?? "").includes("/") ? String(item.address).split("/")[0] : "local");
    return (state?.tasks ?? []).filter(other => other.taskId === task.taskId ||
      Boolean(task.worktreePath) && other.worktreePath === task.worktreePath && machine(other) === machine(task));
  }
  return (state?.tasks ?? []).filter(other => other.repositoryId === task.repositoryId);
}

export function sharedWorktreeTasks(state, task) {
  if (!task?.repositoryId || task.repositoryId === "Unknown" ||
      !task.worktreePath || task.worktreePath === "Unknown") return [];
  const machine = item => item.machine || (String(item.address ?? "").includes("/") ?
    String(item.address).split("/")[0] : "local");
  return (state?.tasks ?? []).filter(other =>
    other.repositoryId === task.repositoryId && other.worktreePath === task.worktreePath &&
    machine(other) === machine(task));
}

export function attentionFor(state, tasks, config = DEFAULT_CONFIG) {
  if (!config.attentionQueue) return [];
  const ids = new Set(tasks.map(task => task.taskId));
  return (state?.attention ?? []).filter(item => (item.taskIds ?? [item.taskId]).some(id => ids.has(id)) && (item.priority ?? 0) >= config.priorityThreshold)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.at ?? 0) - (b.at ?? 0));
}

export function conflictsFor(state, task) {
  return (state?.conflicts ?? []).filter(item => !task || item.agents?.includes(task.taskId));
}

export function importantConflict(conflict) {
  return conflict?.kind === "actual" ||
    conflict?.activeWriter === true && conflict?.evidence?.currentObservation !== "Unknown" &&
      [1, 2].includes(Number(conflict.level));
}

export function importantAttention(item, task) {
  if (!(item.taskIds ?? [item.taskId]).includes(task?.taskId)) return false;
  if (item.type === "conflict") return Number(item.priority) >= 80;
  return ["approval", "user_info", "decision", "blocked", "error", "blocker_report", "test_failure", "dependency"].includes(item.type);
}

export function attentionTone(item) {
  if (Number(item?.priority) >= 80) return "blocked";
  if (item?.type === "review") return "done";
  return Number(item?.priority) >= 60 ? "accent" : "dim";
}

export function agentAttentionBadge(state, task, config = DEFAULT_CONFIG) {
  const entries = attentionFor(state, [task], config);
  if (entries.some(item => importantAttention(item, task)) ||
      config.conflictDetection && conflictsFor(state, task).some(importantConflict)) {
    return { text: "!", tone: "blocked", label: "중요한 사용자 개입 요청" };
  }
  if (entries.some(item => item.type === "review")) {
    return { text: "✓", tone: "done", label: "완료 응답 리뷰 필요" };
  }
  return null;
}

export function resumePolicy(config, task, state) {
  if (!task || config.autoDisplay === "manual") return "none";
  if (config.autoDisplay === "always") return "window";
  const relevantConflicts = conflictsFor(state, task);
  const important = (state?.attention ?? []).some(item => importantAttention(item, task)) ||
    relevantConflicts.some(importantConflict) || ["blocked", "error"].includes(task.status);
  const brief = contextBrief(task, state, config);
  if (important) return brief.quality.canAutoOpen ? "window" : "card";
  const meaningfulEvents = unread(task).some(event =>
    ["agent_report", "agent-report", "llm-unverified"].includes(event.source) && reportExcerpt(event.summary) ||
    event.source === "test_log" && brief.changes.some(change => change.source === "test_log") ||
    event.source === "git_observation" && task.lastReviewedEventId > 0 && event.evidence?.newFiles?.length);
  return meaningfulEvents || brief.actions.length || brief.repoRisks.length ? "card" : "none";
}

export function stateSignature(state) {
  return JSON.stringify([
    (state?.tasks ?? []).map(task => [task.taskId, task.snapshotVersion, boundary(task), task.lastReviewedEventId, task.status, task.stale,
    task.syncPending, task.git?.stale, task.git?.pending, task.git?.observedAt, task.llmSnapshot, task.viewTruncated]),
    state?.attention, state?.conflicts, state?.errors, state?.viewTruncated,
  ]);
}

export function eventVisible(event, config) {
  if (!config.showTests && String(event.type).includes("test")) return false;
  if (!config.showRepository && ["git_observation", "git", "repository"].includes(event.source)) return false;
  if (!config.showDecisions && (event.type === "decision" || event.type === "report" && event.evidence?.decisions?.length)) return false;
  return true;
}

export function acknowledgmentAllowed(task, config, through) {
  if (!task || task.delta?.gap) return false;
  return unread(task, through).every(event => eventVisible(event, config));
}

export function frozenDetail(task, state, config) {
  const copy = value => JSON.parse(JSON.stringify(value));
  return {
    task: task ? copy(task) : null,
    state: copy({
      attention: (state.attention ?? []).filter(item => (item.taskIds ?? [item.taskId]).includes(task?.taskId)),
      conflicts: conflictsFor(state, task),
      taskNames: Object.fromEntries((state.tasks ?? []).map(item => [item.taskId, item.tabName ?? item.address])),
    }),
    config: copy(configOf(config)),
    throughEventId: boundary(task),
  };
}

export function importantSignal(state, task) {
  return JSON.stringify([
    (state.attention ?? []).filter(item => importantAttention(item, task)).map(item => item.id).sort(),
    conflictsFor(state, task).filter(importantConflict).map(item => item.id).sort(),
  ]);
}

export function shouldOpenResume(previous, address, signal, policy, alreadyOpen) {
  if (policy !== "window" || alreadyOpen || !previous) return false;
  if (address !== previous.address) return true;
  try {
    const before = new Set(JSON.parse(previous.signal).flat());
    return JSON.parse(signal).flat().some(id => !before.has(id));
  } catch { return signal !== previous.signal; }
}

export function displaySnapshot(task) {
  const llm = task?.llmSnapshot;
  if (llm?.fields && Number(llm.throughEventId) >= boundary(task)) {
    return { ...task, ...llm.fields, source: "AI 요약 · 검증 전" };
  }
  return task;
}

export function goalLabel(task) {
  if (task?.source === "AI 요약 · 검증 전" || task?.source === "llm-unverified") return "AI 요약 · 검증 전";
  const labels = {
    initial_user_request: "초기 요청",
    user_request: "수집된 요청",
    explicit_user_goal: "목표",
    agent_report: "보고된 목표",
  };
  return labels[task?.goalSource] ?? (task?.source === "agent_report" ? "보고된 목표" : "목표");
}

export function eventSourceAvailable(task, event) {
  const evidence = event?.evidence?.evidence ?? event?.evidence;
  return Boolean(task?.sourceLog && evidence?.path === task.sourceLog &&
    Number.isInteger(evidence?.byteOffset) && evidence.byteOffset >= 0);
}

export function headerDensity(width) {
  return width < 620 ? "minimal" : width < 900 ? "compact" : "full";
}

export function freshnessLabel(task) {
  return [
    task?.syncPending ? "분석 대기" : "",
    task?.git?.stale ? "Git 관측 오래됨" : "",
    task?.git?.recentError ? "관측된 커밋 분석 실패" : "",
    task?.git?.recentScopeTruncated ? "현재 커밋 분석 일부 누락" : "",
    task?.stale ? "오래된 Snapshot" : "",
    task?.viewTruncated ? "화면 근거 축약" : "",
  ].filter(Boolean).join(" · ");
}

export function collectionNotice(state, engineError, actionError) {
  if (engineError) return { level: "error", text: `분석 실패 · ${plain(engineError)}` };
  if (actionError) return { level: "error", text: plain(actionError) };
  const errors = (state?.errors ?? []).map(error => typeof error === "string" ? error : plain(error?.message ?? error));
  const failure = errors.find(error => /\b(?:failed|failure|unavailable|cannot|timeout|timed out)\b|실패|오류|읽지 못/i.test(error));
  if (failure) return { level: "error", text: `분석 실패 · ${failure}` };
  if (state?.viewTruncated) return { level: "info", text: "표시 안내 · 화면 근거 일부를 줄여 표시합니다. 원본 기록은 유지됩니다." };
  if (errors.length) return { level: "info", text: `수집 안내 · ${errors[0]}` };
  return { level: null, text: null };
}

export function recentReport(task, limit = 120) {
  return reportExcerpt(task?.latestResponse, limit, 1);
}

export function unreviewedCount(task) {
  const count = Number(task?.delta?.totalUnreviewed);
  return Number.isFinite(count) && count >= 0 ? count : unread(task).length;
}

export function plain(value, fallback = "Unknown") {
  if (value == null || value === "") return fallback;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function dateLabel(value) {
  const millis = typeof value === "string" ? Date.parse(value) : value;
  if (!millis || !Number.isFinite(millis)) return "Unknown";
  return new Date(millis < 100000000000 ? millis * 1000 : millis).toLocaleString();
}

const literal = (value, fallback = "Unknown") => plain(value, fallback).replace(/[\\`*_[\]<>!]/g, "\\$&");

export function detailMarkdown(task, state, view, config, through) {
  if (view === "conflicts") {
    const items = conflictsFor(state, task);
    return items.length ? items.map(item => [
      `### Level ${item.level ?? "?"} · ${item.kind === "actual" ? "실제 Git 충돌" : "잠재 영향"}`,
      literal(item.summary),
      `관련 에이전트: ${(item.agents ?? []).map(id => literal(state.taskNames?.[id] ?? id)).join(" ↔ ")}`,
      `파일: ${(item.files ?? []).slice(0, 20).map(file => literal(file)).join(", ") || "Unknown"}`,
      `심볼: ${(item.symbols ?? []).slice(0, 20).map(symbol => literal(symbol)).join(", ") || "Unknown"}`,
      `현재 브랜치 반영: ${item.perAgentIntegrated ?
        Object.entries(item.perAgentIntegrated).map(([id, result]) =>
          `${literal(state.taskNames?.[id] ?? id)}에서 상대 HEAD 반영 ${literal(result)}`).join(" · ") :
        `${literal(item.integrated)} · 첫 번째 에이전트 방향만 확인`}`,
      `미커밋 변경 반영: ${literal(item.evidence?.uncommittedChangesIntegrated)}`,
      `근거 출처: ${literal(item.evidence?.source, "Git diff 추정")}`,
      "권장 행동: 관련 에이전트의 변경 계약과 Git diff를 함께 검토하세요.",
    ].join("\n\n")).join("\n\n---\n\n") : "감지된 충돌 위험이 없습니다. 분석 범위 밖의 의미적 의존성은 Unknown입니다.";
  }
  if (!task) return "현재 에이전트의 저장 상태를 기다리고 있습니다.";
  const events = unread(task, through);
  const brief = contextBrief(task, state, { ...config, deltaOnly: ["delta", "events"].includes(view) }, through);
  const lines = [
    `## ${literal(brief.title)}`,
    freshnessLabel(task) ? `수집 상태: ${freshnessLabel(task)}` : "",
  ];
  if (view !== "delta" && brief.goal) lines.push(`### ${brief.goalSourceLabel || goalLabel(task)}\n${literal(brief.goal)}`);
  if (view !== "delta" && brief.summary) lines.push(`### ${brief.summarySource}\n${literal(brief.summary)}`);
  if (view !== "delta" && brief.currentReportBeyondBoundary) lines.push("위 요약은 현재 Snapshot의 최신 보고입니다. 아래 확인 경계는 아직 읽지 않은 기록 페이지에만 적용됩니다.");
  if (view !== "delta" && brief.currentEvidenceBeyondBoundary) lines.push("현재 요청·검증 근거 중에는 이 확인 페이지보다 새로운 내용이 있습니다. 페이지를 확인해도 새 요청은 확인 처리되지 않습니다.");
  if (brief.actions.length && view !== "delta") lines.push("### 지금 확인할 일\n" +
    brief.actions.map(action => `- ${literal(action.title)}: ${literal(action.detail)}${action.source === "agent_report" ? " · 에이전트 보고" : ""}`).join("\n"));
  if (brief.changes.length) lines.push(`### ${view === "delta" ? "확인 가능한 변경·검증" : "변경·검증 근거"}\n` +
    brief.changes.map(change => `- ${literal(change.title)}: ${literal(change.detail)} · ${literal(change.source)}`).join("\n"));
  if (brief.decisions.length && view !== "delta") lines.push("### 설계 결정 · 에이전트 보고\n" +
    brief.decisions.map(value => `- ${literal(value)}`).join("\n"));
  if (brief.repoRisks.length && view !== "delta") lines.push("### 관련 작업의 영향\n" +
    brief.repoRisks.map(risk => `- ${literal(risk.title)}: ${literal(risk.detail)}`).join("\n"));
  if (brief.emptyReason) lines.push(brief.emptyReason);
  if (task.delta?.gap) lines.push("⚠️ 이전 이벤트의 일부를 복구하지 못했습니다. 미표시 이벤트를 확인 처리할 수 없습니다.");
  if (task.delta?.hasMore) lines.push(`미확인 기록 ${task.delta.totalUnreviewed}개 중 현재 페이지 ${events.length}개가 확인 범위입니다.`);
  if (events.some(event => !eventVisible(event, config))) lines.push("표시 옵션에 따라 일부 이벤트가 숨겨져 있습니다. 숨겨진 이벤트를 확인 처리하지 않으려면 Settings에서 표시 옵션을 모두 켜세요.");
  if (view === "delta" && task.lastReviewedEventId === 0) lines.push("첫 확인입니다. 기존 브랜치 변경을 ‘마지막 확인 이후’의 변경으로 계산하지 않습니다.");
  if (view === "events") lines.push("### 수동 조회 · 원본 이벤트\n" + events.filter(event => eventVisible(event, config))
    .map(event => `- #${event.id} [${literal(event.source)}] ${literal(event.summary)}`).join("\n"));
  else lines.push(`원본 기록 ${events.length}개는 ‘자료·기록’에서 직접 확인할 수 있습니다.`);
  lines.push(`확인 경계: 이벤트 #${through}. 이 창을 열어도 확인 처리되지 않습니다.`);
  return lines.filter(Boolean).join("\n\n");
}
import { contextBrief, reportExcerpt } from "./digest.js";
