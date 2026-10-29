/**
 * Durable plugin state. Project and global logs are files under the kernel
 * root. A session log lives on that session's document, so it parks,
 * restarts, and rewinds with the session. Private logs stay in memory.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionRoot } from "@inhuman.tools/harness-model";
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
        root.pluginState[sessionStateKey(owner)] = encodeLog(log);
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
