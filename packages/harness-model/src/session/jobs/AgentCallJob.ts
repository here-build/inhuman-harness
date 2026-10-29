/** An invocation of an owned child agent. Bot requests use BotCallJob. */
import { syncing } from "@here.build/plexus";
import { asSystemPrompt, prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import {
  type JobEffectOwner,
  type JobResolution,
  type UnknownOutcomeRecovery,
} from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";

import { CallJob, type CallJobProps } from "./CallJob.js";
import type { ReasoningEffort } from "../../reasoning-effort.js";
import { PromptMessage } from "../expectations/PromptMessage.js";

export type AgentCallJobProps = CallJobProps & {
  readonly constitution?: SystemPrompt;
  readonly promptMessages?: PromptMessage[];
  readonly faceName?: string;
  readonly tools?: readonly string[];
  readonly inheritCallerTools?: boolean;
  readonly reasoningEffort?: ReasoningEffort | null;
};

@syncing("harness:job:child-agent-call")
export class AgentCallJob extends CallJob {
  override readonly owner: JobEffectOwner = "agent-calls";
  override readonly intent: string =
    "Persist owned child invocation identity before starting the child. Nested worker effects own their intents.";
  override readonly checkpoint: string =
    "workerSessionId identifies the same owned child across recovery; child options live on the call.";
  override readonly dispatch: string =
    "Create or reattach the owned child, start it once, and observe its terminal reply.";
  override readonly settlement: string =
    "AgentCallJob.outcome + completed after the owned child replies or terminates.";
  override readonly cancel: string = "Cancel this invocation and its owned child work.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-inner";
  override readonly unknownNote: string =
    "Reattach the same child invocation. Never create a second child because observation was interrupted.";
  override readonly intentRequired: boolean = true;

  /**
   * Stored system line for a wire ask. A call that stores
   * {@link promptMessages} leaves this empty; the line to read is {@link systemPrompt}.
   */
  @syncing accessor constitution: SystemPrompt = prompt.system``;
  /** Ordered authored rows. The system line is {@link systemPrompt}; the worker turn is {@link speech}. */
  @syncing.child.list accessor promptMessages: PromptMessage[] = [];
  @syncing accessor faceName: string = "";
  @syncing.list accessor tools: string[] = [];
  /** Omitted prompt tools inherit the caller's catalog. */
  @syncing accessor inheritCallerTools: boolean = false;
  @syncing accessor reasoningEffort: ReasoningEffort | null = null;

  constructor(props?: AgentCallJobProps | symbol) {
    super(props);
    if (typeof props !== "symbol" && props?.tools != null) this.tools = [...props.tools];
  }

  /**
   * What `await` yields. Cancel rejects before `endedAtMs`: a cancelled ask
   * has no end clock. A missing snap is a failure. Other tool calls fulfill
   * `undefined` and ignore cancel.
   */
  @computed
  override get result(): JobResolution<unknown, string> | null {
    if (this.endedAtMs == null && !this.cancelled) return null;
    if (this.cancelled) return { status: "rejected", reason: "dotprompt/run: ask cancelled" };
    const snap = this.outcomeSnap;
    if (snap == null) return { status: "rejected", reason: "ask failed" };
    if (!snap.ok) {
      const text = snap.text?.trim() ?? "";
      if (text !== "") return { status: "rejected", reason: text };
      if (snap.code != null && snap.code !== "") return { status: "rejected", reason: snap.code };
      return { status: "rejected", reason: "ask failed" };
    }
    if (this.responseSchema == null) return { status: "fulfilled", value: snap.value ?? "" };
    if (snap.value === undefined)
      return { status: "rejected", reason: "dotprompt/run: structured ask returned no value" };
    try {
      return { status: "fulfilled", value: structuredClone(snap.value) };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "ask failed";
      return { status: "rejected", reason };
    }
  }

  /**
   * System line. Authored system rows win, so a prompt call does not also
   * persist the joined string. With no system row, this is {@link constitution}.
   */
  @computed
  get systemPrompt(): SystemPrompt {
    const systems = this.promptMessages.filter((row) => row.role === "system");
    if (systems.length === 0) return this.constitution;
    return asSystemPrompt(
      systems
        .map((row) => row.content)
        .join("\n\n")
        .trim(),
    );
  }

  /**
   * Worker turn. One user row passes through. Any other authored shape is
   * labeled. With no non-system row, this is the stored `message` argument.
   */
  @computed
  get speech(): string {
    const speech = this.promptMessages.filter((row) => row.role !== "system");
    if (speech.length === 0) return this.argString("message");
    const only = speech.length === 1 ? speech[0] : undefined;
    if (only?.role === "user") return only.content;
    return speech.map((row) => (row.role === "user" ? row.content : `${row.role}:\n${row.content}`)).join("\n\n");
  }

  /** A guard's rewritten prompt. System rows stay; the new text is one user row. */
  @syncing.action
  replaceSpeech(content: string): void {
    const systems = this.promptMessages.filter((row) => row.role === "system");
    this.promptMessages.splice(0, this.promptMessages.length, ...systems, new PromptMessage({ role: "user", content }));
  }
}
