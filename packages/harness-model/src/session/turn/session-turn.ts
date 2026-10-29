/**
 * Job. `.work` is raw `children` — COLLECTORS ARE NOT `.work`.
 * `reducerExited` is the reducer exit. Background is a flag on the child.
 */
import { syncing } from "@here.build/plexus";
import { prompt, type UserPrompt } from "@inhuman.tools/harness-commons";
import {
  Job,
  type JobEffectOwner,
  type UnknownOutcomeRecovery,
  walkWork,
  type WorkContainer,
} from "@inhuman.tools/plexus-expectations";
import { comparer, computed } from "mobx";
import type { ReadonlyDeep } from "type-fest";

import { deepFreeze, frozenRecord } from "../../json-record.js";
import { DEFAULT_COMPACT_TRIGGERS, parseCompactTrigger } from "../../kernel/KernelRoot.js";
import { updateMetadataArgsSchema } from "../../schemas/update-metadata.js";
import { contextNeedFromChunks, type ContextNeed } from "../context-need.js";
import type { PermissionMode } from "../eval-context.js";
import { AgentCallNotification } from "../jobs/AgentCallNotification.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob, tapeCompletion } from "../jobs/CompletionJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SequenceJob } from "../jobs/SequenceJob.js";
import { ToolCallJob } from "../jobs/ToolCallJob.js";
import { RegisteredToolsSet } from "../RegisteredToolsSet.js";
import type { SessionSystemPrompt, SystemPromptParts } from "../SessionSystemPrompt.js";
import { SessionSystemPromptDerivation } from "../SessionSystemPromptDerivation.js";
import { storageAfterTurn, type PluginStorageMap } from "../trajectory-projection.js";
import {
  clampChars,
  jobTriggersReactLoop,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  UPDATE_METADATA_TOOL_NAME,
} from "../update-metadata.js";
import { TurnApprovalNoteChunk } from "./approval-note-chunk.js";
import { SessionTurnEvalSpec } from "./eval-spec.js";
import { TurnNotificationChunk } from "./notification-chunk.js";
import { TurnPromptChunk } from "./prompt-chunk.js";
import { ReACTChunk } from "./react-chunk.js";
import type { SessionUnit, TurnChunk } from "./types.js";
import { parseUserVisuals, userVisualsJson, type UserVisualIdentity } from "./user-visual.js";

export type TurnMetadata = {
  readonly title: string;
  readonly description: string;
};

function metadataOf(job: ToolCallJob): TurnMetadata | null {
  if (job.name !== UPDATE_METADATA_TOOL_NAME) return null;
  const rec = job.args;
  if (rec == null) return null;
  const parsed = updateMetadataArgsSchema.safeParse(rec);
  if (!parsed.success) return null;
  const title = clampChars(
    typeof parsed.data.current_turn_title === "string" ? parsed.data.current_turn_title.trim() : "",
    SESSION_TITLE_MAX_CHARS,
  );
  const description = clampChars(
    typeof parsed.data.current_turn_description === "string" ? parsed.data.current_turn_description.trim() : "",
    SESSION_DESCRIPTION_MAX_CHARS,
  );
  return title !== "" ? { title, description } : null;
}

@syncing("harness:session:turn")
export class SessionTurn extends SequenceJob {
  override readonly owner: JobEffectOwner = "session-runtime";
  override readonly intent: string =
    "None as a container. cancelRequested is the durable cancel intent for this turn. Child effects use child rows.";
  override readonly checkpoint: string =
    "queue, doneWork, reducerExited, cancelRequested, orchestrationResult on the session document.";
  override readonly dispatch: string = "Turn loop after inboundTurnGuard. Shifting a chunk is not an external effect.";
  override readonly settlement: string = "reducerExited + completed. Open background children do not block.";
  override readonly cancel: string =
    "Persist cancelRequested, then settleCancelledTurn (skip `call` lifetime Calls). reducerExited + cancelRequested recovers leftover PEW as cancelled.";
  override readonly unknownRecovery: UnknownOutcomeRecovery = "resume-inner";
  override readonly unknownNote: string =
    "If cancelRequested, settle cancel. Else restore the last pending doneWork chunk onto the queue; a model round the park or restart interrupted gets a fresh round (a new CompletionJob is a new attempt). Children follow their rows.";
  override readonly intentRequired: boolean = false;

  @syncing accessor turnTail!: SessionUnit;
  @syncing accessor prompt: UserPrompt = prompt.user``;
  /**
   * Model-facing text when it differs from {@link prompt}. Null on an
   * ordinary turn. Skill expansion stores the injection here and leaves
   * `prompt` as the typed slash.
   */
  @syncing accessor derivedMessage: UserPrompt | null = null;
  /** Inbound comms wait for the preceding turn at its next model-input boundary. */
  @syncing accessor inbound: boolean = false;
  @syncing accessor agentRequestId: string = "";
  @syncing accessor derivation: SessionSystemPromptDerivation | null = null;
  /**
   * Frozen tools choice for this turn. Null inherits `tail.tools`.
   * First turn attributes the set; a later turn only holds a new one when
   * its tail has `reloadTools`.
   */
  @syncing.child accessor toolsDefinition: RegisteredToolsSet | null = null;
  /**
   * The turn whose `tail` is this must snapshot a new RegisteredToolsSet.
   * Compact sets this; it does not rewrite this turn's choice. A new MCP is
   * not a flag — successor mint compares `tools.mcpConnections` to kernel.
   */
  @syncing accessor reloadTools: boolean = false;
  /** ReACT tape (done). Refs: a Job's owning list is `children`; other chunks have none. */
  @syncing.list accessor doneWork: TurnChunk[] = [];
  /** ReACT tape (pending). Refs: a Job's owning list is `children`; other chunks have none. */
  @syncing.list accessor queue: TurnChunk[] = [new TurnPromptChunk()];
  /** Reducer exited. Open background children do not block. */
  @syncing accessor reducerExited: boolean = false;
  /**
   * Tri-state overlay for this turn. Null inherits `tail`; first turn
   * attributes from standing.
   */
  @syncing accessor permissionMode: PermissionMode | null = null;
  /**
   * Unattended admission. Null is an ordinary interactive turn. Presence
   * fixes this run's request identity and policy; observer `permissionMode`
   * must not replace it.
   */
  @syncing.child accessor evalSpec: SessionTurnEvalSpec | null = null;
  /** Persist before acknowledging cancel. Default false on older documents. */
  @syncing accessor cancelRequested: boolean = false;
  /**
   * Why the turn stopped before the model finished: the error that broke the
   * reducer, a plugin/guard failure, or a limit the loop enforced (round cap, output
   * limit, content filter). Empty when it ended normally or by cancel. The one
   * record of an early stop: every client and the transcript can say "this turn
   * stopped because ..." instead of showing a silent stop.
   */
  @syncing accessor broke: string = "";
  /**
   * Round cap in force for this turn, recorded when the loop starts so a live
   * config change cannot move a running turn. Null until stamped; 0 is unlimited.
   */
  @syncing accessor maxRounds: number | null = null;
  /** Consecutive `length` continuation rounds allowed, recorded with {@link maxRounds}. 0 is off. */
  @syncing accessor lengthContinuations: number | null = null;
  /**
   * Speech-question pin. Empty unless intern A voted `awaiting_user`.
   * Not license `ask`. Glance unfinished `question`.
   */
  @syncing accessor questionLine: string = "";
  /**
   * The session's plugin state logs (`SessionRoot.pluginState`) when this
   * turn ended. Rewinding to this turn restores them. Null: not recorded.
   */
  /**
   * Picture identity for this user turn. Bytes are a sidecar file, not
   * this cell. `[]` is a turn with no picture.
   */
  @syncing private accessor visualsJson: string = "[]";

  /**
   * R1. The context-retention policy resolved when this turn was minted
   * (layered config, narrowed by session kv). Empty = a turn minted before
   * retention existed, or an inbound turn that inherits its tail's stamp.
   * Later config edits apply from the next turn on.
   */
  @syncing accessor retentionJson: string = "";

  @syncing private accessor pluginStateJson: string | null = null;

  @computed
  get pluginState(): ReadonlyDeep<Record<string, string>> | null {
    const rec = frozenRecord(this.pluginStateJson);
    if (rec == null) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(rec)) {
      if (typeof value !== "string") return null;
      out[key] = value;
    }
    return deepFreeze(out);
  }

  set pluginState(next: Readonly<Record<string, string>> | null) {
    const json = next == null ? null : JSON.stringify(next);
    if (json === this.pluginStateJson) return;
    this.pluginStateJson = json;
  }

  @computed
  get visuals(): readonly UserVisualIdentity[] {
    return parseUserVisuals(this.visualsJson);
  }

  set visuals(next: readonly UserVisualIdentity[]) {
    const json = userVisualsJson(next);
    if (json === this.visualsJson) return;
    this.visualsJson = json;
  }

  @computed
  get effectivePermissionMode(): PermissionMode {
    for (const turn of tailTurns(this)) {
      if (turn.permissionMode != null) return turn.permissionMode;
    }
    return "manual";
  }

  /** The tools this turn decided to use — own set, or the inherited choice. */
  @computed
  get tools(): RegisteredToolsSet {
    for (const turn of tailTurns(this)) {
      if (turn.toolsDefinition != null) return turn.toolsDefinition;
    }
    return genesisOf(this).tools;
  }

  /** Genesis parts through each derivation, oldest first, with this turn's tools. */
  @computed
  get systemParts(): SystemPromptParts {
    let parts = genesisOf(this).parts();
    for (const turn of [...tailTurns(this)].reverse()) parts = turn.derivation?.apply(parts) ?? parts;
    return { ...parts, tools: this.tools.entries };
  }

  /** What the model reads. Consumers use this, not `prompt` and not `derivedMessage`. */
  @computed
  get completionMessage(): UserPrompt {
    return this.derivedMessage ?? this.prompt;
  }

  /**
   * Parent a Job onto `children`. Non-Jobs no-op. Not `parent` — Plexus owns that name.
   */
  pushChild(child: TurnChunk): void {
    if (!(child instanceof Job)) return;
    this.registerJob(child);
  }

  /** Parent a Job onto `children`, then push the ReACT queue (refs). */
  @syncing.action
  enqueue(chunk: TurnChunk): void {
    bindContinuation(chunk, tapePredecessor(this));
    this.pushChild(chunk);
    this.queue.push(chunk);
  }

  /** Move the next queued cell onto `doneWork` in one transaction: a crash cannot drop it from both. */
  @syncing.action
  take(): TurnChunk | undefined {
    const cell = this.queue.shift();
    if (cell != null) this.doneWork.push(cell);
    return cell;
  }

  /**
   * One note cell per leaf of the round since the last completion that a
   * human allowed or refused with a comment, unless it already has one.
   */
  @syncing.action
  claimApprovalNotes(): void {
    const noted = new Set<string>();
    for (const cell of reactChunks(this)) {
      if (cell instanceof TurnApprovalNoteChunk) noted.add(cell.leafId);
    }
    const leaves: ToolCallJob[] = [];
    const roundStart = this.doneWork.findLastIndex((cell) => tapeCompletion(cell) != null) + 1;
    for (const done of this.doneWork.slice(roundStart)) {
      if (done instanceof ToolCallJob) leaves.push(done);
      else if (done instanceof ProgrammaticJob) leaves.push(...done.toolCalls);
    }
    for (const leaf of leaves) {
      const note = leaf.approvalComment?.trim() ?? "";
      if (noted.has(leaf.uuid) || note === "") continue;
      if (leaf.humanApprove !== true && leaf.humanApprove !== false) continue;
      this.doneWork.push(
        new TurnApprovalNoteChunk({
          leafId: leaf.uuid,
          toolName: leaf.name,
          allowed: leaf.humanApprove,
          text: prompt.user`${note}`,
        }),
      );
      noted.add(leaf.uuid);
    }
  }

  /** Record the loop limits once, when the turn starts. Later calls keep the first reading. */
  @syncing.action
  stampLoopLimits(limits: { readonly maxRounds: number; readonly lengthContinuations: number }): void {
    if (this.maxRounds == null) this.maxRounds = limits.maxRounds;
    if (this.lengthContinuations == null) this.lengthContinuations = limits.lengthContinuations;
  }

  /**
   * End the loop on purpose. The words are the turn's `broke` fact, and land on the tape
   * as a notification cell, which the user's transcript shows and the next round reads.
   */
  @syncing.action
  stopLoop(message: string): void {
    if (this.broke !== "") return;
    this.broke = message;
    this.doneWork.push(new TurnNotificationChunk({ notifications: [new AgentCallNotification({ message })] }));
  }

  /** Model rounds this turn has opened: actor completions on its own tape. */
  @computed
  get rounds(): number {
    let count = 0;
    for (const cell of this.doneWork) {
      const pew = tapeCompletion(cell);
      if (pew != null && pew.completionMode !== "isolated") count += 1;
    }
    return count;
  }

  @computed({ equals: comparer.structural })
  get ownOccupancy(): ContextGauge | null {
    return ownContextOccupancy(this);
  }

  @computed({ equals: comparer.structural })
  private get occupancy(): ContextGauge {
    return contextOccupancy(this);
  }

  @computed({ equals: comparer.shallow })
  get subtreeWork(): readonly WorkContainer[] {
    return [...walkWork(this)];
  }

  @computed({ equals: comparer.shallow })
  get openBackgroundWork(): readonly WorkContainer[] {
    const out: WorkContainer[] = [];
    for (const node of this.subtreeWork) {
      if ((node instanceof ToolCallJob || node instanceof ProgrammaticJob) && node.background && !node.completed) {
        out.push(node);
      }
    }
    return out;
  }

  @computed({ equals: comparer.shallow })
  get notificationChunks(): readonly TurnNotificationChunk[] {
    const out: TurnNotificationChunk[] = [];
    for (const chunk of this.doneWork) {
      if (chunk instanceof TurnNotificationChunk) out.push(chunk);
    }
    for (const chunk of this.queue) {
      if (chunk instanceof TurnNotificationChunk) out.push(chunk);
    }
    return out;
  }

  /**
   * Latest stamped window occupancy on this tape (this turn, then tails).
   * `totalTokens` is a gauge, not a per-cell sum. A live round that has not
   * reported yet (`null`) still reports the prior round's used.
   */
  @computed
  get contextUsed(): number {
    return this.occupancy.used;
  }

  /**
   * True when `contextUsed` is unknown because a compact cutoff landed after
   * the last reading. The next round that reports clears it.
   */
  @computed
  get contextStale(): boolean {
    return this.occupancy.stale;
  }

  /** Model window from the newest completion that reported one. 0 if unknown. */
  @computed
  get contextLimit(): number {
    return this.occupancy.limit;
  }

  /**
   * Model that stamped the window gauge on this tape. Empty until a round
   * reports one. A session `kvs.model` that differs from this is a switch:
   * the window moved, but the tape has not re-measured it yet.
   */
  @computed
  get contextModel(): string {
    return this.occupancy.model;
  }

  /**
   * Host-evaluated context operands for this head. Own job after the cutoff,
   * else the tail, unless this turn itself has a cutoff. Not a stored field.
   */
  @computed
  get contextNeed(): ContextNeed | null {
    for (const turn of tailTurns(this)) {
      const chunks = reactChunks(turn);
      const own = contextNeedFromChunks(chunks, null);
      if (own != null || chunks.some((chunk) => chunk instanceof CompactJob && chunk.cutoff)) return own;
    }
    return null;
  }

  @computed.struct
  private get ownMetadata(): TurnMetadata | null {
    const chunks = reactChunks(this);
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const chunk = chunks[index];
      if (chunk instanceof ToolCallJob && !jobTriggersReactLoop(chunk)) {
        const hit = metadataOf(chunk);
        if (hit !== null) return hit;
      }
      if (chunk instanceof ProgrammaticJob) {
        for (let inner = chunk.toolCalls.length - 1; inner >= 0; inner -= 1) {
          const job = chunk.toolCalls[inner];
          if (!jobTriggersReactLoop(job)) {
            const hit = metadataOf(job);
            if (hit !== null) return hit;
          }
        }
      }
    }
    return null;
  }

  @computed.struct
  get metadata(): TurnMetadata | null {
    for (const turn of tailTurns(this)) {
      const hit = turn.ownMetadata;
      if (hit !== null) return hit;
    }
    return null;
  }

  /**
   * Token occupancy that fires soft compact: `contextLimit * soft ratio`.
   * `trigger` is a `compactTriggers.soft` literal. 0 if the window is unknown.
   */
  contextSoftCompactAt(trigger: string = DEFAULT_COMPACT_TRIGGERS.soft): number {
    const ratio = parseCompactTrigger(trigger);
    const limit = this.contextLimit;
    if (ratio == null || limit <= 0) return 0;
    return Math.floor(limit * ratio);
  }

  /**
   * Remaining-until-soft-compact as 0..1 fill. Null until a window exists.
   * 1 = empty runway; 0 = at or past the soft trigger. Pass `limit` when the
   * host resolved a window the tape has not stamped yet — a model switch
   * moves the window before the next round measures it.
   */
  contextRemainingProgress(
    trigger: string = DEFAULT_COMPACT_TRIGGERS.soft,
    limit: number = this.contextLimit,
  ): number | null {
    const ratio = parseCompactTrigger(trigger);
    if (ratio == null || !(limit > 0)) return null;
    const at = Math.floor(limit * ratio);
    if (!(at > 0)) return null;
    return Math.max(0, Math.min(1, (at - this.contextUsed) / at));
  }

  /** Prefix projection through this turn’s tape. Time-travel is an older turn’s getter. */
  @computed.struct
  get storageAfter(): PluginStorageMap {
    return storageAfterTurn(this);
  }

  /** Live completion, tool, or scheme still open on this tape. */
  @computed
  get openWork(): boolean {
    for (const chunk of reactChunks(this)) {
      const completion = tapeCompletion(chunk);
      if (completion != null && completion.outcome == null) return true;
      if (chunk instanceof ToolCallJob && !chunk.completed && chunk.receiptJson == null) return true;
      if (chunk instanceof ProgrammaticJob) {
        if (!chunk.completed && chunk.receiptJson == null) return true;
        for (const inner of chunk.toolCalls) {
          if (!inner.completed && inner.receiptJson == null) return true;
        }
      }
    }
    return false;
  }

  /**
   * Loop token still on the tape after the last completion: ReACT / prompt /
   * compact, or an uncompleted CompactJob. A later completion clears it.
   */
  @computed
  get queuedContinuation(): boolean {
    let pending = false;
    for (const chunk of reactChunks(this)) {
      if (chunk instanceof ReACTChunk && chunk.skipped) continue;
      if (
        chunk instanceof ReACTChunk ||
        chunk instanceof TurnPromptChunk ||
        (chunk instanceof CompactJob && !chunk.completed)
      ) {
        pending = true;
      } else if (tapeCompletion(chunk) != null) {
        pending = false;
      }
    }
    return pending;
  }

  /** Executor is still inside this turn. A queued prompt waits here. */
  @computed
  get inLoop(): boolean {
    return !this.reducerExited;
  }

  /** Cancel request, cancel ack, or reducer exit — live chrome must drop. */
  @computed
  get cutOff(): boolean {
    return this.reducerExited || this.cancelled || this.cancelRequested;
  }

  /** Unattended admission. Interactive turns are null `evalSpec`. */
  @computed
  get unattended(): boolean {
    return this.evalSpec != null;
  }

  /**
   * The head turn's reducer has left, the turn is interactive, and it did not
   * true-finish. Empty Enter continues it. Cancel offers a successor only
   * after `Job.cancelled`. Trailing side-channel tools ride the last
   * successful completion. A successful compact cutoff is a finish.
   */
  @computed
  get lastTurnIncomplete(): boolean {
    if (!this.reducerExited || this.unattended) return false;
    if (this.openWork) return false;
    if (this.cancelled) return true;
    const chunks = reactChunks(this);
    let index = chunks.length - 1;
    while (index >= 0) {
      const chunk = chunks[index];
      if (
        (chunk instanceof ReACTChunk && chunk.skipped) ||
        (chunk instanceof ToolCallJob && !jobTriggersReactLoop(chunk))
      ) {
        index -= 1;
        continue;
      }
      break;
    }
    const last = index >= 0 ? chunks[index] : undefined;
    if (last instanceof CompactJob) return !last.cutoff;
    const completion = tapeCompletion(last);
    return !(completion != null && completion.outcome === "successful");
  }

  constructor(
    props?:
      | {
          readonly turnTail?: SessionUnit;
          readonly prompt?: UserPrompt;
          readonly derivedMessage?: UserPrompt | null;
          readonly agentRequestId?: string;
          readonly inbound?: boolean;
          readonly derivation?: SessionSystemPromptDerivation | null;
          readonly toolsDefinition?: RegisteredToolsSet | null;
          readonly reloadTools?: boolean;
          readonly doneWork?: TurnChunk[];
          readonly queue?: TurnChunk[];
          readonly reducerExited?: boolean;
          readonly permissionMode?: PermissionMode | null;
          readonly evalSpec?: SessionTurnEvalSpec | null;
          readonly cancelRequested?: boolean;
          readonly broke?: string;
          readonly questionLine?: string;
          readonly maxRounds?: number | null;
          readonly visualsJson?: string;
          readonly retentionJson?: string;
          readonly orchestrationResult?: true | false | null;
          readonly cancelled?: boolean;
          readonly completed?: boolean;
        }
      | symbol,
  ) {
    super(props);
    if (typeof props === "symbol") return;
    for (const chunk of this.doneWork) this.pushChild(chunk);
    for (const chunk of this.queue) this.pushChild(chunk);
    // eslint-disable-next-line unicorn/no-this-assignment,@typescript-eslint/no-this-alias
    let prev: TapeContinuation = this;
    for (const chunk of reactChunks(this)) prev = bindContinuation(chunk, prev);
  }
}

/** ReACT tape. COLLECTORS ARE NOT `.work`. */
export function reactChunks(turn: SessionTurn): TurnChunk[] {
  return [...turn.doneWork, ...turn.queue];
}

/** `turn`, then each `turnTail` turn toward genesis. Stops at a repeat. */
function* tailTurns(turn: SessionTurn): Generator<SessionTurn> {
  const seen = new Set<SessionTurn>();
  for (let cell: SessionUnit = turn; cell instanceof SessionTurn && !seen.has(cell); cell = cell.turnTail) {
    seen.add(cell);
    yield cell;
  }
}

/** The system prompt the tail walk ends at. A `turnTail` cycle has none. */
function genesisOf(turn: SessionTurn): SessionSystemPrompt {
  let oldest = turn;
  for (const cell of tailTurns(turn)) oldest = cell;
  const genesis = oldest.turnTail;
  if (genesis instanceof SessionTurn) throw new Error("turnTail cycle");
  return genesis;
}

type TapeContinuation = SessionTurn | CompletionJob;

function isTapeContinuation(chunk: TurnChunk): chunk is CompletionJob {
  return chunk instanceof CompletionJob;
}

function tapePredecessor(turn: SessionTurn): TapeContinuation {
  let prev: TapeContinuation = turn;
  for (const chunk of reactChunks(turn)) {
    if (isTapeContinuation(chunk)) prev = chunk;
  }
  return prev;
}

function bindContinuation(chunk: TurnChunk, prev: TapeContinuation): TapeContinuation {
  if (!isTapeContinuation(chunk)) return prev;
  if (chunk.turnTail == null) chunk.turnTail = prev;
  return chunk;
}

type ContextGauge = {
  readonly used: number;
  readonly limit: number;
  readonly model: string;
  /**
   * True when the newest reading predates a successful compact cutoff on this
   * tape. The window shrank when the cutoff took effect, so that reading
   * describes a context that no longer exists: `used` is 0 (unknown) until a
   * round after the cutoff reports.
   */
  readonly stale: boolean;
};

function completionGauge(chunk: TurnChunk): Omit<ContextGauge, "stale"> | null {
  const rec = tapeCompletion(chunk);
  if (rec == null) return null;
  const used = typeof rec.totalTokens === "number" && Number.isFinite(rec.totalTokens) ? rec.totalTokens : undefined;
  const limit =
    typeof rec.contextLimit === "number" && Number.isFinite(rec.contextLimit) ? rec.contextLimit : undefined;
  if (used === undefined && limit === undefined) return null;
  return {
    used: used === undefined || used < 0 ? 0 : used,
    limit: limit === undefined || limit < 0 ? 0 : limit,
    model: rec.model.trim(),
  };
}

/**
 * Newest-first scan over the given tapes (each newest-first). `used` is the
 * newest positive reading, unless a successful compact cutoff sits after it:
 * then the reading is stale and `used` stays 0. `limit` is the window and
 * survives a cutoff.
 */
function scanOccupancy(turns: Iterable<SessionTurn>): ContextGauge | null {
  let used = 0;
  let limit = 0;
  let model = "";
  let stale = false;
  let cut = false;
  let seen = false;
  for (const turn of turns) {
    const chunks = reactChunks(turn);
    for (let i = chunks.length - 1; i >= 0; i -= 1) {
      const chunk = chunks[i]!;
      if (chunk instanceof CompactJob && chunk.cutoff) {
        if (used === 0) cut = true;
        continue;
      }
      const gauge = completionGauge(chunk);
      if (gauge == null) continue;
      seen = true;
      if (limit === 0 && gauge.limit > 0) {
        limit = gauge.limit;
        model = gauge.model;
      }
      if (used === 0 && !stale && gauge.used > 0) {
        if (cut) stale = true;
        else used = gauge.used;
      }
      if (limit > 0 && (used > 0 || stale)) return { used, limit, model, stale };
    }
  }
  return seen ? { used, limit, model, stale } : null;
}

function ownContextOccupancy(turn: SessionTurn): ContextGauge | null {
  return scanOccupancy([turn]);
}

function contextOccupancy(turn: SessionTurn): ContextGauge {
  return scanOccupancy(tailTurns(turn)) ?? { used: 0, limit: 0, model: "", stale: false };
}
