import { createHash } from "node:crypto";

import { rowPairId, type SessionPatchBatch } from "@inhuman.tools/harness-contract";
import { resolvedTip, SessionDocument, SessionTurn, type SessionRoot } from "@inhuman.tools/harness-model/session";
import { type ModelPatch } from "@inhuman.tools/model";
import { computed, observable, runInAction, when } from "mobx";
import { z } from "zod";

import { glanceAskLine } from "./ask-line.js";
import {
  receiptCovers,
  SessionOwnershipError,
  SessionPersistenceError,
  type NewPendingAskRow,
  type NewSessionEffectRow,
  type NewSessionRow,
  type NewSessionTurnRow,
  type SerializedSessionDocument,
  type SessionCheckpoint,
  type SessionDurability,
  type SessionNodeRestoreState,
  type SessionReceipt,
} from "./durability.js";
import {
  effectRecordSchema,
  sessionEffectOutcomeSchema,
  sessionEffectRequestSchema,
  type SessionEffectOutcome,
  type SessionEffectPort,
  type SessionEffectRequest,
} from "./effects.js";
import { interruptSession } from "./interrupt.js";
import { recoverSessionJobs, type JobRecoveryOptions, type RecoveredJob } from "./recovery.js";
import { sessionColumns } from "./summary.js";
import { iterateTurn, type TurnIteratorHost } from "../runtime/turn-iterator.js";
import {
  admitCompact,
  admitTurn,
  cancelTurnCommand,
  drainPromptQueue,
  retryTurn,
  rewindTurn,
  type CancelTurnArgs,
  type CompactAdmitResult,
  type RewindResult,
  type TurnAdmitResult,
} from "../session/commands.js";
import type { SessionCommandHost } from "../session/types.js";

function inputDigest(input: string): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

type RuntimePhase = "hydrated" | "ready" | "active" | "parked" | "disposed";

export type SessionRecoveryPolicy =
  { readonly kind: "resume" } | { readonly kind: "interrupt"; readonly message: string };

type Binding = { readonly incarnation: string; revoke(): void };
const bindings = new WeakMap<SessionDocument, Binding>();

const commandResultSchema = z.union([
  z.object({ ok: z.literal(true), action: z.enum(["noop", "mint", "steer", "queue", "continue"]) }),
  z.object({ ok: z.literal(false), reason: z.string(), invalid: z.boolean().optional() }),
]);
const commandRecordSchema = z.union([
  z.object({ input: z.string(), result: commandResultSchema }),
  z.object({ format: z.literal("command-digest-v1"), inputHash: z.string(), result: commandResultSchema }),
]);
const commitRecordSchema = z.object({ format: z.literal("input-digest-v1"), hash: z.string() });

function computeTurnOrdinal(turn: SessionTurn): number {
  let depth = 0;
  const seen = new Set<SessionTurn>([turn]);
  let tail = turn.turnTail;
  while (tail instanceof SessionTurn && !seen.has(tail)) {
    seen.add(tail);
    depth += 1;
    tail = tail.turnTail;
  }
  return depth;
}

function serializeTurnRow(sessionId: string, turn: SessionTurn, ordinal: number): NewSessionTurnRow {
  let status: "running" | "completed" | "cancelled" | "failed" | "interrupted" = "running";
  if (turn.cancelRequested) {
    status = "cancelled";
  } else if (turn.reducerExited) {
    status = "completed";
  }
  const promptText =
    typeof turn.prompt === "string"
      ? turn.prompt
      : ((turn.prompt as { text?: string } | undefined)?.text ?? String(turn.prompt ?? ""));
  return {
    turnId: turn.uuid,
    sessionId,
    ordinal,
    prompt: promptText,
    status,
    cancelRequested: Boolean(turn.cancelRequested),
    reducerExited: Boolean(turn.reducerExited),
    startedAtMs: Date.now(),
    endedAtMs: turn.reducerExited ? Date.now() : null,
  };
}

function hydrateSessionEffectsMeta(session: SessionDocument, effectRecords: readonly NewSessionEffectRow[]): void {
  if (effectRecords.length === 0) return;
  session.getMetaMap("harness:session-runtime").set("version", "2");
  const commits = session.getMetaMap("harness:session-commits");
  const commands = session.getMetaMap("harness:session-commands");
  const effects = session.getMetaMap("harness:session-effects");
  for (const row of effectRecords) {
    switch (row.kind) {
      case "commit": {
        commits.set(row.effectKey, { format: "input-digest-v1", hash: row.inputHash });
        break;
      }
      case "command": {
        const parsed = JSON.parse(row.outcomeJson) as unknown;
        const result = commandResultSchema.safeParse(parsed);
        if (result.success) {
          commands.set(row.effectKey, {
            format: "command-digest-v1",
            inputHash: row.inputHash,
            result: result.data,
          });
        } else {
          commits.set(row.effectKey, { format: "input-digest-v1", hash: row.inputHash });
        }
        break;
      }
      case "effect": {
        if (row.phase === "intent") {
          const request = sessionEffectRequestSchema.parse(JSON.parse(row.outcomeJson));
          effects.set(row.effectKey, { phase: "intent", request, inputHash: row.inputHash });
        } else {
          const outcome = sessionEffectOutcomeSchema.parse(JSON.parse(row.outcomeJson));
          effects.set(row.effectKey, { phase: "result", inputHash: row.inputHash, outcome });
        }
        break;
      }
    }
  }
}

export class SessionRuntime implements AsyncDisposable {
  readonly session: SessionDocument;
  readonly incarnation = crypto.randomUUID();
  readonly #durability: SessionDurability;
  readonly #controller = new AbortController();
  readonly #ownershipController = new AbortController();
  readonly #operations = new Map<string, { readonly input: string; readonly run: Promise<SessionEffectOutcome> }>();
  readonly #runs = new Map<SessionTurn, AbortController>();
  readonly #stops: Array<() => void> = [];
  readonly #accumulatedPatches: Array<{ patch: ModelPatch; revision: number }> = [];
  readonly #dirtyNodeIds = new Set<string>();
  #pendingEffectRecords: NewSessionEffectRow[] = [];
  #revision = 0;
  #lastCommittedRevision = 0;
  #commands: Promise<unknown> = Promise.resolve();
  #flushes: Promise<unknown> = Promise.resolve();
  #blocked: SessionCheckpoint | null = null;
  @observable accessor phase: RuntimePhase = "hydrated";
  @observable accessor #holds = 0;

  constructor(session: SessionDocument, durability: SessionDurability) {
    this.session = session;
    this.#durability = durability;
    if (session.isDestroyed) throw new Error("cannot bind a destroyed session document");
    const version = session.getMetaMap("harness:session-runtime").get("version");
    if (version !== undefined && version !== "1" && version !== "2")
      throw new Error("unsupported session runtime state version");
    const previous = bindings.get(session);
    previous?.revoke();
    bindings.set(session, { incarnation: this.incarnation, revoke: () => this.#revoke("replaced") });
    this.#revision = session.revision;
    this.#lastCommittedRevision = session.revision;

    const patchDisposer = session.onPatch((batch) => {
      this.#revision = batch.revision;
      for (const patch of batch.patches) {
        this.#accumulatedPatches.push({ patch, revision: batch.revision });
        this.#dirtyNodeIds.add(patch.nodeId);
      }
    });
    this.#stops.push(patchDisposer);

    const destroyDisposer = session.onDestroy(() => this.#revoke("destroyed"));
    this.#stops.push(destroyDisposer);
  }

  static create(sessionId: string, durability: SessionDurability, workspacePath = ""): SessionRuntime {
    return new SessionRuntime(SessionDocument.create(sessionId, workspacePath), durability);
  }

  static restore(
    sessionId: string,
    source: SessionNodeRestoreState | SerializedSessionDocument,
    durability: SessionDurability,
  ): SessionRuntime {
    let session: SessionDocument;
    if ("rows" in source) {
      session = SessionDocument.fromNodeRows(source.rows, {
        rootId: source.rootId,
        sessionId,
        revision: source.revision,
        meta: source.meta,
      });
      if (source.effectRecords && source.effectRecords.length > 0) {
        hydrateSessionEffectsMeta(session, source.effectRecords);
      }
    } else {
      session = SessionDocument.fromSnapshot(source, sessionId);
    }
    if (session.root.sessionId !== sessionId) {
      session.destroy();
      throw new Error("session checkpoint identity does not match its document");
    }
    return new SessionRuntime(session, durability);
  }

  exportRestoreState(): SessionNodeRestoreState {
    return {
      rootId: this.root.uuid,
      rows: this.session.toNodeRows(),
      revision: this.#revision,
      meta: this.session.exportMeta(),
    };
  }

  get root(): SessionRoot {
    return this.session.root;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get isCurrent(): boolean {
    return bindings.get(this.session)?.incarnation === this.incarnation && !this.session.isDestroyed;
  }

  get ownershipSignal(): AbortSignal {
    return this.#ownershipController.signal;
  }

  @computed
  get admissionHeld(): boolean {
    return this.#holds > 0;
  }

  recover(policy: SessionRecoveryPolicy = { kind: "resume" }, options: JobRecoveryOptions = {}): RecoveredJob[] {
    this.#assertOwned();
    if (this.phase !== "hydrated") return [];
    const recovered = policy.kind === "resume" ? recoverSessionJobs(this.root, options) : [];
    runInAction(() => {
      if (policy.kind === "interrupt") interruptSession(this.root, policy.message);
      const tip = resolvedTip(this.root.head, this.root.tip);
      if (tip !== this.root.tip) this.root.tip = tip;
      this.phase = "ready";
    });
    return recovered;
  }

  activate(): void {
    this.#assertOwned();
    if (this.phase === "hydrated") throw new Error("recover session before activation");
    if (this.phase === "parked" || this.phase === "disposed") throw new SessionOwnershipError();
    runInAction(() => {
      this.phase = "active";
    });
  }

  checkpoint(): SessionCheckpoint {
    this.#assertOwned();
    const nodeDelta = this.session.peekNodeDelta();

    const turnsToInclude = new Map<string, SessionTurn>();
    if (this.root.head instanceof SessionTurn) {
      turnsToInclude.set(this.root.head.uuid, this.root.head);
    }
    for (const turnId of this.#dirtyNodeIds) {
      const node = this.session.getNode(turnId);
      if (node instanceof SessionTurn) {
        turnsToInclude.set(node.uuid, node);
      } else if (node) {
        let curr: unknown = node;
        while (curr && typeof curr === "object") {
          if (curr instanceof SessionTurn) {
            turnsToInclude.set(curr.uuid, curr);
            break;
          }
          curr = (curr as { parent?: unknown }).parent;
        }
      }
    }

    const dirtyTurns: NewSessionTurnRow[] = [];
    for (const turn of turnsToInclude.values()) {
      if (this.session.getNode(turn.uuid) === undefined) continue;
      dirtyTurns.push(serializeTurnRow(this.root.sessionId, turn, computeTurnOrdinal(turn)));
    }

    const pendingAsks: NewPendingAskRow[] = [];
    for (const workItem of this.root.work) {
      if (!(workItem instanceof SessionTurn)) continue;
      for (const job of workItem.approvalLeaves) {
        if (!job.completed && !job.cancelled) {
          const isAck = job.ackState === "pending";
          const isAsk = job.policyResult === "ask" && job.humanApprove == null;
          if (isAck || isAsk) {
            pendingAsks.push({
              jobId: job.uuid,
              sessionId: this.root.sessionId,
              turnId: workItem.uuid,
              kind: isAck ? "ack" : "ask",
              object: glanceAskLine(job) || (job as { name?: string }).name || job.constructor.name,
              summary: job.policyMessage ?? glanceAskLine(job) ?? "",
              createdAtMs: Date.now(),
            });
          }
        }
      }
    }

    const sessionRow: Partial<NewSessionRow> = {
      sessionId: this.root.sessionId,
      ...sessionColumns(this.root),
      revision: this.#revision,
      lastActiveAtMs: Date.now(),
    };

    const patches: SessionPatchBatch["patches"] = this.#accumulatedPatches.map((item) => {
      if (item.patch.op === "splice") {
        return { ...item.patch, items: [...item.patch.items] };
      }
      return item.patch;
    });

    const patchBatch: SessionPatchBatch = {
      sessionId: this.root.sessionId,
      fromRevision: this.#lastCommittedRevision,
      toRevision: this.#revision,
      patches,
      incarnation: this.incarnation,
      createdAtMs: Date.now(),
    };

    return {
      sessionId: this.root.sessionId,
      incarnation: this.incarnation,
      fromRevision: this.#lastCommittedRevision,
      revision: this.#revision,
      rootNodeId: nodeDelta.rootId,
      upsertedNodes: nodeDelta.upserts,
      deletedNodeIds: nodeDelta.deletes,
      sessionRow,
      dirtyTurns,
      pendingAsks,
      patchBatch,
      effectRecords: this.#pendingEffectRecords.map((record) =>
        record.revision <= this.#lastCommittedRevision ? { ...record, revision: this.#revision } : record,
      ),
    };
  }

  flush(): Promise<SessionReceipt> {
    const next = this.#flushes.then(
      () => this.#flush(),
      () => this.#flush(),
    );
    this.#flushes = next.catch(() => undefined);
    return next;
  }

  async #flush(): Promise<SessionReceipt> {
    this.#assertOwned();
    let checkpoint = this.#blocked ?? this.checkpoint();
    runInAction(() => {
      this.#holds = 1;
    });
    for (;;) {
      this.#blocked = checkpoint;
      const receipt =
        this.#durability.kind === "memory"
          ? { sessionId: checkpoint.sessionId, incarnation: checkpoint.incarnation, revision: checkpoint.revision }
          : await this.#durability.commit(checkpoint);
      this.#assertOwned();
      if (!receiptCovers(receipt, checkpoint))
        throw new SessionPersistenceError("receipt does not cover session checkpoint");
      this.#lastCommittedRevision = checkpoint.revision;
      this.session.commitNodeDelta({
        revision: checkpoint.revision,
        upserts: checkpoint.upsertedNodes,
        deletes: checkpoint.deletedNodeIds,
      });
      this.#accumulatedPatches.splice(
        0,
        !this.#accumulatedPatches.some((item) => item.revision > receipt.revision)
          ? this.#accumulatedPatches.length
          : this.#accumulatedPatches.findIndex((item) => item.revision > receipt.revision),
      );
      this.#dirtyNodeIds.clear();
      for (const { patch } of this.#accumulatedPatches) this.#dirtyNodeIds.add(patch.nodeId);
      this.#pendingEffectRecords = this.#pendingEffectRecords.filter((record) => record.revision > receipt.revision);
      if (this.#revision > checkpoint.revision) {
        checkpoint = this.checkpoint();
        continue;
      }
      this.#blocked = null;
      runInAction(() => {
        this.#holds = 0;
      });
      return receipt;
    }
  }

  #recordEffect(record: Omit<NewSessionEffectRow, "id"> & { readonly id?: string }): void {
    this.#pendingEffectRecords.push({
      ...record,
      id: record.id ?? rowPairId(record.sessionId, `${record.kind}:${record.effectKey}`),
    });
  }

  commitMutation(
    operationId: string,
    input: string,
    mutate: () => void,
    signal?: AbortSignal,
  ): Promise<SessionReceipt> {
    return this.#serialize(async () => {
      this.#assertOwned();
      signal?.throwIfAborted();
      const records = this.session.getMetaMap("harness:session-commits");
      const digest = inputDigest(input);
      const previous = records.get(operationId);
      if (previous !== undefined) {
        const matches =
          typeof previous === "string" ? previous === input : commitRecordSchema.parse(previous).hash === digest;
        if (!matches) throw new Error("commit operation id was already used for different input");
        return this.flush();
      }
      while (this.#blocked !== null) {
        await this.flush();
        this.#assertOwned();
        signal?.throwIfAborted();
      }
      runInAction(() => {
        this.#holds += 1;
      });
      try {
        this.session.transact(() => {
          runInAction(mutate);
          this.session.getMetaMap("harness:session-runtime").set("version", "2");
          records.set(operationId, { format: "input-digest-v1", hash: digest });
        });
      } catch (error) {
        this.#revoke("mutation-failed");
        runInAction(() => {
          this.#holds = 0;
          this.phase = "parked";
        });
        throw error;
      }
      this.#recordEffect({
        sessionId: this.root.sessionId,
        effectKey: operationId,
        kind: "commit",
        phase: "committed",
        inputHash: digest,
        outcomeJson: JSON.stringify({ inputHash: digest }),
        revision: this.#revision,
        createdAtMs: Date.now(),
      });
      this.#blocked = this.checkpoint();
      return this.flush();
    });
  }

  admit(host: SessionCommandHost, args: Parameters<typeof admitTurn>[1], commandId?: string): Promise<TurnAdmitResult> {
    return this.#serialize(async () => {
      this.#assertHost(host);
      const input = JSON.stringify({ prompt: args.prompt, kind: args.kind ?? null, visuals: args.visuals ?? [] });
      const commands = this.session.getMetaMap("harness:session-commands");
      const previous = commandId == null ? undefined : commands.get(commandId);
      const digest = inputDigest(input);
      if (previous !== undefined) {
        const saved = commandRecordSchema.parse(typeof previous === "string" ? JSON.parse(previous) : previous);
        const matches = "inputHash" in saved ? saved.inputHash === digest : saved.input === input;
        if (!matches) throw new Error("command id was already used for different input");
        await this.flush();
        return saved.result;
      }
      while (this.#blocked !== null) {
        await this.flush();
        this.#assertHost(host);
      }
      runInAction(() => {
        this.#holds += 1;
      });
      let result: TurnAdmitResult;
      try {
        result = runInAction(() => admitTurn(host, args));
        this.session.transact(() => {
          this.session.getMetaMap("harness:session-runtime").set("version", "2");
          if (commandId != null) {
            commands.set(commandId, { format: "command-digest-v1", inputHash: digest, result });
          }
        });
        if (commandId != null) {
          this.#recordEffect({
            sessionId: this.root.sessionId,
            effectKey: commandId,
            kind: "command",
            phase: "committed",
            inputHash: digest,
            outcomeJson: JSON.stringify(result),
            revision: this.#revision,
            createdAtMs: Date.now(),
          });
        }
        this.#blocked = this.checkpoint();
        await this.flush();
        return result;
      } catch (error) {
        if (this.#blocked === null) {
          this.#revoke("command-failed");
          runInAction(() => {
            this.#holds = 0;
            this.phase = "parked";
          });
        }
        throw error;
      }
    });
  }

  compact(host: SessionCommandHost, focus = ""): Promise<CompactAdmitResult> {
    return this.#command(host, () => admitCompact(host, focus));
  }

  interrupt(operationId: string, message: string): Promise<SessionReceipt> {
    this.#assertOwned();
    if (this.phase !== "active") throw new Error("interrupt requires an active runtime");
    return this.commitMutation(`interrupt:${operationId}`, message, () => {
      for (const run of this.#runs.values()) run.abort("interrupt");
      interruptSession(this.root, message);
    });
  }

  cancel(host: SessionCommandHost, args: CancelTurnArgs): Promise<{ readonly ok: true }> {
    this.#assertHost(host);
    return this.#serialize(async () => {
      this.#assertHost(host);
      let result: { readonly ok: true };
      try {
        result = runInAction(() => {
          this.#holds += 1;
          const cancellation = cancelTurnCommand(host, args);
          const turn = [...this.#runs.keys()].find((item) =>
            "turnId" in args ? item.uuid === args.turnId : item.evalSpec?.requestId === args.requestId,
          );
          if (turn != null) this.#runs.get(turn)?.abort("cancel");
          return cancellation;
        });
        this.session.getMetaMap("harness:session-runtime").set("version", "2");
      } catch (error) {
        this.#revoke("command-failed");
        runInAction(() => {
          this.#holds = 0;
          this.phase = "parked";
        });
        throw error;
      }
      this.#blocked ??= this.checkpoint();
      await this.flush();
      return result;
    });
  }

  rewind(host: SessionCommandHost, turnId: string): Promise<RewindResult> {
    return this.#command(host, () => {
      const result = rewindTurn(host, turnId);
      if (result.ok) for (const run of this.#runs.values()) run.abort("rewind");
      return result;
    });
  }

  retry(host: SessionCommandHost): Promise<{ readonly ok: true }> {
    return this.#command(host, () => retryTurn(host));
  }

  drain(host: SessionCommandHost): Promise<void> {
    return this.#command(host, () => {
      drainPromptQueue(host);
    });
  }

  async run(turn: SessionTurn, host: TurnIteratorHost, signal?: AbortSignal): Promise<void> {
    this.#assertOwned();
    if (this.phase !== "active" || this.admissionHeld) throw new Error("session execution is not active");
    if (host.session !== this.root) throw new Error("turn host belongs to another session");
    const pending = this.#runs.get(turn);
    if (pending != null) throw new Error("turn already has an interpreter");
    const controller = new AbortController();
    this.#runs.set(turn, controller);
    const abort =
      signal == null
        ? AbortSignal.any([this.signal, controller.signal])
        : AbortSignal.any([this.signal, controller.signal, signal]);
    const loopLimits = host.loopLimits;
    const remoteMcp = host.remoteMcp;
    try {
      await iterateTurn(
        turn,
        {
          get session() {
            return host.session;
          },
          get resolvers() {
            return host.resolvers;
          },
          get notes() {
            return host.notes;
          },
          get diagnostics() {
            return host.diagnostics;
          },
          get compactKeepTurns() {
            return host.compactKeepTurns;
          },
          get hardCompactTrigger() {
            return host.hardCompactTrigger;
          },
          admit: (call) => host.admit(call),
          openRound: (resumed) => host.openRound(resumed),
          closeRound: (settle) => host.closeRound(settle),
          classifyIntent: (completion, intentSignal) => host.classifyIntent(completion, intentSignal),
          startAmbientCompact: (options) => host.startAmbientCompact(options),
          loopLimits: loopLimits == null ? undefined : (current) => loopLimits.call(host, current),
          remoteMcp: remoteMcp == null ? undefined : (key) => remoteMcp.call(host, key),
          waitInbound: async (inboundSignal) => {
            if (this.admissionHeld) await when(() => !this.admissionHeld, { signal: inboundSignal });
            this.#assertOwned();
            return host.waitInbound(inboundSignal);
          },
        },
        abort,
      );
    } finally {
      if (this.#runs.get(turn) === controller) this.#runs.delete(turn);
    }
  }

  effect(
    operationId: string,
    method: string,
    payload: string,
    port: SessionEffectPort,
    apply: (outcome: SessionEffectOutcome) => void,
    signal?: AbortSignal,
  ): Promise<SessionEffectOutcome> {
    this.#assertOwned();
    if (this.phase !== "active") return Promise.reject(new SessionOwnershipError());
    const input = JSON.stringify({ method, payload });
    const pending = this.#operations.get(operationId);
    if (pending != null) {
      if (pending.input !== input)
        return Promise.reject(new Error("effect operation id was already used for different input"));
      return pending.run;
    }
    const request: SessionEffectRequest = {
      sessionId: this.root.sessionId,
      operationId,
      incarnation: this.incarnation,
      method,
      payload,
    };
    const run = this.#effect(request, port, apply, signal);
    this.#operations.set(operationId, { input, run });
    void run
      .finally(() => {
        if (this.#operations.get(operationId)?.run === run) this.#operations.delete(operationId);
      })
      .catch(() => undefined);
    return run;
  }

  async #effect(
    request: SessionEffectRequest,
    port: SessionEffectPort,
    apply: (outcome: SessionEffectOutcome) => void,
    signal?: AbortSignal,
  ): Promise<SessionEffectOutcome> {
    const abort = signal == null ? this.signal : AbortSignal.any([this.signal, signal]);
    const records = this.session.getMetaMap("harness:session-effects");
    const raw = records.get(request.operationId);
    const saved = raw === undefined ? null : effectRecordSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    const effectInputHash = inputDigest(JSON.stringify({ method: request.method, payload: request.payload }));
    if (saved != null) {
      const matches =
        saved.request != null
          ? saved.request.method === request.method && saved.request.payload === request.payload
          : saved.inputHash === effectInputHash;
      if (!matches) {
        throw new Error("effect operation id was already used for different input");
      }
    }
    if (saved?.phase === "result") {
      await this.flush();
      return saved.outcome;
    }
    let outcome: SessionEffectOutcome;
    if (saved != null) {
      outcome =
        port.reconcile == null
          ? { kind: "unknown", message: "interrupted effect; dispatch outcome is unknown" }
          : await port.reconcile(saved.request, abort);
    } else {
      await this.commitMutation(`effect-intent:${request.operationId}`, `${request.method}\n${request.payload}`, () => {
        records.set(request.operationId, { phase: "intent", request, inputHash: effectInputHash });
        this.#recordEffect({
          sessionId: this.root.sessionId,
          effectKey: request.operationId,
          kind: "effect",
          phase: "intent",
          inputHash: effectInputHash,
          outcomeJson: JSON.stringify(request),
          revision: this.#revision,
          createdAtMs: Date.now(),
        });
      });
      this.#assertOwned();
      abort.throwIfAborted();
      outcome = await port.invoke(request, abort);
    }
    this.#assertOwned();
    abort.throwIfAborted();
    const checked = sessionEffectOutcomeSchema.parse(outcome);
    await this.commitMutation(
      `effect-result:${request.operationId}`,
      JSON.stringify(checked),
      () => {
        apply(checked);
        records.set(request.operationId, { phase: "result", request, inputHash: effectInputHash, outcome: checked });
        this.#recordEffect({
          sessionId: this.root.sessionId,
          effectKey: request.operationId,
          kind: "effect",
          phase: "result",
          inputHash: effectInputHash,
          outcomeJson: JSON.stringify(checked),
          revision: this.#revision,
          createdAtMs: Date.now(),
        });
      },
      abort,
    );
    return checked;
  }

  park(): void {
    if (this.phase === "disposed" || this.phase === "parked") return;
    this.#revoke("park");
    runInAction(() => {
      this.phase = "parked";
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.park();
    this.#ownershipController.abort("disposed");
    for (const stop of this.#stops.splice(0)) stop();
    if (bindings.get(this.session)?.incarnation === this.incarnation) bindings.delete(this.session);
    runInAction(() => {
      this.phase = "disposed";
    });
  }

  #assertHost(host: SessionCommandHost): void {
    this.#assertOwned();
    if (this.phase !== "active") throw new Error("session commands require an active runtime");
    if (host.session !== this.root) throw new Error("command host belongs to another session");
  }

  #assertOwned(): void {
    if (this.signal.aborted || bindings.get(this.session)?.incarnation !== this.incarnation) {
      throw new SessionOwnershipError();
    }
  }

  #revoke(reason: string): void {
    if (reason === "replaced" || reason === "destroyed") this.#ownershipController.abort(reason);
    this.#controller.abort(reason);
    for (const run of this.#runs.values()) run.abort(reason);
  }

  #serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#commands.then(run, run);
    this.#commands = next.catch(() => undefined);
    return next;
  }

  #command<T>(host: SessionCommandHost, apply: () => T): Promise<T> {
    return this.#serialize(async () => {
      this.#assertHost(host);
      while (this.#blocked !== null) {
        await this.flush();
        this.#assertHost(host);
      }
      runInAction(() => {
        this.#holds += 1;
      });
      let result: T;
      try {
        result = runInAction(apply);
        this.session.getMetaMap("harness:session-runtime").set("version", "2");
      } catch (error) {
        this.#revoke("command-failed");
        runInAction(() => {
          this.#holds = 0;
          this.phase = "parked";
        });
        throw error;
      }
      this.#blocked = this.checkpoint();
      await this.flush();
      return result;
    });
  }
}
