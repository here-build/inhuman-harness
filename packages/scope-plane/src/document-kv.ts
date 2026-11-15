import {
  rowPairId,
  storedModelRowSchema,
  type ScopeNodeRowInsert,
  type SessionBlobRowInsert,
  type SessionEffectRow,
  type SessionEffectRowInsert,
  type SessionNodeRowInsert,
} from "@inhuman.tools/harness-contract/schema";
import type { SerializedDocument, SerializedModelRow } from "@inhuman.tools/model";

import type { BatchKeySpace, HarnessKvStore, ReadonlyKeySpace } from "./kv-store.js";

export type NodeDeltaInput = {
  readonly rootId: string;
  readonly revision: number;
  readonly upserts: readonly SerializedModelRow[];
  readonly deletes?: readonly string[];
  readonly replaceAll?: boolean;
  readonly monotonicRevision?: boolean;
};

export type LoadedNodeRows = {
  readonly rootId: string;
  readonly revision: number;
  readonly rows: SerializedModelRow[];
};

export function scopeNodeRowId(kernelId: string, scopeId: string, nodeId: string): string {
  if (nodeId.startsWith("[")) return nodeId;
  return kernelId === "local" ? rowPairId(scopeId, nodeId) : rowPairId(`${kernelId}:${scopeId}`, nodeId);
}

export function sessionNodeRowId(sessionId: string, nodeId: string): string {
  return nodeId.startsWith("[") ? nodeId : rowPairId(sessionId, nodeId);
}

export function commitScopeNodesInBatch(
  tx: BatchKeySpace,
  scopeId: string,
  delta: NodeDeltaInput,
  kernelId = "local",
): void {
  const keepIds: string[] = [];
  const upserts: ScopeNodeRowInsert[] = [];

  for (const row of delta.upserts) {
    const id = scopeNodeRowId(kernelId, scopeId, row.uuid);
    if (delta.replaceAll === true) keepIds.push(id);
    upserts.push({
      id,
      kernelId,
      scopeId,
      nodeId: row.uuid,
      tag: row.tag,
      isRoot: row.uuid === delta.rootId,
      revision: delta.revision,
      rowJson: JSON.stringify(row),
    });
  }

  if (upserts.length > 0) {
    tx.setMany("scope_nodes", upserts, delta.monotonicRevision ? { monotonicRevision: true } : undefined);
  }
  if (delta.deletes !== undefined && delta.deletes.length > 0) {
    tx.deleteMany(
      "scope_nodes",
      delta.deletes.map((rawId) => scopeNodeRowId(kernelId, scopeId, rawId)),
    );
  }
  if (delta.replaceAll === true) {
    tx.retainOnly("scope_nodes", { kernelId, scopeId }, keepIds);
  }
}

export function commitSessionNodesInBatch(
  tx: BatchKeySpace,
  sessionId: string,
  delta: NodeDeltaInput,
  kernelId = "local",
): void {
  const keepIds: string[] = [];
  const upserts: SessionNodeRowInsert[] = [];

  for (const row of delta.upserts) {
    const id = rowPairId(sessionId, row.uuid);
    if (delta.replaceAll === true) keepIds.push(id);
    upserts.push({
      id,
      kernelId,
      sessionId,
      nodeId: row.uuid,
      tag: row.tag,
      isRoot: row.uuid === delta.rootId,
      revision: delta.revision,
      rowJson: JSON.stringify(row),
    });
  }

  if (upserts.length > 0) {
    tx.setMany("session_nodes", upserts, delta.monotonicRevision ? { monotonicRevision: true } : undefined);
  }
  if (delta.deletes !== undefined && delta.deletes.length > 0) {
    tx.deleteMany(
      "session_nodes",
      delta.deletes.map((rawId) => sessionNodeRowId(sessionId, rawId)),
    );
  }
  if (delta.replaceAll === true) {
    tx.retainOnly("session_nodes", { sessionId }, keepIds);
  }
}

export function upsertSessionEffectInBatch(
  tx: BatchKeySpace,
  effect: Omit<SessionEffectRowInsert, "id"> & { readonly id?: string },
  kernelId = "local",
): void {
  const id = effect.id ?? rowPairId(effect.sessionId, `${effect.kind}:${effect.effectKey}`);
  tx.set("session_effects", {
    ...effect,
    id,
    kernelId: effect.kernelId ?? kernelId,
    phase: effect.phase ?? "committed",
  });
}

export function insertSessionBlobInBatch(
  tx: BatchKeySpace,
  blob: Omit<SessionBlobRowInsert, "id"> & { readonly id?: string },
  kernelId = "local",
): void {
  const id = blob.id ?? rowPairId(blob.sessionId, blob.blobId);
  tx.set(
    "session_blobs",
    {
      ...blob,
      id,
      kernelId: blob.kernelId ?? kernelId,
    },
    { ifAbsent: true },
  );
}

function assembleModelNodes(
  stored: readonly {
    readonly nodeId: string;
    readonly isRoot: boolean;
    readonly revision: number;
    readonly rowJson: string;
  }[],
): LoadedNodeRows | undefined {
  if (stored.length === 0) return undefined;
  let rootId: string | undefined;
  let maxRevision = 0;
  const rows: SerializedModelRow[] = [];
  for (const item of stored) {
    if (item.isRoot) rootId = item.nodeId;
    if (item.revision > maxRevision) maxRevision = item.revision;
    rows.push(storedModelRowSchema.parse(JSON.parse(item.rowJson)));
  }
  if (!rootId) {
    rootId = stored[0]!.nodeId;
  }
  return { rootId, revision: maxRevision, rows };
}

export async function loadScopeNodesFromKv(
  store: ReadonlyKeySpace,
  scopeId: string,
  kernelId = "local",
): Promise<LoadedNodeRows | undefined> {
  const stored = await store.scan("scope_nodes", {
    where: { kernelId, scopeId },
  });
  return assembleModelNodes(stored);
}

export async function loadSessionNodesFromKv(
  store: ReadonlyKeySpace,
  sessionId: string,
): Promise<LoadedNodeRows | undefined> {
  const stored = await store.scan("session_nodes", {
    where: { sessionId },
  });
  return assembleModelNodes(stored);
}

export function buildSessionRuntimeMeta(effects: readonly SessionEffectRow[]): Record<string, Record<string, unknown>> {
  if (effects.length === 0) return {};
  const commitsMap: Record<string, unknown> = {};
  const commandsMap: Record<string, unknown> = {};
  const effectsMap: Record<string, unknown> = {};

  for (const row of effects) {
    if (row.kind === "commit") {
      commitsMap[row.effectKey] = { format: "input-digest-v1", hash: row.inputHash };
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.outcomeJson);
    } catch {
      continue;
    }
    if (row.kind === "command") {
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "format" in parsed &&
        (parsed as { readonly format?: unknown }).format === "command-digest-v1"
      ) {
        commandsMap[row.effectKey] = parsed;
      } else if (
        typeof parsed === "object" &&
        parsed !== null &&
        "ok" in parsed &&
        typeof (parsed as { readonly ok?: unknown }).ok === "boolean"
      ) {
        commandsMap[row.effectKey] = {
          format: "command-digest-v1",
          inputHash: row.inputHash,
          result: parsed,
        };
      } else {
        commitsMap[row.effectKey] = { format: "input-digest-v1", hash: row.inputHash };
      }
    } else if (row.kind === "effect") {
      if (row.phase === "intent") {
        effectsMap[row.effectKey] = { phase: "intent", request: parsed, inputHash: row.inputHash };
      } else {
        effectsMap[row.effectKey] = { phase: "result", inputHash: row.inputHash, outcome: parsed };
      }
    }
  }

  const meta: Record<string, Record<string, unknown>> = {
    "harness:session-runtime": { version: "2" },
  };
  if (Object.keys(commitsMap).length > 0) meta["harness:session-commits"] = commitsMap;
  if (Object.keys(commandsMap).length > 0) meta["harness:session-commands"] = commandsMap;
  if (Object.keys(effectsMap).length > 0) meta["harness:session-effects"] = effectsMap;
  return meta;
}

export async function loadSessionRuntimeMetaFromKv(
  store: ReadonlyKeySpace,
  sessionId: string,
): Promise<Record<string, Record<string, unknown>>> {
  const effects = await store.scan("session_effects", {
    where: { sessionId },
    orderBy: [{ column: "revision", direction: "asc" }],
  });
  return buildSessionRuntimeMeta(effects);
}

export async function loadSessionDocumentFromKv(
  store: ReadonlyKeySpace,
  sessionId: string,
): Promise<SerializedDocument | undefined> {
  const loaded = await loadSessionNodesFromKv(store, sessionId);
  if (!loaded) return undefined;
  const nodes: Record<string, SerializedModelRow> = {};
  for (const row of loaded.rows) {
    nodes[row.uuid] = row;
  }
  const rootRow = nodes[loaded.rootId];
  if (!rootRow) return undefined;

  const meta = await loadSessionRuntimeMetaFromKv(store, sessionId);
  return {
    guid: `harness:session:${sessionId}`,
    revision: loaded.revision,
    root: {
      format: "rows-v1",
      uuid: loaded.rootId,
      tag: rootRow.tag,
      nodes,
    },
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

export async function storeSessionDocumentToKv(
  store: HarnessKvStore,
  sessionId: string,
  snapshot: SerializedDocument,
  nodes: readonly SerializedModelRow[],
  kernelId = "local",
): Promise<void> {
  if (!("nodes" in snapshot.root)) {
    throw new TypeError("Session persistence requires a normalized graph");
  }
  const liveNodeIds = Object.keys(snapshot.root.nodes);
  await store.batch((tx) => {
    commitSessionNodesInBatch(
      tx,
      sessionId,
      {
        rootId: snapshot.root.uuid,
        revision: snapshot.revision,
        upserts: nodes,
        deletes: [],
        replaceAll: true,
      },
      kernelId,
    );
    tx.retainOnly("session_turns", { sessionId }, liveNodeIds);
  });
}
