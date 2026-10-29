import { decodeLog, sessionStateKey } from "./state-store.js";
import type { StateDirectory } from "./state.js";

type TrajectoryUnit = {
  readonly pluginState?: unknown;
  readonly pluginStateJson?: unknown;
  readonly turnTail?: unknown;
};

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return undefined;
    out[key] = item;
  }
  return out;
}

/**
 * Session plugin logs recorded on the nearest ended turn. Empty when the
 * trajectory has no snapshot yet. Project and global state do not move.
 * A live turn's `pluginState` face wins over its JSON string.
 */
export function pluginStateSnapshotFromHead(head: unknown): Record<string, string> {
  let unit: unknown = head;
  while (unit != null && typeof unit === "object") {
    const row = unit as TrajectoryUnit;
    if ("pluginState" in row) {
      if (row.pluginState != null) {
        const face = stringRecord(row.pluginState);
        if (face !== undefined) return face;
      }
    } else if (typeof row.pluginStateJson === "string" && row.pluginStateJson !== "") {
      try {
        const face = stringRecord(JSON.parse(row.pluginStateJson));
        if (face !== undefined) return face;
      } catch {
        /* a broken snapshot is not a restore point */
      }
    }
    unit = row.turnTail;
  }
  return {};
}

/**
 * Replace live session pluginState and replay the same logs in the directory.
 * Caller owns document-action wrapping (`runInAction`).
 */
export function restoreSessionPluginState(opts: {
  readonly directory: StateDirectory;
  readonly sessionId: string;
  readonly live: Record<string, string>;
  readonly snapshot: Record<string, string>;
}): void {
  const { live, snapshot, directory, sessionId } = opts;
  for (const key of Object.keys(live)) {
    if (!(key in snapshot)) delete live[key];
  }
  for (const [key, json] of Object.entries(snapshot)) {
    if (live[key] !== json) live[key] = json;
  }
  for (const id of directory.sessionOwners(sessionId)) {
    const key = sessionStateKey(directory.parts(id));
    directory.reset(id, Object.hasOwn(snapshot, key) ? decodeLog(snapshot[key]!) : []);
  }
}
