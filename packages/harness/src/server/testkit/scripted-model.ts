/**
 * Test model. The session asks `c1` through the normal completion port.
 * Each `reply` is one round: text, tool calls, or a crash.
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ResponseCall } from "@inhuman.tools/harness-model";
import type { CompleteResult, ConnectionCompleteRequest } from "@inhuman.tools/harness-provider-sdk";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { PEWDriver, type ExpectationActor } from "@inhuman.tools/plexus-expectations/driver";
import { normalizeMessage } from "@inhuman.tools/tool-call-normalize";
import { reaction } from "mobx";

import type { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { responseCallsFromToolCalls, toolCallFromResponse } from "../util/tool-call-json.js";

/**
 * Config reflection drops connections that are not in `config.json`.
 * A `__prv_` id is kept, so a reload cannot pull the scripted row out
 * from under a later round.
 */
export function scriptedConnectionId(connectionId = "c1"): string {
  return connectionId.startsWith("__prv_") ? connectionId : `__prv_${connectionId}`;
}

export type ModelReply = {
  readonly text?: string;
  readonly calls?: readonly ResponseCall[];
  readonly thought?: string;
  readonly finishReason?: string;
  readonly usage?: { readonly totalTokens: number; readonly contextLimit: number };
  /** Hold an owned provider reply to exercise live cancellation and input races. */
  readonly gate?: Promise<void>;
  /** Simulate a provider that does not cooperate with cancellation. */
  readonly ignoreAbort?: boolean;
  /** Fail the round. The loop sees a crashed completion, not a hang. */
  readonly fail?: string;
};

export type ModelScript = {
  reply(reply: ModelReply): void;
  /** Explicit judge replies exercise the real assessor through the provider port. */
  judge(reply: ModelReply): void;
};

const queues = new Map<string, ReplyQueue>();
const judges = new Map<string, ReplyQueue>();
const attached = new WeakMap<object, ModelScript>();

class ReplyQueue {
  readonly #pending: ModelReply[] = [];
  get pending(): boolean {
    return this.#pending.length > 0;
  }
  readonly #waiters: Array<(reply: ModelReply) => void> = [];

  reply(reply: ModelReply): void {
    const waiter = this.#waiters.shift();
    if (waiter != null) waiter(reply);
    else this.#pending.push(reply);
  }

  take(signal?: AbortSignal): Promise<ModelReply> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    const queued = this.#pending.shift();
    if (queued != null) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const finish = (reply: ModelReply): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(reply);
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(finish);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      this.#waiters.push(finish);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export class ScriptedCompletionConnection extends PEWDriver {
  readonly #queue: ReplyQueue;
  readonly #judge: ReplyQueue;

  constructor(connectionId: string, settings: unknown, secrets?: ConstructorParameters<typeof PEWDriver>[2]) {
    super(connectionId, settings, secrets);
    const scriptId = this.settings.scriptId;
    const queue = typeof scriptId === "string" ? queues.get(scriptId) : undefined;
    if (queue == null) throw new Error("scripted model: missing queue");
    this.#queue = queue;
    this.#judge = judges.get(scriptId as string)!;
  }

  override async bootstrap(): Promise<void> {}

  protected override resolve(): ExpectationActor<never> {
    throw new Error("scripted model does not honor expectations");
  }

  async complete(req: ConnectionCompleteRequest): Promise<CompleteResult> {
    // Ambient compact and an unstubbed judge share this connection. They must
    // not take the actor's next reply.
    if (req.round.completionMode === "isolated" && (req.responseSchemaJson == null || !this.#judge.pending)) {
      const text = req.responseSchemaJson == null ? "" : JSON.stringify({ intent: false, awaiting_user: false });
      req.round.stampAnswer({ calls: [], text });
      req.round.succeed("settled", "", "null", { result: { text } });
      return { text };
    }
    const reply = await (req.round.completionMode === "isolated" ? this.#judge : this.#queue).take(req.signal);
    if (reply.gate != null && reply.ignoreAbort) await reply.gate;
    else if (reply.gate != null) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => reject(req.signal?.reason ?? new Error("aborted"));
        if (req.signal?.aborted) return onAbort();
        req.signal?.addEventListener("abort", onAbort, { once: true });
        void reply.gate!.then(
          () => {
            req.signal?.removeEventListener("abort", onAbort);
            resolve();
            return null;
          },
          (error: unknown) => {
            req.signal?.removeEventListener("abort", onAbort);
            reject(error);
            return null;
          },
        );
      });
    }
    if (reply.usage != null) Object.assign(req.round, reply.usage);
    req.round.finishReason = reply.finishReason ?? "";
    if (reply.fail != null) {
      req.round.failReason = reply.fail;
      req.round.fail("crash", reply.fail, "null");
      return { text: "" };
    }
    // The provider actor normalizes once, at the producer. The loop admits what is stored.
    const normalized = normalizeMessage({
      content: reply.text ?? "",
      tool_calls: (reply.calls ?? []).map(toolCallFromResponse),
      reasoning_content: reply.thought || null,
    });
    const text = normalized.content ?? "";
    const thought = normalized.reasoning_content ?? "";
    req.round.stampAnswer({
      calls: [
        ...responseCallsFromToolCalls(normalized.tool_calls).filter(
          (call) => !(reply.calls ?? []).some((raw) => raw.toolCallId === call.toolCallId && raw.dropReason !== ""),
        ),
        ...(reply.calls ?? []).filter((call) => call.dropReason !== ""),
      ],
      text,
      ...(thought !== "" ? { thought } : {}),
    });
    req.round.succeed("settled", "", "null", { result: { text } });
    return { text, ...(thought !== "" ? { thought } : {}) };
  }
}

/** Register `connectionId` on the kernel. Replies are delivered by `complete()`. */
export function installScriptedModel(kernel: KernelDaemon, connectionId = "c1"): ModelScript {
  const id = scriptedConnectionId(connectionId);
  const scriptId = randomUUID();
  const queue = new ReplyQueue();
  queues.set(scriptId, queue);
  const judge = new ReplyQueue();
  judges.set(scriptId, judge);
  const driver = new DriverSpec({
    name: "scripted",
    description: "scripted test model",
    importPath: "scripted",
    abilityClaim: ["completion"],
    multiplicity: "add-by-default",
  });
  const connection = new ConnectionSpec({ driver, name: id });
  connection.configuration = { scriptId };
  const root = kernel.plexus.root;
  const keep = (): void => {
    if (root.drivers.scripted !== driver) root.drivers = { ...root.drivers, scripted: driver };
    if (root.connections[id] !== connection) root.connections = { ...root.connections, [id]: connection };
  };
  keep();
  const stopKeep = reaction(
    () => root.drivers.scripted !== driver || root.connections[id] !== connection,
    (missing) => {
      if (missing) keep();
    },
  );
  const priorDispose = kernel[Symbol.dispose].bind(kernel);
  kernel[Symbol.dispose] = () => {
    stopKeep();
    queues.delete(scriptId);
    judges.delete(scriptId);
    priorDispose();
  };
  const runtime = kernel.runtime;
  const load = runtime.loadDriver.bind(runtime);
  runtime.loadDriver = (spec, purpose) =>
    spec.name === "scripted" ? ScriptedCompletionConnection : load(spec, purpose);
  return {
    reply(reply) {
      queue.reply(reply);
    },
    judge(reply) {
      judge.reply(reply);
    },
  };
}

/** Install `connectionId` and remember the script on `session`. */
export function attachScriptedModel(kernel: KernelDaemon, session: object, connectionId = "c1"): ModelScript {
  const model = installScriptedModel(kernel, connectionId);
  attached.set(session, model);
  return model;
}

export function modelOf(session: object): ModelScript {
  const model = attached.get(session);
  if (model == null) throw new Error("scripted model missing");
  return model;
}

/**
 * Point the kernel's compaction at the keep-first program. Integration tests
 * that script the loop have no summarizer model to answer the shipped
 * strategy; keep-first is the deterministic stand-in. (In the product it is
 * only the failsafe.)
 */
export function useKeepFirstCompact(kernel: KernelDaemon, kernelRoot: string): void {
  const path = join(kernelRoot, "keep-first.scm");
  writeFileSync(
    path,
    "(define (compact compact-transcript full-transcript)\n  (let ((xs (transcript/cells compact-transcript)))\n    (if (null? xs) xs (list (car xs)))))\n",
  );
  kernel.adjustConfig((config) => {
    config.compact = path;
  });
}
