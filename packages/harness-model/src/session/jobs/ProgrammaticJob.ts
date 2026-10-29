/**
 * Host program bag. Inner tools are children; sealing this bag does not wait
 * on them. Wait is host async inside the parent Turn's executor. Compact is
 * the other Scheme-in-interpret seat. The ReACT tape does not flatten inners.
 * `walkBoundary` stays false: not every program is a two-plane contour.
 *
 * Period clock is interpreter-owned (`period` on args). `periodChildAt` is the
 * first inner of the open tick (replay must not remint a prior tick).
 * `periodWaitUntilMs` is the idle deadline — not on the per-tick timeout or inner-call ceiling.
 * `notifications` are origin atoms (`self/notify`). Incomplete bags feed
 * the session pending-notify computed; a `TurnNotificationChunk` consumes them.
 */
import { syncing } from "@here.build/plexus";
import {
  Job,
  type JobEffectOwner,
  type JobKind,
  type JobResolution,
  type UnknownOutcomeRecovery,
} from "@inhuman.tools/plexus-expectations";
import { computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto, syncingText } from "../../json-record.js";
import { type ToolOutcomeSnap } from "../../schemas/index.js";
import { programKind, programKindNow } from "../program-kind.js";
import { SCHEME_REPL_TOOL_NAME, SCHEME_WATCH_TOOL_NAME } from "../scheme-syntax.js";
import { finishedText, parseToolOutcome, receiptResult } from "../tool-outcome.js";
import { AgentCallNotification, rememberJobResult, RESULT_NOTE_CHARS } from "./AgentCallNotification.js";
import { SequenceJob } from "./SequenceJob.js";
import { ToolCallJob } from "./ToolCallJob.js";

@syncing("harness:job:programmatic")
export class ProgrammaticJob extends SequenceJob<unknown, string> {
  override readonly owner: JobEffectOwner = "scheme-runtime";
  override readonly intent: string =
    "The bag does not dispatch external I/O. Inner ToolCallJobs require their own durable intent. periodChildAt is the resume checkpoint so replay does not remint a prior tick.";
  override readonly checkpoint: string =
    "periodChildAt, periodWaitUntilMs, orchestrationResult, children, notifications, modules, world, boundTools on the session document.";
  override readonly dispatch: string =
    "runProgram / runWatch. The harness tool run is that call. Inner admits are nested ToolCallJobs; complete() for prompts is CompletionJob/PEW.";
  override readonly settlement: string = "outcomeJson + completed. Sealing the bag does not wait on inner children.";
  override readonly cancel: string =
    "If the hosting turn cancelRequested, CANCELLED receipt + completed. Inner cancel follows inner rows.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-inner";
  override readonly unknownNote: string =
    "Resume the interpreter from durable periodChildAt. Inner unknown follows inner rows (no remint, no replay of unsettled MCP/system/web).";
  override readonly intentRequired: boolean = false;

  @syncing accessor toolCallId: string = "";
  @syncing accessor toolName: string = SCHEME_REPL_TOOL_NAME;
  @syncing private accessor argsJson: string | null = "{}";
  @syncing private accessor outcomeJson: string | null = null;
  @syncing.child.list accessor notifications: AgentCallNotification[] = [];
  @syncing accessor periodChildAt: number = 0;
  @syncing accessor periodWaitUntilMs: number | null = null;
  @syncing.record accessor pluginMeta: Record<string, string> = {};
  @syncing accessor triggersReactLoop: boolean = true;
  @syncing accessor tapeHidden: boolean = false;
  /** R2. Resolved retention rule stamped at admit. See {@link ToolCallJob.retentionJson}. */
  @syncing accessor retentionJson: string = "";
  /** This run stamps a call-start track on every child. Stories and old jobs leave it false. */
  @syncing accessor trackMatch: boolean = false;
  /** `require` / `.prompt` bytes, keyed by the loader's root-relative path. */
  @syncing.record accessor modules: Record<string, string> = {};
  /** Host reads that are not jobs, keyed by the crossing track. JSON text. */
  @syncing.record accessor world: Record<string, string> = {};
  /** Pack-tool names bound for this run. The standard verbs are always bound. */
  @syncing.record accessor boundTools: Record<string, string> = {};

  constructor(
    props?:
      | {
          readonly toolCallId?: string;
          readonly toolName?: string;
          readonly argsJson?: string | null;
          readonly outcomeJson?: string | null;
          readonly background?: boolean;
          readonly walkBoundary?: boolean;
          readonly children?: Job[];
          readonly orchestrationResult?: true | false | null;
          readonly cancelled?: boolean;
          readonly completed?: boolean;
          readonly notifications?: AgentCallNotification[];
          readonly periodChildAt?: number;
          readonly periodWaitUntilMs?: number | null;
          readonly pluginMeta?: Record<string, string>;
          readonly triggersReactLoop?: boolean;
          readonly tapeHidden?: boolean;
          readonly retentionJson?: string;
        }
      | symbol,
  ) {
    super(props);
  }

  @computed
  override get result(): JobResolution<unknown, string> | null {
    return receiptResult(this.endedAtMs, this.outcomeSnap);
  }

  /** Every terminal path ends here, so a background program posts its result once. */
  @syncing.action
  override markComplete(now = Date.now()): void {
    if (!this.completed) {
      rememberJobResult(
        this,
        finishedText(this, this.outcomeSnap, () => this.resultText()),
        RESULT_NOTE_CHARS,
      );
    }
    super.markComplete(now);
  }

  @computed
  get toolCalls(): ToolCallJob[] {
    return this.children.filter((node): node is ToolCallJob => node instanceof ToolCallJob);
  }

  /** Parent an inner tool onto children. Not a second owning list. */
  pushInvocation(inner: ToolCallJob): void {
    this.registerJob(inner);
  }

  @serializingInto("argsJson")
  accessor args: ReadonlyDeep<Record<string, unknown>> | null = null;

  @computed
  get outcomeSnap(): ToolOutcomeSnap | undefined {
    return parseToolOutcome(this.outcomeJson);
  }

  set outcomeSnap(next: ToolOutcomeSnap) {
    this.outcomeJson = JSON.stringify(next);
  }

  /** Stored receipt text. Empty and missing stay distinct; this is not {@link outcomeSnap}. */
  get receiptJson(): string | null {
    return syncingText(this.outcomeJson);
  }

  set receiptJson(next: string | null) {
    this.outcomeJson = next;
  }

  @computed
  get expr(): string {
    const args = this.args;
    if (args != null && typeof args.expr === "string") return args.expr;
    return syncingText(this.argsJson) ?? "";
  }

  /**
   * `scheme_watch` is a workflow even when every call is one kind.
   * Arrival's reader is async, so any other program stays a workflow until
   * {@link programKind} settles; the settled map is observable, so a reader recomputes.
   */
  override get kind(): JobKind {
    if (this.toolName === SCHEME_WATCH_TOOL_NAME) return "workflow";
    const expr = this.expr;
    void programKind(expr);
    return programKindNow(expr);
  }

  override get isTrackedBackground(): boolean {
    return this.background || this.toolName === SCHEME_WATCH_TOOL_NAME;
  }

  override get object(): string {
    const expr = this.expr.replaceAll(/\s+/g, " ").trim();
    return expr === "" ? this.toolName : expr.slice(0, 120);
  }

  /** One `{type:"text"}` per printed statement. Face envelopes contribute `.text`. */
  resultParts(): readonly ToolTextPart[] | undefined {
    const snap = this.outcomeSnap;
    if (snap === undefined) return undefined;
    if (!("value" in snap) || !Array.isArray(snap.value)) return undefined;
    const texts: string[] = [];
    for (const item of snap.value) {
      let text: string | undefined;
      if (typeof item === "string") text = item;
      else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const rec = item as { text?: unknown };
        if (typeof rec.text === "string") text = rec.text;
      }
      if (text === undefined) return undefined;
      texts.push(text);
    }
    return texts.map((text) => ({ type: "text" as const, text }));
  }

  resultText(): string {
    const parts = this.resultParts();
    if (parts !== undefined) return parts.map((part) => part.text).join("\n");
    const snap = this.outcomeSnap;
    if (snap === undefined) return "";
    if ("value" in snap) {
      try {
        return JSON.stringify(snap.value);
      } catch {
        return String(snap.value);
      }
    }
    if (typeof snap.text === "string") return snap.text;
    return "";
  }

  @syncing.action
  stampPluginMeta(pluginId: string, encoded: string): void {
    this.pluginMeta[pluginId] = encoded;
  }
}

export type ToolTextPart = { readonly type: "text"; readonly text: string };
