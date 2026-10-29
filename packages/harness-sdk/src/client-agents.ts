/**
 * Client projection of a worker session. Interned by `sessionId`.
 * Reads the session overview + this tape + the three bots rosters. Does not intern the
 * worker document.
 */
import { recordString } from "@inhuman.tools/harness-model/json-record";
import type { SessionOverview } from "@inhuman.tools/harness-model/kernel";
import { AgentCallJob, BotCallJob, CallJob } from "@inhuman.tools/harness-model/session";
import { computed } from "mobx";

import type { Client } from "./client.js";

export type AgentScope = "one-shot" | "session" | "project" | "global";
export type AgentRosterScope = Exclude<AgentScope, "one-shot">;
/** Process. Failed is not this field — a sealed Call fail is `ourRequest`. */
export type AgentProcessState = "working" | "done";
/** Interaction. Needs-you is `blocked`, not `working`. */
export type AgentTempo = "active" | "idle" | "blocked";
/** This tape's Call to this worker. Cancel is not fail. */
export type AgentRequestState = "none" | "open" | "ok" | "fail" | "cancelled";

export type AgentRosterRow = {
  readonly scope: AgentRosterScope;
  readonly name: string;
  readonly sessionId: string;
};

export class ClientAgent {
  constructor(
    readonly client: Client,
    readonly sessionId: string,
  ) {}

  @computed
  get overview(): SessionOverview | null {
    return this.client.kernelRoot.sessions[this.sessionId] ?? null;
  }

  @computed
  get names(): readonly string[] {
    const names: string[] = [];
    for (const row of this.client.botsRoster) {
      if (row.sessionId === this.sessionId) names.push(row.name);
    }
    return names;
  }

  @computed
  get scope(): AgentScope {
    let session = false;
    let project = false;
    let global = false;
    for (const row of this.client.botsRoster) {
      if (row.sessionId !== this.sessionId) continue;
      if (row.scope === "global") global = true;
      else if (row.scope === "project") project = true;
      else session = true;
    }
    if (global) return "global";
    if (project) return "project";
    if (session) return "session";
    return "one-shot";
  }

  @computed
  get oneShot(): boolean {
    const glance = this.overview;
    if (glance != null) return glance.oneShot;
    const call = this.openCall ?? this.lastCall;
    if (call != null) return call instanceof AgentCallJob;
    return this.scope === "one-shot";
  }

  @computed
  get specName(): string {
    const fromGlance = this.overview?.specName.trim() ?? "";
    if (fromGlance !== "") return fromGlance;
    const named = this.names[0]?.trim() ?? "";
    if (named !== "") return named;
    const call = this.openCall ?? this.lastCall;
    if (call == null) return "";
    const spec = recordString(call.args, "spec");
    return spec === "" && call instanceof BotCallJob ? call.botName.trim() || call.contributionBotName.trim() : spec;
  }

  @computed
  get title(): string {
    const title = this.overview?.title.trim() ?? "";
    return title === "" ? this.specName : title;
  }

  @computed
  get nature(): string {
    const nature = this.overview?.recipeScope ?? "";
    if (nature !== "") return nature;
    const scope = this.scope;
    return scope === "one-shot" ? "" : scope;
  }

  @computed
  get keepAlive(): boolean {
    return this.overview?.keepAlive === true;
  }

  @computed
  get model(): string {
    return this.overview?.model.trim() ?? "";
  }

  @computed
  get status(): string {
    return this.overview?.status.trim() ?? "";
  }

  @computed
  get lastMessageAt(): number {
    return this.overview?.lastMessageAt ?? 0;
  }

  @computed
  get calls(): readonly CallJob[] {
    const id = this.sessionId;
    return this.client.agentCalls.filter((call) => call.workerSessionId === id);
  }

  @computed
  get openCall(): CallJob | null {
    let found: CallJob | null = null;
    for (const call of this.calls) {
      if (!call.completed) found = call;
    }
    return found;
  }

  @computed
  get lastCall(): CallJob | null {
    return this.calls.at(-1) ?? null;
  }

  @computed
  get interacted(): boolean {
    return this.calls.length > 0;
  }

  @computed
  get ourRequest(): AgentRequestState {
    const open = this.openCall;
    if (open != null) return "open";
    const last = this.lastCall;
    if (last == null) return "none";
    if (last.cancelled) return "cancelled";
    const snap = last.outcomeSnap;
    if (snap?.ok === false) return "fail";
    return "ok";
  }

  @computed
  get midMotion(): boolean {
    return this.overview?.midMotion === true;
  }

  @computed
  get openTurn(): boolean {
    return this.overview?.openTurn === true;
  }

  @computed
  get openToolCount(): number {
    return this.overview?.openToolCount ?? 0;
  }

  @computed
  get openCallbackCount(): number {
    return this.overview?.openCallbackCount ?? 0;
  }

  @computed
  get asking(): boolean {
    return this.overview?.asking === true;
  }

  @computed
  get state(): AgentProcessState {
    if (
      this.asking ||
      this.midMotion ||
      this.openTurn ||
      this.openToolCount > 0 ||
      this.openCallbackCount > 0 ||
      this.openCall != null
    )
      return "working";
    return "done";
  }

  @computed
  get tempo(): AgentTempo {
    if (this.asking) return "blocked";
    if (
      this.midMotion ||
      this.openTurn ||
      this.openToolCount > 0 ||
      this.openCallbackCount > 0 ||
      this.openCall != null
    )
      return "active";
    return "idle";
  }
}

/**
 * One-shot and session-scope workers raise the host cover.
 * Project/global confirm elsewhere. Host's own queue head wins.
 */
export function hostAskEscalateSessionId(client: Client): string | null {
  if (client.sessionRoot.findRunningTurn()?.approvalHead != null) return null;
  for (const agent of client.agents) {
    if (!escalatesAskToHost(agent)) continue;
    if (!agent.asking && agent.overview?.unfinished !== "ask") continue;
    return agent.sessionId;
  }
  return null;
}

function escalatesAskToHost(agent: ClientAgent): boolean {
  if (agent.sessionId === "" || agent.sessionId === agent.client.sessionId) return false;
  if (agent.scope === "project" || agent.scope === "global") return false;
  if (agent.nature === "project" || agent.nature === "global") return false;
  return agent.oneShot || agent.scope === "session" || agent.nature === "session";
}
