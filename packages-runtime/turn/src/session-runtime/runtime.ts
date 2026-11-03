import { SessionPlexus, SessionTurn, resolvedTip, type SessionRoot } from "@inhuman.tools/harness-model/session";
import { computed, observable, runInAction, when } from "mobx";
import * as Y from "yjs";
import { z } from "zod";

import {
  receiptCovers,
  SessionOwnershipError,
  SessionPersistenceError,
  type SessionCheckpoint,
  type SessionDurability,
  type SessionReceipt,
} from "./durability.js";
import {
  effectRecordSchema,
  sessionEffectOutcomeSchema,
  type SessionEffectOutcome,
  type SessionEffectPort,
  type SessionEffectRequest,
} from "./effects.js";
import { interruptSession } from "./interrupt.js";
import { recoverSessionJobs, type JobRecoveryOptions, type RecoveredJob } from "./recovery.js";
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

type RuntimePhase = "hydrated" | "ready" | "active" | "parked" | "disposed";

export type SessionRecoveryPolicy =
  { readonly kind: "resume" } | { readonly kind: "interrupt"; readonly message: string };

type Binding = { readonly incarnation: string; revoke(): void };
const bindings = new WeakMap<Y.Doc, Binding>();

const commandResultSchema = z.union([
  z.object({ ok: z.literal(true), action: z.enum(["noop", "mint", "steer", "queue", "continue"]) }),
  z.object({ ok: z.literal(false), reason: z.string(), invalid: z.boolean().optional() }),
]);
const commandRecordSchema = z.object({ input: z.string(), result: commandResultSchema });

export class SessionRuntime implements AsyncDisposable {
  readonly session: SessionPlexus;
  readonly incarnation = crypto.randomUUID();
  readonly #durability: SessionDurability;
  readonly #controller = new AbortController();
  readonly #ownershipController = new AbortController();
  readonly #operations = new Map<string, { readonly input: string; readonly run: Promise<SessionEffectOutcome> }>();
  readonly #runs = new Map<SessionTurn, AbortController>();
  readonly #stops: Array<() => void> = [];
  #revision = 0;
  #commands: Promise<unknown> = Promise.resolve();
  #flushes: Promise<unknown> = Promise.resolve();
  #blocked: SessionCheckpoint | null = null;
  @observable accessor phase: RuntimePhase = "hydrated";
  @observable accessor #holds = 0;

  constructor(session: SessionPlexus, durability: SessionDurability) {
    this.session = session;
    this.#durability = durability;
    if (session.doc.isDestroyed) throw new Error("cannot bind a destroyed session document");
    const version = session.doc.getMap("harness:session-runtime").get("version");
    if (version !== undefined && version !== 1) throw new Error("unsupported session runtime state version");
    const previous = bindings.get(session.doc);
    previous?.revoke();
    bindings.set(session.doc, { incarnation: this.incarnation, revoke: () => this.#revoke("replaced") });
    const update = (): void => {
      this.#revision += 1;
    };
    session.doc.on("update", update);
    this.#stops.push(() => session.doc.off("update", update));
    const destroy = (): void => this.#revoke("destroyed");
    session.doc.on("destroy", destroy);
    this.#stops.push(() => session.doc.off("destroy", destroy));
  }

  static create(sessionId: string, durability: SessionDurability, workspacePath = ""): SessionRuntime {
    return new SessionRuntime(SessionPlexus.create(sessionId, workspacePath), durability);
  }

  static restore(sessionId: string, state: Uint8Array, durability: SessionDurability): SessionRuntime {
    const doc = new Y.Doc({ guid: `harness:session:${sessionId}` });
    Y.applyUpdate(doc, state);
    const session = SessionPlexus.connect(doc, { undo: "stub" });
    if (session.root.sessionId !== sessionId) {
      session.destroy();
      throw new Error("session checkpoint identity does not match its document");
    }
    return new SessionRuntime(session, durability);
  }

  get root(): SessionRoot {
    return this.session.root;
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get isCurrent(): boolean {
    return bindings.get(this.session.doc)?.incarnation === this.incarnation && !this.session.doc.isDestroyed;
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
    return {
      sessionId: this.root.sessionId,
      incarnation: this.incarnation,
      revision: this.#revision,
      state: Y.encodeStateAsUpdate(this.session.doc),
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

  commitMutation(
    operationId: string,
    input: string,
    mutate: () => void,
    signal?: AbortSignal,
  ): Promise<SessionReceipt> {
    return this.#serialize(async () => {
      this.#assertOwned();
      signal?.throwIfAborted();
      const records = this.session.doc.getMap<string>("harness:session-commits");
      const previous = records.get(operationId);
      if (previous !== undefined) {
        if (previous !== input) throw new Error("commit operation id was already used for different input");
        return this.flush();
      }
      if (this.#blocked !== null)
        throw new SessionPersistenceError("retry the pending checkpoint before another mutation");
      runInAction(() => {
        this.#holds += 1;
      });
      try {
        this.session.doc.transact(() => {
          runInAction(mutate);
          this.session.doc.getMap("harness:session-runtime").set("version", 1);
          records.set(operationId, input);
        });
      } catch (error) {
        this.#revoke("mutation-failed");
        runInAction(() => {
          this.#holds = 0;
          this.phase = "parked";
        });
        throw error;
      }
      this.#blocked = this.checkpoint();
      return this.flush();
    });
  }

  admit(host: SessionCommandHost, args: Parameters<typeof admitTurn>[1], commandId?: string): Promise<TurnAdmitResult> {
    return this.#serialize(async () => {
      this.#assertHost(host);
      const input = JSON.stringify({ prompt: args.prompt, kind: args.kind ?? null, visuals: args.visuals ?? [] });
      const commands = this.session.doc.getMap<string>("harness:session-commands");
      const previous = commandId == null ? undefined : commands.get(commandId);
      if (previous !== undefined) {
        const saved = commandRecordSchema.parse(JSON.parse(previous));
        if (saved.input !== input) throw new Error("command id was already used for different input");
        await this.flush();
        return saved.result;
      }
      if (this.#blocked !== null)
        throw new SessionPersistenceError("retry the pending checkpoint before admitting new work");
      runInAction(() => {
        this.#holds += 1;
      });
      let result: TurnAdmitResult;
      try {
        result = runInAction(() => admitTurn(host, args));
        this.session.doc.transact(() => {
          this.session.doc.getMap("harness:session-runtime").set("version", 1);
          if (commandId != null) {
            commands.set(commandId, JSON.stringify({ input, result }));
          }
        });
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
        this.session.doc.getMap("harness:session-runtime").set("version", 1);
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
    const records = this.session.doc.getMap<string>("harness:session-effects");
    const raw = records.get(request.operationId);
    const saved = raw == null ? null : effectRecordSchema.parse(JSON.parse(raw));
    if (saved != null && (saved.request.method !== request.method || saved.request.payload !== request.payload)) {
      throw new Error("effect operation id was already used for different input");
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
        records.set(request.operationId, JSON.stringify({ phase: "intent", request }));
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
        records.set(request.operationId, JSON.stringify({ phase: "result", request, outcome: checked }));
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
    if (bindings.get(this.session.doc)?.incarnation === this.incarnation) bindings.delete(this.session.doc);
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
    if (this.signal.aborted || bindings.get(this.session.doc)?.incarnation !== this.incarnation) {
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
      if (this.#blocked !== null)
        throw new SessionPersistenceError("retry the pending checkpoint before admitting new work");
      runInAction(() => {
        this.#holds += 1;
      });
      let result: T;
      try {
        result = runInAction(apply);
        this.session.doc.getMap("harness:session-runtime").set("version", 1);
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
