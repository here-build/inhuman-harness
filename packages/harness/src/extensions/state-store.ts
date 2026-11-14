/**
 * Durable plugin state. Project and global logs are files under the kernel
 * root. A session log lives on that session's document, so it parks,
 * restarts, and rewinds with the session. Private logs stay in memory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRoot } from "@inhuman.tools/harness-model";
import type { HarnessDatabase } from "@inhuman.tools/scope-plane";
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
  readonly #db: HarnessDatabase;
  readonly #kernelId: string;
  readonly #session: (sessionId: string) => SessionRoot | undefined;

  constructor(options: {
    readonly db: HarnessDatabase;
    readonly kernelId: string;
    readonly sessionRoot: (sessionId: string) => SessionRoot | undefined;
  }) {
    this.#db = options.db;
    this.#kernelId = options.kernelId;
    this.#session = options.sessionRoot;
  }

  load(owner: OwnerParts): readonly Val[] | undefined {
    if (owner.scope === "private") return undefined;
    if (owner.scope === "session") {
      const json = this.#session(owner.scopeId)?.pluginState[sessionStateKey(owner)];
      return json == null ? undefined : decodeLog(json);
    }
    const row = this.#db.getPluginStateLog(this.#rowId(owner));
    return row === undefined ? undefined : decodeLog(row.logJson);
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
    const dbScope = owner.scope === "global" ? "global" : "project";
    const dbScopeId = owner.scope === "global" ? "kernel" : owner.scopeId;
    this.#db.upsertPluginStateLog({
      id: this.#rowId(owner),
      kernelId: this.#kernelId,
      plugin: owner.plugin,
      scope: dbScope,
      scopeId: dbScopeId,
      namespace: owner.namespace,
      logJson: encoded,
      updatedAtMs: Date.now(),
    });
  }

  #rowId(owner: OwnerParts): string {
    const scopeId = owner.scope === "global" ? "kernel" : owner.scopeId;
    return [this.#kernelId, owner.plugin, owner.scope, scopeId, owner.namespace].join("\0");
  }
}
