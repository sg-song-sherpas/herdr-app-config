// Local presentation only. Source text remains data and is never executed or sent to a model.
const known = value => typeof value === "string" && value.trim() && !/^(?:unknown|null|none|undefined|\[\]|\{\})$/i.test(value.trim());
const clip = (text, length = 160) => text.length > length ? `${text.slice(0, length - 1).trim()}…` : text;
const list = value => Array.isArray(value) ? value : [];
const reportSources = new Set(["agent_report", "agent-report", "llm-unverified"]);
const routine = /^(?:세션 수집|에이전트 상태:|긴 대화의 최근 기록|이전 기록은 원본|응답이 완료됐습니다|구현·검증 결과를 리뷰|근거:|Git 변경:|Chunk ID:|Wall time:|Process exited|Final output:|TAP version|\d+\.\.\d+|# (?:tests|suites|pass|fail|duration)|확인 경계:)/i;
const generic = /^(?:네[.!]?|예[.!]?|(?:적용|반영|완료|수정|확인|검증|전달|보고|마무리)했습니다[.!]?|(?:구현|담당 범위|검토|맥락 복원|복구|작업)(?:·[^.]*)?를? (?:완료|마쳤|마무리했)습니다[.!]?)$/;
const continueOnly = /^(?:이어서\s*(?:해|해주세요|하자|진행해(?:주세요)?)|계속\s*(?:해|진행해(?:주세요)?)|좋아|진행해(?:주세요)?|현재\s*상태\s*알려줘)[.!]?$/;
const protocol = /^(?:<hc\b|<INSTRUCTIONS>|<environment_context>|#?\s*AGENTS\.md instructions|#\s*Codex (?:Orchestrator )?세션|<permissions instructions>|<\/?(?:system|developer|user|assistant)>)/i;
const harnessTokens = /\b(?:SOURCE\d+|SOURCEONLY|PREEXECUTION|FIRSTFAIL|HOLD|exact\d+|samefreeze|ownercommitted|ownercommit)\b/gi;
function harness(line) {
  const tokens = line.match(harnessTokens) ?? [];
  return tokens.length >= 2 || /\b(?:SOURCE\d+|SOURCEONLY|samefreeze|FIRSTFAIL|ownercommitted|ownercommit)\b/i.test(line) ||
    /(?:원분모|원\s*MISSING|원\s*HOLD|원\s*영수증|역투영|CODE·RESOURCE|source-only preflight)/i.test(line);
}

function proseLines(value) {
  if (!known(value)) return [];
  let code = false;
  return value.split(/\r?\n/).flatMap(raw => {
    if (/^\s*```/.test(raw)) { code = !code; return []; }
    if (code || /^\s{4,}\S/.test(raw) || protocol.test(raw.trim())) return [];
    let line = raw.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
      .replace(/[*_`]/g, "").trim();
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|?$/.test(line)) return [];
      line = line.split("|").map(part => part.trim()).filter(Boolean).join(" · ");
      if (/^(?:작업|항목|구분) · (?:상태|결과)/.test(line)) return [];
    }
    if (!line || routine.test(line) || harness(line) ||
        /^(?:\$ |(?:python\d*|node|npm|pnpm|cargo|git|rg|curl|sudo|bash|sh)\s|[{}[\]]\s*$|SHA(?:256)?:|[a-f0-9]{40,64}$)/i.test(line) ||
        /^(?:전|후|결과):\s*(?:무엇|이 줄|이제)/.test(line)) return [];
    return line.split(/(?<=[.!?。])\s+/).map(text => text.trim())
      .filter(text => known(text) && !generic.test(text) && !routine.test(text) &&
        !continueOnly.test(text) && !harness(text));
  });
}

export function reportExcerpt(value, limit = 280, count = 2) {
  const lines = [...new Set(proseLines(value))];
  // A generic completion sentence should not crowd out the concrete changes below it.
  const specific = lines.filter(line => !/^(?:맥락 복원|구현·검토·커밋·푸시|담당 범위|작업을 완료|구현은 이미 완료)/.test(line));
  const candidates = (specific.length ? specific : lines).map((text, index) => ({ text, index,
    score: /(?:수정|추가|구현|테스트|시험|통과|실패|차단|판단할|필요|허용 여부|확인하지 못|미확인|편집|저장|접거나)/.test(text) ? 1 : 0 }));
  return clip(candidates.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, count)
    .sort((a, b) => a.index - b.index).map(line => line.text).join(" "), limit);
}

function useful(value, length = 160) {
  return clip(proseLines(value).find(line => !continueOnly.test(line)) ?? "", length);
}

function requestGoal(task) {
  const value = task?.goal;
  if (!known(value) || continueOnly.test(value.trim()) || protocol.test(value.trim())) return "";
  return useful(value, 140);
}

function eventLimit(task) {
  return Math.max(Number(task?.lastReviewedEventId) || 0,
    ...list(task?.events).map(event => Number(event.id) || 0));
}

function freshAiSnapshot(task) {
  const snapshot = task?.llmSnapshot;
  if (snapshot?.source !== "llm-unverified" || !snapshot.fields ||
      typeof snapshot.fields !== "object" || Array.isArray(snapshot.fields) ||
      !Number.isFinite(snapshot.at) || !Number.isFinite(task.updatedAt) ||
      snapshot.at < task.updatedAt || snapshot.at > Date.now() ||
      !Number.isInteger(snapshot.throughEventId) || snapshot.throughEventId < 0 || task.stale || task.syncPending) return null;
  const sourceIds = [task.statusEventId, task.gitEventId, task.goalEvidence?.eventId,
    task.pendingCompletionEventId, ...list(task.latestRecordedTests ?? task.recordedTests).map(test => test.eventId)];
  for (const event of list(task.events)) {
    // A model summary is stored as its own subsequent event. Only the matching
    // summary event is excluded; a later report/Git/status event invalidates it.
    if (event.type === "summary" && event.source === "llm-unverified" &&
        event.evidence?.throughEventId === snapshot.throughEventId) continue;
    sourceIds.push(event.id);
  }
  if (sourceIds.some(id => Number.isFinite(id) && id > snapshot.throughEventId)) return null;
  const knownBoundary = Math.max(eventLimit(task), ...sourceIds.filter(Number.isFinite), 0);
  if (!task.delta?.hasMore && snapshot.throughEventId > knownBoundary) return null;
  return snapshot;
}

function reportFor(task, through) {
  const partial = through < eventLimit(task);
  if (!partial && known(task?.latestResponse)) {
    const current = reportExcerpt(task?.latestResponse);
    return { text: current, source: "agent_report" };
  }
  for (const event of list(task?.events).filter(event => event.id <= through).reverse()) {
    if (!reportSources.has(event.source)) continue;
    const text = reportExcerpt(event.summary);
    if (text) return { text, source: event.source };
  }
  return { text: "", source: "agent_report" };
}

function commandLabel(test) {
  const name = test?.command ?? test?.name;
  if (!known(name)) return "테스트 실행";
  // Keep the runner and test target, without flooding the card with an absolute workspace path.
  return clip(name.replace(/(^|\s)\/(?:[^\s/]+\/)*([^\s/]+)/g, "$1$2"), 100);
}

function testFact(test) {
  if (test?.source !== "test_log" || test?.verified !== true || !Number.isInteger(test.exitCode)) return null;
  const count = Number.isInteger(test.testsPassed) ? ` · ${test.testsPassed}개 통과` : "";
  return { title: `${test.exitCode === 0 ? "테스트 종료 정상" : "테스트 실패"}${count}`,
    detail: `${commandLabel(test)} · 종료 코드 ${test.exitCode}`, source: "test_log",
    kind: test.exitCode === 0 ? "test_pass" : "test_failure", eventId: test.eventId };
}

function testsFor(task, through) {
  return list(task?.latestRecordedTests ?? task?.recordedTests)
    .filter(test => !Number.isFinite(test.eventId) || test.eventId <= through)
    .map(testFact).filter(Boolean).sort((a, b) =>
      Number(b.kind === "test_failure") - Number(a.kind === "test_failure") || (b.eventId ?? 0) - (a.eventId ?? 0));
}

function fileList(files) { return clip(list(files).slice(0, 3).join(", "), 180); }
function concreteRequest(value) {
  const text = useful(value, 800);
  const genericRequest = /^(?:(?:사용자\s*)?(?:입력|정보|개입|판단|승인|권한|(?:설계\s*)?결정|질문)(?:이|가|을|를)?\s*(?:필요(?:합니다|함)?|기다립니다|대기(?:중|합니다)?)|작업(?:이)?\s*(?:차단(?:됐습니다)?|막혔습니다)|에이전트.*(?:대기|blocked))[.!]?$/;
  const parts = text.split(/\s*[·|;,:]\s*|\s+[+/-]\s+/).filter(Boolean);
  return text && !parts.every(part => genericRequest.test(part)) ? clip(text, 220) : "";
}

export function attentionBrief(item, task, state = {}, through = Infinity) {
  const source = item?.evidence?.source ?? (item?.type === "test_failure" ? "test_log" : "core_status");
  if (!item || !task) return { ...item, title: "", detail: "", source, meaningful: false };
  if (item.type === "review") {
    const report = reportFor(task, through);
    const facts = testsFor(task, through);
    const dirty = list(task.git?.dirtyFiles);
    return { ...item, title: "완료 보고 확인", detail: report.text || facts[0]?.detail ||
      (dirty.length ? `현재 미커밋 변경 ${dirty.length}개 · ${fileList(dirty)}` : ""),
      source: report.text ? report.source : facts.length ? "test_log" : "git_observation",
      meaningful: Boolean(report.text || facts.length || dirty.length) };
  }
  if (item.type === "conflict") {
    const radarIds = new Set(item.groupedRadarIds ?? []);
    const risks = list(state.conflicts).filter(risk => risk.agents?.includes(task.taskId) &&
      (!radarIds.size || radarIds.has(risk.id)));
    const files = [...new Set(risks.flatMap(risk => list(risk.files)))];
    const symbols = [...new Set(risks.flatMap(risk => list(risk.symbols)))];
    return { ...item, title: risks.some(risk => risk.kind === "actual") ? "Git 충돌 확인" : "변경 계약 비교",
      detail: fileList(files) + (symbols.length ? ` · ${symbols.slice(0, 3).join(", ")}` : ""),
      source: "git_observation", meaningful: files.length > 0 };
  }
  if (item.type === "test_failure") {
    const failure = testsFor(task, through).find(test => test.kind === "test_failure");
    return { ...item, title: failure?.title ?? "", detail: failure?.detail ?? "",
      source: "test_log", meaningful: Boolean(failure) };
  }
  const message = concreteRequest(task.statusMessage) || concreteRequest(item.evidence?.message) ||
    concreteRequest(item.evidence?.request) || concreteRequest(item.summary);
  const title = { approval: "승인할 요청", user_info: task.statusKind === "auth" ? "터미널 인증 확인" : "답할 질문",
    decision: "결정할 사항", blocked: "막힌 작업 확인", blocker_report: "차단 요인 확인",
    error: "실패 원인 확인", dependency: "의존 변경 확인" }[item.type] ?? "확인할 사항";
  return { ...item, title, detail: message, source, meaningful: Boolean(message) };
}

export function contextBrief(task, state = {}, config = {}, through = eventLimit(task)) {
  if (!task) return { title: "", summary: "", summarySource: "", goal: "", current: "",
    actions: [], changes: [], decisions: [], repoRisks: [], emptyReason: "현재 에이전트의 작업 보고를 기다리고 있습니다.",
    quality: { canAutoOpen: false }, rawEventCount: 0 };
  const events = list(task.events).filter(event => event.id > (task.lastReviewedEventId ?? 0) && event.id <= through);
  // Snapshot/Attention describe current known state. An unread page boundary
  // controls acknowledgment and Delta, not visibility of a newer live request.
  const evidenceThrough = config.deltaOnly ? through : Infinity;
  const ai = config.deltaOnly ? null : freshAiSnapshot(task);
  const aiText = ai ? reportExcerpt(ai.fields.currentStep) ||
    reportExcerpt(list(ai.fields.completedSteps).join("\n")) : "";
  const report = aiText ? { text: aiText, source: "llm-unverified" } : reportFor(task, evidenceThrough);
  const partial = config.deltaOnly && through < eventLimit(task);
  const current = aiText || (!partial ? useful(task.currentStep) : "");
  const originalGoal = requestGoal(task);
  const goal = originalGoal || (ai ? useful(ai.fields.goal, 140) : "");
  const changes = [];
  const tests = config.showTests === false ? [] : testsFor(task, evidenceThrough)
    .filter(test => !config.deltaOnly || Number.isFinite(test.eventId) && test.eventId > (task.lastReviewedEventId ?? 0));
  const actions = [];
  for (const item of list(state.attention)) {
    if (!(item.taskIds ?? [item.taskId]).includes(task.taskId) ||
        Number(item.evidence?.eventId) > evidenceThrough ||
        config.showTests === false && item.type === "test_failure" ||
        config.showRepository === false && item.type === "conflict" ||
        config.showDecisions === false && item.type === "decision") continue;
    const brief = attentionBrief(item, task, state, evidenceThrough);
    if (brief.meaningful) actions.push({ title: brief.title, detail: brief.detail, source: brief.source,
      kind: item.type, priority: item.priority ?? 0,
      beyondBoundary: Number(item.evidence?.eventId) > through });
  }
  for (const blocker of list(task.blockers)) {
    const detail = concreteRequest(blocker);
    if (detail && !actions.some(action => action.detail === detail))
      actions.push({ title: "차단 요인 확인", detail, source: "agent_report", kind: "blocked", priority: 90 });
  }
  if (config.showNextAction !== false) {
    const nativeNext = concreteRequest(task.nextAction);
    const detail = nativeNext || (ai ? concreteRequest(ai.fields.nextAction) : "");
    if (detail && !actions.some(action => action.detail === detail))
      actions.push({ title: nativeNext ? "다음 행동 · 보고" : "다음 행동 · AI 제안", detail,
        source: nativeNext ? task.source === "llm-unverified" ? task.source : "agent_report" : "llm-unverified",
        kind: "next", priority: 0 });
  }
  for (const fact of tests.slice(0, 2)) changes.push({ ...fact,
    sinceReview: task.lastReviewedEventId > 0 && Number.isFinite(fact.eventId) && fact.eventId > task.lastReviewedEventId,
    beyondBoundary: Number(fact.eventId) > through });
  if (config.showRepository !== false && task.git?.ok && !(config.deltaOnly && task.gitEventId > through)) {
    const dirty = list(task.git.dirtyFiles);
    if (dirty.length) changes.push({ title: `현재 미커밋 변경 ${dirty.length}개`,
      detail: fileList(dirty), source: "git_observation", kind: "current_dirty", sinceReview: false });
    if (task.lastReviewedEventId > 0) {
      const files = [...new Set(events.filter(event => event.source === "git_observation")
        .flatMap(event => list(event.evidence?.newFiles)))];
      if (files.length) changes.push({ title: `확인 이후 새 변경 파일 ${files.length}개`,
        detail: fileList(files), source: "git_observation", kind: "new_files", sinceReview: true });
    }
    if (task.git.recentError) changes.push({ title: "관측된 커밋 분석 실패",
      detail: "이전 근거는 유지되며 새 변경 범위의 분석 완료 여부는 미확인입니다. 원본 Git diff를 확인하세요.", source: "git_observation", kind: "analysis_status", sinceReview: false });
    if (task.git.recentScopeTruncated) changes.push({ title: "현재 커밋 분석 일부 누락",
      detail: "누락된 파일·심볼은 원본 Git diff에서 확인하세요.", source: "git_observation", kind: "analysis_status", sinceReview: false });
    if (task.git.recentHistoryTruncated) changes.push({ title: "상세 전환 기록 축약",
      detail: "현재 커밋 변경 범위는 별도로 분석합니다.", source: "git_observation", kind: "analysis_status", sinceReview: false });
  }
  const decisions = config.showDecisions === false ? [] : list(task.decisions).map(value => useful(value)).filter(Boolean).slice(0, 3);
  const repoRisks = config.showRepository === false ? [] : list(state.conflicts)
    .filter(risk => risk.agents?.includes(task.taskId) && (list(risk.files).length || list(risk.symbols).length))
    .slice(0, 2).map(risk => ({ title: risk.kind === "actual" ? "실제 Git 충돌" : "잠재 영향 · 확인 필요",
      detail: `${fileList(risk.files)}${list(risk.symbols).length ? ` · ${risk.symbols.slice(0, 3).join(", ")}` : ""}`,
      source: "git_observation", important: risk.kind === "actual" ||
        risk.activeWriter === true && risk.evidence?.currentObservation !== "Unknown" && [1, 2].includes(Number(risk.level)) }));
  const sortedActions = actions.sort((a, b) => b.priority - a.priority).slice(0, 3);
  const summary = report.text || current || changes[0]?.title || "";
  return { title: task.tabName ?? task.address ?? "", summary,
    summarySource: report.text ? report.source === "llm-unverified" ? "AI 요약 · 검증 전" : "최근 보고 발췌 · 검증 전" :
      current ? "보고된 현재 단계 · 검증 전" : changes[0]?.source === "test_log" ? "기록된 실행 결과" : summary ? "Git 관측" : "",
    goal, goalSource: originalGoal ? task.goalSource : goal ? "llm-unverified" : "",
    goalSourceLabel: !originalGoal && goal ? "AI 요약 · 검증 전" : "",
    current: clip(current || report.text, 140), actions: sortedActions, changes: changes.slice(0, 4), decisions, repoRisks,
    emptyReason: summary || sortedActions.length || repoRisks.length ? "" :
      task.status === "blocked" ? "대기 상태는 확인했지만, 구체적인 요청을 수집하지 못했습니다. 터미널에서 요청을 확인하세요." :
      "구체적인 작업 보고를 아직 수집하지 못했습니다. 터미널 또는 원본 기록에서 확인하세요.",
    currentReportBeyondBoundary: Boolean(!config.deltaOnly && report.text &&
      (task.delta?.hasMore || through < eventLimit(task) || ai && ai.throughEventId > through)),
    currentEvidenceBeyondBoundary: Boolean(!config.deltaOnly && (sortedActions.some(action => action.beyondBoundary) ||
      changes.some(change => change.beyondBoundary) ||
      sortedActions.length && task.statusEventId > through ||
      changes.some(change => change.source === "git_observation") && task.gitEventId > through)),
    quality: { canAutoOpen: sortedActions.some(action =>
      ["approval", "user_info", "decision", "blocked", "error", "blocker_report", "test_failure", "dependency"].includes(action.kind)) ||
      repoRisks.some(risk => risk.important) }, rawEventCount: events.length };
}
