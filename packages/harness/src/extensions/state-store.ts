/**
 * Durable plugin state. Project and global logs are files under the kernel
 * root. A session log lives on that session's document, so it parks,
 * restarts, and rewinds with the session. Private logs stay in memory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRoot } from "@inhuman.tools/harness-model";
import type { HarnessKvStore } from "@inhuman.tools/scope-plane";
import { runInAction } from "mobx";

import { jsonToVal } from "./eval.js";
import type { OwnerParts, StateStore } from "./state.js";
import { PluginSurfaceError } from "./surface-error.js";
import { toJS, type Val } from "./value.js";

/** `SessionRoot.pluginState` key. The session is the scope id. */
export function sessionStateKey(owner: { readonly plugin: string; readonly namespace: string }): string {
  return `${owner.plugin}:${owner.namespace}`;
}

export function encodeLog(log: readonly Val[]): string {
  return JSON.stringify(log.map((action) => toJS(action)));
}

export function decodeLog(json: string): Val[] {
  const raw: unknown = JSON.parse(json);
  PluginSurfaceError.invariant(Array.isArray(raw), "plugin state: a log is a JSON array");
  return raw.map((action) => jsonToVal(action));
}

export class KernelStateStore implements StateStore {
  constructor(
    private readonly kernelRoot: () => string,
    private readonly session: (sessionId: string) => SessionRoot | undefined,
  ) {}

  load(owner: OwnerParts): readonly Val[] | undefined {
    if (owner.scope === "private") return undefined;
    if (owner.scope === "session") {
      const json = this.session(owner.scopeId)?.pluginState[sessionStateKey(owner)];
      return json == null ? undefined : decodeLog(json);
    }
    let text: string;
    try {
      text = readFileSync(this.#file(owner), "utf8");
    } catch {
      return undefined;
    }
    const record = JSON.parse(text) as { log?: unknown };
    return decodeLog(JSON.stringify(record.log ?? []));
  }

  save(owner: OwnerParts, log: readonly Val[]): void {
    if (owner.scope === "private") return;
    if (owner.scope === "session") {
      const root = this.session(owner.scopeId);
      if (root == null) return;
      runInAction(() => {
        root.writePluginLog(sessionStateKey(owner), encodeLog(log));
      });
      return;
    }
    const file = this.#file(owner);
    mkdirSync(join(this.kernelRoot(), "plugin-state"), { recursive: true });
    const record = { ...owner, log: JSON.parse(encodeLog(log)) as unknown };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, file);
  }

  #file(owner: OwnerParts): string {
    const id = [owner.plugin, owner.scope, owner.scopeId, owner.namespace].join("\0");
    const name = createHash("sha256").update(id).digest("hex").slice(0, 32);
    return join(this.kernelRoot(), "plugin-state", `${name}.json`);
  }
}

/** Explicit filesystem alias of {@link KernelStateStore} for the local contour. */
export const FsStateStore = KernelStateStore;

/**
 * Multi-tenant Agent DB state store for `plugin_state_logs` (project & global scopes)
 * and `SessionRoot.pluginState` (session scope).
 */
export class DbStateStore implements StateStore {
  readonly #db: HarnessKvStore;
  readonly #kernelId: string;
  readonly #session: (sessionId: string) => SessionRoot | undefined;
  readonly #cache = new Map<string, readonly Val[]>();
  #writeQueue: Promise<void> = Promise.resolve();
  #pendingWrites = 0;

  constructor(options: {
    readonly db: HarnessKvStore;
    readonly kernelId: string;
    readonly sessionRoot: (sessionId: string) => SessionRoot | undefined;
  }) {
    this.#db = options.db;
    this.#kernelId = options.kernelId;
    this.#session = options.sessionRoot;
  }

  async warm(): Promise<void> {
    await this.flush();
    const rows = await this.#db.scan("plugin_state_logs", {
      where: { kernelId: this.#kernelId },
    });
    for (const row of rows) {
      this.#cache.set(row.id, decodeLog(row.logJson));
    }
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }

  #enqueueWrite(fn: () => Promise<unknown>): void {
    const next = this.#pendingWrites === 0 ? fn() : this.#writeQueue.then(fn);
    this.#pendingWrites += 1;
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    const cleanup = settled.finally(() => {
      this.#pendingWrites -= 1;
    });
    this.#writeQueue = cleanup;
  }

  load(owner: OwnerParts): readonly Val[] | undefined {
    if (owner.scope === "private") return undefined;
    if (owner.scope === "session") {
      const json = this.#session(owner.scopeId)?.pluginState[sessionStateKey(owner)];
      return json == null ? undefined : decodeLog(json);
    }
    return this.#cache.get(this.#rowId(owner));
  }

  save(owner: OwnerParts, log: readonly Val[]): void {
    if (owner.scope === "private") return;
    const encoded = encodeLog(log);
    if (owner.scope === "session") {
      const root = this.#session(owner.scopeId);
      if (root == null) return;
      runInAction(() => {
        root.writePluginLog(sessionStateKey(owner), encoded);
      });
      return;
    }
    const id = this.#rowId(owner);
    this.#cache.set(id, decodeLog(encoded));
    const dbScope = owner.scope === "global" ? "global" : "project";
    const dbScopeId = owner.scope === "global" ? "kernel" : owner.scopeId;
    this.#enqueueWrite(() =>
      this.#db.set("plugin_state_logs", {
        id,
        kernelId: this.#kernelId,
        plugin: owner.plugin,
        scope: dbScope,
        scopeId: dbScopeId,
        namespace: owner.namespace,
        logJson: encoded,
        updatedAtMs: Date.now(),
      }),
    );
  }

  #rowId(owner: OwnerParts): string {
    const scopeId = owner.scope === "global" ? "kernel" : owner.scopeId;
    return JSON.stringify([this.#kernelId, owner.plugin, owner.scope, scopeId, owner.namespace]);
  }
}
