// Runs from the existing chrome in both interfaces, independent of tab focus.
import { agents, terminals, shared, setShared, exec, appHome, props } from "herdr";

export function responseConnection(connection, control) {
  const provider = ["codex", "claude"].includes(connection?.provider) ? connection.provider : "none";
  return {
    enabled: control?.enabled !== false && control?.autoResponseSummary === true,
    provider,
    model: String(control?.responseSummaryModels?.[provider] || connection?.models?.[provider] || "").trim().slice(0, 100),
    authRevision: connection?.authRevision ?? 0,
  };
}

function resumeOf(terminal) {
  try {
    const resume = JSON.parse(terminal?.labels?.["herdr.resume"] ?? "null");
    if (resume?.pid && terminal?.foreground?.pid && resume.pid !== terminal.foreground.pid) return null;
    return ["codex", "claude"].includes(resume?.agent) && typeof resume.id === "string" ? resume : null;
  } catch { return null; }
}

export class CompletionWorker {
  constructor() {
    this.observing = false;
    this.working = false;
    this.lastObservation = "";
  }

  start(cx) {
    if (props()?.footer) return;
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [
          `${appHome()}/mods/agent-control-center/engine/notification_patch.py`, appHome(),
        ], { timeout: 10000 });
        const status = JSON.parse(result.stdout);
        if (!status.ok) throw new Error(status.error ?? "완료 알림 필터를 적용하지 못했습니다.");
        setShared("acc.notification-error", null);
      } catch (error) {
        setShared("acc.notification-error", String(error));
      }
      cx.notify();
    });
    this.tick(cx);
    cx.timer.every(2000, cx => this.tick(cx));
  }

  configuration() {
    return responseConnection(shared("ai.connection"), shared("acc.config"));
  }

  request() {
    const live = terminals();
    return {
      appHome: appHome(),
      stateDir: `${appHome()}/data/agent-control-center`,
      config: this.configuration(),
      agents: agents().map(agent => {
        const terminal = live.find(item => item.address === agent.address);
        if (!terminal || terminal.labels?.["herdr.ai-helper"] || terminal.labels?.["acc.helper"]) return null;
        return { address: agent.address, status: agent.status, turn: Number(terminal.turn) || 0,
          tab_name: agent.tab_name ?? agent.address, cwd: terminal.foreground?.cwd ?? terminal.cwd,
          created_ms: terminal.created_ms ?? terminal.created ?? "", pid: terminal.pid ?? "",
          foreground: { pid: terminal.foreground?.pid ?? "" }, resume: resumeOf(terminal) };
      }).filter(Boolean),
    };
  }

  async call(command, request, timeout) {
    const result = await exec("python3", [
      `${appHome()}/mods/agent-control-center/engine/response_engine.py`, command, JSON.stringify(request),
    ], { timeout });
    const value = JSON.parse(result.stdout);
    if (result.code !== 0 || !value.ok) throw new Error(value.error ?? result.stderr ?? "응답 요약 처리 실패");
    return value;
  }

  tick(cx) {
    const request = this.request();
    const signature = JSON.stringify([request.config, request.agents.map(agent => [
      agent.address, agent.created_ms, agent.pid, agent.foreground.pid, agent.resume?.id, agent.turn, agent.status,
    ])]);
    if (this.observing || (!this.working && signature === this.lastObservation &&
        Date.now() - (this.lastObservedAt ?? 0) < 10000)) return;
    this.observing = true;
    cx.spawn(async cx => {
      try {
        const value = await this.call("observe", request, 15000);
        this.lastObservation = signature;
        this.lastObservedAt = Date.now();
        if (JSON.stringify(value) !== JSON.stringify(shared("acc.response-summary")))
          setShared("acc.response-summary", value);
        setShared("acc.response-summary-error", null);
        if (value.pending > 0 && request.config.enabled && request.config.provider !== "none") this.work(cx, request);
      } catch (error) {
        setShared("acc.response-summary-error", String(error).slice(0, 200));
      }
      this.observing = false;
      cx.notify();
    });
  }

  work(cx, request) {
    if (this.working || Date.now() < (this.nextWorkAt ?? 0)) return;
    this.working = true;
    cx.spawn(async cx => {
      try {
        // One isolated request at a time. No source-agent input, resumes or restarts.
        const value = await this.call("work", request, 175000);
        // Another chrome incarnation can still own a provider invocation after
        // a layout switch. Avoid a hot observe/claim loop while its lease lives.
        if (!value.claimed) this.nextWorkAt = Date.now() + 3000;
        this.lastObservation = "";
      } catch (error) {
        setShared("acc.response-summary-error", String(error).slice(0, 200));
      }
      this.working = false;
      this.lastObservedAt = 0;
      this.tick(cx);
      cx.notify();
    });
  }
}
