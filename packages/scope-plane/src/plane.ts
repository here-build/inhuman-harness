import {
  emptyToNull,
  flag,
  num,
  pairId,
  ScopeCycle,
  ScopeKey,
  ScopeMissing,
  text,
  type Cell,
  type Row,
} from "./cells.js";
import type { GenerationClaim, RowMatch, RowPlane, RowReader } from "./row-plane.js";
import { configFieldNames, type ConfigField } from "./schema.js";

export type ConfigValue = string | number | boolean;

export type ConfigPatch = { readonly [Field in ConfigField]?: ConfigValue | null };

export type EffectiveConfig = { readonly [Field in ConfigField]: ConfigValue | null };

export type OverviewWrite = {
  readonly sessionId: string;
  readonly scopeId: string;
  readonly title: string;
  readonly lastMessageAt: number | null;
  readonly recipeScope: string;
  readonly specName: string;
  readonly resident: boolean;
  readonly keepAlive: boolean;
  readonly oneShot: boolean;
  readonly model: string;
  readonly status: string;
  readonly midMotion: boolean;
  readonly openTurn: boolean;
  readonly openToolCount: number;
  readonly periodArmed: boolean;
  readonly openCallbackCount: number;
  readonly asking: boolean;
  readonly unfinished: string;
  readonly lastPrompt: string;
  readonly askLine: string;
  readonly questionLine: string;
};

export type AgentCallWrite = {
  readonly callId: string;
  readonly scopeId: string;
  readonly callerSessionId: string;
  readonly workerSessionId: string;
  readonly spec: string;
  readonly oneShot: boolean;
  readonly completed: boolean;
};

export type ScopeStamp = {
  readonly trusted?: boolean;
  readonly contentHash?: string;
};

export type ScopeView = {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string | null;
  /** Root first, this scope last. */
  readonly chain: readonly string[];
  /** This scope's config generation. 0 until the first publish. */
  readonly generation: number;
  /** Content identity of all captured dependencies; neither ordered nor an ownership fence. */
  readonly revision: string;
  readonly consistency: "snapshot" | "observed";
  readonly config: EffectiveConfig;
  /** Child keys cover parent keys. */
  readonly kv: Readonly<Record<string, string>>;
  /** This scope's roster only. Names are not inherited. */
  readonly roster: Readonly<Record<string, string>>;
  readonly overviews: readonly OverviewWrite[];
  /** This scope's pane → sessionId. Not inherited. */
  readonly termContinue: Readonly<Record<string, string>>;
  /** This scope's `"connection/model"` → epoch ms. Not inherited. */
  readonly modelsUsage: Readonly<Record<string, number>>;
  /** Child connection ids cover parent ids. */
  readonly lastUsedConnectionModel: Readonly<Record<string, string>>;
  readonly trusted: boolean;
  readonly contentHash: string;
  /** This scope's caller → worker edges. Not inherited. */
  readonly agentCalls: readonly AgentCallWrite[];
};

export type ScopePlane = {
  /** Uses a storage snapshot when supported, otherwise independently observes rows. */
  read(scopeId: string): Promise<ScopeView | null>;
  /** Rejects when the adapter cannot provide an atomic read snapshot. */
  readSnapshot(scopeId: string): Promise<ScopeView | null>;
  /**
   * Emits the current view, then again after a committed change in this
   * scope or an ancestor. `null` means this scope row is absent.
   */
  watch(scopeId: string, onChange: (view: ScopeView | null) => void, onError?: (error: unknown) => void): () => void;
  ensureScope(input: {
    readonly id: string;
    readonly parentId: string | null;
    readonly path: string | null;
    readonly trusted?: boolean;
    readonly contentHash?: string;
  }): Promise<void>;
  /** Patches `trusted` and `contentHash` on an existing scope row. */
  stampScope(scopeId: string, patch: ScopeStamp): Promise<void>;
  /** Returns the new generation, or null when `expectGeneration` lost the race. */
  publishConfig(scopeId: string, expectGeneration: number, patch: ConfigPatch): Promise<number | null>;
  putKv(scopeId: string, key: string, value: string | null): Promise<void>;
  /** False when `name` already belongs to another session. */
  insertRoster(scopeId: string, name: string, sessionId: string): Promise<boolean>;
  writeOverview(glance: OverviewWrite): Promise<void>;
  /** Execution-authoritative write: false means ownership or target ownership was lost. */
  writeOverviewOwned(claim: GenerationClaim, glance: OverviewWrite): Promise<boolean>;
  /** Pass `null` to drop the pane. */
  putTermContinue(scopeId: string, key: string, sessionId: string | null): Promise<void>;
  stampModelUsage(scopeId: string, key: string, at: number): Promise<void>;
  /** Pass `null` to drop the connection. */
  putLastUsedModel(scopeId: string, connection: string, model: string | null): Promise<void>;
  writeAgentCall(call: AgentCallWrite): Promise<void>;
  removeAgentCall(callId: string): Promise<void>;
  writeAgentCallOwned(claim: GenerationClaim, call: AgentCallWrite): Promise<boolean>;
  removeAgentCallOwned(claim: GenerationClaim, callId: string): Promise<boolean>;
  /** Pass 0 to take a free session. Returns the generation now held. */
  claimGeneration(sessionId: string, scopeId: string, expectGeneration: number, holder: string): Promise<number | null>;
  takeoverGeneration(claim: GenerationClaim, nextHolder: string): Promise<number | null>;
  releaseGeneration(sessionId: string, generation: number, holder: string): Promise<boolean>;
};

const blankConfig: EffectiveConfig = {
  defaultPermissionMode: null,
  compactStrategy: null,
  autoModeClassifier: null,
  compactHard: null,
  compactSoft: null,
  compactKeepTurns: null,
  contextGlowRemaining: null,
  speculativePolicyProcessingTools: null,
  approvalAskThrottleMs: null,
  shellTailBytes: null,
  superKey: null,
  hideFloorTools: null,
  statusline: null,
  statuslineRefresh: null,
  reActLoopIntentDetectedTrigger: null,
};

function overlayConfig(rows: readonly (Row | undefined)[]): EffectiveConfig {
  const config: { [Field in ConfigField]: ConfigValue | null } = { ...blankConfig };
  for (const row of rows) {
    for (const field of configFieldNames) {
      const value = row?.[field];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") config[field] = value;
    }
  }
  return config;
}

function overlayKv(layers: readonly (readonly { row: Row }[])[]): Record<string, string> {
  return overlayPairs(layers, "key", "value");
}

function overlayPairs(
  layers: readonly (readonly { row: Row }[])[],
  keyName: string,
  valueName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const { row } of layer) {
      const key = text(row, keyName);
      const value = text(row, valueName);
      if (key != null && value != null) out[key] = value;
    }
  }
  return out;
}

function localStrings(entries: readonly { row: Row }[], keyName: string, valueName: string): Record<string, string> {
  return overlayPairs([entries], keyName, valueName);
}

function localNumbers(entries: readonly { row: Row }[], keyName: string, valueName: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { row } of entries) {
    const key = text(row, keyName);
    const value = num(row, valueName);
    if (key != null && value != null) out[key] = value;
  }
  return out;
}

function glanceOf(sessionId: string, row: Row): OverviewWrite {
  return {
    sessionId,
    scopeId: text(row, "scopeId") ?? "",
    title: text(row, "title") ?? "",
    lastMessageAt: num(row, "lastMessageAt"),
    recipeScope: text(row, "recipeScope") ?? "",
    specName: text(row, "specName") ?? "",
    resident: flag(row, "resident") ?? false,
    keepAlive: flag(row, "keepAlive") ?? false,
    oneShot: flag(row, "oneShot") ?? false,
    model: text(row, "model") ?? "",
    status: text(row, "status") ?? "",
    midMotion: flag(row, "midMotion") ?? false,
    openTurn: flag(row, "openTurn") ?? false,
    openToolCount: num(row, "openToolCount") ?? 0,
    periodArmed: flag(row, "periodArmed") ?? false,
    openCallbackCount: num(row, "openCallbackCount") ?? 0,
    asking: flag(row, "asking") ?? false,
    unfinished: text(row, "unfinished") ?? "",
    lastPrompt: text(row, "lastPrompt") ?? "",
    askLine: text(row, "askLine") ?? "",
    questionLine: text(row, "questionLine") ?? "",
  };
}

function overviewRow(glance: OverviewWrite): Row {
  const row: Record<string, Cell> = {
    scopeId: glance.scopeId,
    title: glance.title,
    recipeScope: glance.recipeScope,
    specName: glance.specName,
    resident: glance.resident,
    keepAlive: glance.keepAlive,
    oneShot: glance.oneShot,
    model: glance.model,
    status: glance.status,
    midMotion: glance.midMotion,
    openTurn: glance.openTurn,
    openToolCount: glance.openToolCount,
    periodArmed: glance.periodArmed,
    openCallbackCount: glance.openCallbackCount,
    asking: glance.asking,
    unfinished: glance.unfinished,
    lastPrompt: glance.lastPrompt,
    askLine: glance.askLine,
    questionLine: glance.questionLine,
  };
  if (glance.lastMessageAt != null) row.lastMessageAt = glance.lastMessageAt;
  return row;
}

function applyPatch(row: Row, patch: ConfigPatch): Row {
  const next: Record<string, Cell> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") next[key] = value;
  }
  for (const field of configFieldNames) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = patch[field];
    if (value == null) delete next[field];
    else next[field] = value;
  }
  return next;
}

type ChainLink = {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: string | null;
  readonly trusted: boolean;
  readonly contentHash: string;
  readonly config: Row | undefined;
  readonly kv: readonly { id: string; row: Row }[];
  readonly lastUsed: readonly { id: string; row: Row }[];
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function loadChain(rows: RowReader, scopeId: string): Promise<ChainLink[] | null> {
  const links: ChainLink[] = [];
  const seen = new Set<string>();
  let cursor: string | null = scopeId;
  while (cursor != null) {
    if (seen.has(cursor)) throw new ScopeCycle(cursor);
    seen.add(cursor);
    const scope = await rows.get("scopes", cursor);
    if (scope == null) {
      if (cursor === scopeId) return null;
      throw new ScopeMissing(cursor);
    }
    const parentId = emptyToNull(text(scope, "parentId"));
    links.push({
      id: cursor,
      parentId,
      path: emptyToNull(text(scope, "path")),
      trusted: flag(scope, "trusted") ?? false,
      contentHash: text(scope, "contentHash") ?? "",
      config: await rows.get("config", cursor),
      kv: [...(await rows.list("kv", "scopeId", cursor))].sort((a, b) => compareText(a.id, b.id)),
      lastUsed: [...(await rows.list("lastUsedModel", "scopeId", cursor))].sort((a, b) => compareText(a.id, b.id)),
    });
    cursor = parentId;
  }
  links.reverse();
  return links;
}

function stableContent(value: unknown): string {
  if (value == null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableContent).join(",")}]`;
  if (value != null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compareText(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableContent(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  throw new Error("unsupported scope revision value");
}

async function viewOf(
  rows: RowReader,
  scopeId: string,
  links: readonly ChainLink[],
  consistency: ScopeView["consistency"],
): Promise<ScopeView> {
  const self = links.at(-1);
  if (self == null) throw new ScopeMissing(scopeId);
  const roster = await rows.list("roster", "scopeId", scopeId);
  const overviews = await rows.list("overviews", "scopeId", scopeId);
  const panes = await rows.list("termContinue", "scopeId", scopeId);
  const usage = await rows.list("modelUsage", "scopeId", scopeId);
  const calls = await rows.list("agentCalls", "scopeId", scopeId);
  const names: Record<string, string> = {};
  for (const entry of roster) {
    const name = text(entry.row, "name");
    const sessionId = text(entry.row, "sessionId");
    if (name != null && sessionId != null) names[name] = sessionId;
  }
  const view = {
    id: scopeId,
    parentId: self.parentId,
    path: self.path,
    chain: links.map((link) => link.id),
    generation: num(self.config, "generation") ?? 0,
    config: overlayConfig(links.map((link) => link.config)),
    kv: overlayKv(links.map((link) => [...link.kv])),
    roster: names,
    overviews: overviews
      .map((entry) => glanceOf(entry.id, entry.row))
      .sort((left, right) => compareText(left.sessionId, right.sessionId)),
    termContinue: localStrings(panes, "key", "sessionId"),
    modelsUsage: localNumbers(usage, "key", "at"),
    lastUsedConnectionModel: overlayPairs(
      links.map((link) => [...link.lastUsed]),
      "connection",
      "model",
    ),
    trusted: self.trusted,
    contentHash: self.contentHash,
    agentCalls: calls
      .map((entry) => callOf(entry.id, entry.row))
      .sort((left, right) => compareText(left.callId, right.callId)),
  };
  return { ...view, consistency, revision: stableContent({ links, view }) };
}

function callOf(callId: string, row: Row): AgentCallWrite {
  return {
    callId,
    scopeId: text(row, "scopeId") ?? "",
    callerSessionId: text(row, "callerSessionId") ?? "",
    workerSessionId: text(row, "workerSessionId") ?? "",
    spec: text(row, "spec") ?? "",
    oneShot: flag(row, "oneShot") ?? false,
    completed: flag(row, "completed") ?? false,
  };
}

function scopeCells(
  existing: Row | undefined,
  stamp: ScopeStamp,
  parentId: string,
  path: string,
  revision: number,
): Row {
  const trusted = Object.hasOwn(stamp, "trusted") ? stamp.trusted === true : (flag(existing, "trusted") ?? false);
  const contentHash = Object.hasOwn(stamp, "contentHash")
    ? (stamp.contentHash ?? "")
    : (text(existing, "contentHash") ?? "");
  const row: Record<string, Cell> = { parentId, path, revision };
  if (trusted) row.trusted = true;
  if (contentHash !== "") row.contentHash = contentHash;
  return row;
}

/**
 * A lost `replaceIf` means another writer committed. Read again and merge
 * onto that row. `revision` is the witness: no other cell changes on every write.
 */
async function commitScope(
  rows: RowPlane,
  scopeId: string,
  stamp: ScopeStamp,
  place: { readonly parentId: string; readonly path: string } | null,
): Promise<void> {
  for (;;) {
    const existing = await rows.get("scopes", scopeId);
    if (existing == null) {
      if (place == null) throw new ScopeMissing(scopeId);
      const inserted = await rows.replaceIf(
        "scopes",
        scopeId,
        "revision",
        undefined,
        scopeCells(undefined, stamp, place.parentId, place.path, 1),
      );
      if (inserted) return;
      continue;
    }
    const revision = num(existing, "revision");
    if (revision == null) throw new Error(`scope ${scopeId} has no revision`);
    const parentId = place?.parentId ?? text(existing, "parentId") ?? "";
    const path = place?.path ?? text(existing, "path") ?? "";
    const wrote = await rows.replaceIf(
      "scopes",
      scopeId,
      "revision",
      revision,
      scopeCells(existing, stamp, parentId, path, revision + 1),
    );
    if (wrote) return;
  }
}

function subscribeChain(rows: RowPlane, scopeId: string, ids: readonly string[], poke: () => void): Array<() => void> {
  const stops: Array<() => void> = [];
  for (const id of ids) {
    const match: RowMatch = { id };
    stops.push(
      rows.watch("scopes", match, poke),
      rows.watch("config", match, poke),
      rows.watch("kv", { column: "scopeId", equals: id }, poke),
      rows.watch("roster", { column: "scopeId", equals: id }, poke),
      rows.watch("lastUsedModel", { column: "scopeId", equals: id }, poke),
    );
  }
  stops.push(
    rows.watch("overviews", { column: "scopeId", equals: scopeId }, poke),
    rows.watch("termContinue", { column: "scopeId", equals: scopeId }, poke),
    rows.watch("modelUsage", { column: "scopeId", equals: scopeId }, poke),
    rows.watch("agentCalls", { column: "scopeId", equals: scopeId }, poke),
  );
  return stops;
}

export function createScopePlane(rows: RowPlane): ScopePlane {
  async function readWith(
    reader: RowReader,
    scopeId: string,
    consistency: ScopeView["consistency"],
  ): Promise<ScopeView | null> {
    const links = await loadChain(reader, scopeId);
    if (links == null) return null;
    return viewOf(reader, scopeId, links, consistency);
  }

  async function read(scopeId: string): Promise<ScopeView | null> {
    return rows.snapshot
      ? rows.snapshot((reader) => readWith(reader, scopeId, "snapshot"))
      : readWith(rows, scopeId, "observed");
  }

  function owned(claim: GenerationClaim): NonNullable<RowPlane["commitOwned"]> {
    if (!Number.isSafeInteger(claim.generation) || claim.generation < 1 || claim.holder === "")
      throw new ScopeKey("invalid generation claim");
    if (!rows.commitOwned) throw new Error("storage does not support fenced writes");
    return rows.commitOwned.bind(rows);
  }

  return {
    read,
    async readSnapshot(scopeId) {
      if (!rows.snapshot) throw new Error("storage does not support atomic snapshots");
      return rows.snapshot((reader) => readWith(reader, scopeId, "snapshot"));
    },
    watch(scopeId, onChange, onError) {
      const gate = { closed: false };
      let stops: Array<() => void> = [];
      let chainKey = JSON.stringify([scopeId]);
      let pumping = false;
      let again = false;

      const stopSubs = (): void => {
        for (const stop of stops) stop();
        stops = [];
      };

      const fail = (error: unknown): void => {
        if (gate.closed) return;
        if (onError) onError(error);
        else throw error;
      };

      const pump = async (): Promise<void> => {
        if (gate.closed) return;
        if (pumping) {
          again = true;
          return;
        }
        pumping = true;
        try {
          do {
            again = false;
            const view = await read(scopeId);
            // Unsubscribe can flip the gate during the read. A poke during onChange sets `again`.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flags change across the await
            if (gate.closed) return;
            const ids = view == null ? [scopeId] : view.chain;
            const nextKey = JSON.stringify(ids);
            if (nextKey !== chainKey) {
              chainKey = nextKey;
              const nextStops = subscribeChain(rows, scopeId, ids, () => {
                void pump().catch(fail);
              });
              stopSubs();
              stops = nextStops;
              again = true;
              continue;
            }
            onChange(view);
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- poke during onChange sets `again`
          } while (again && !gate.closed);
        } catch (error) {
          fail(error);
        } finally {
          pumping = false;
        }
      };

      stops = subscribeChain(rows, scopeId, [scopeId], () => {
        void pump().catch(fail);
      });
      void pump().catch(fail);
      return () => {
        gate.closed = true;
        stopSubs();
      };
    },
    async ensureScope(input) {
      await commitScope(rows, input.id, input, {
        parentId: input.parentId ?? "",
        path: input.path ?? "",
      });
    },
    async stampScope(scopeId, patch) {
      await commitScope(rows, scopeId, patch, null);
    },
    async publishConfig(scopeId, expectGeneration, patch) {
      const current = await rows.get("config", scopeId);
      const generation = num(current, "generation") ?? 0;
      if (current == null) {
        if (expectGeneration !== 0) return null;
        const ok = await rows.replaceIf("config", scopeId, "generation", undefined, {
          ...applyPatch({}, patch),
          generation: 1,
        });
        return ok ? 1 : null;
      }
      if (generation !== expectGeneration) return null;
      const next = expectGeneration + 1;
      const ok = await rows.replaceIf("config", scopeId, "generation", generation, {
        ...applyPatch(current, patch),
        generation: next,
      });
      return ok ? next : null;
    },
    async putKv(scopeId, key, value) {
      const id = pairId(scopeId, key);
      if (value == null) {
        await rows.remove("kv", id);
        return;
      }
      await rows.put("kv", id, { scopeId, key, value });
    },
    async insertRoster(scopeId, name, sessionId) {
      const id = pairId(scopeId, name);
      const existing = await rows.get("roster", id);
      if (existing != null) return text(existing, "sessionId") === sessionId;
      const inserted = await rows.insertIfAbsent("roster", id, { scopeId, name, sessionId });
      if (inserted) return true;
      const after = await rows.get("roster", id);
      return text(after, "sessionId") === sessionId;
    },
    async writeOverview(glance) {
      if (glance.sessionId === "" || glance.scopeId === "") throw new ScopeKey("glance requires sessionId and scopeId");
      await rows.put("overviews", glance.sessionId, overviewRow(glance));
    },
    async writeOverviewOwned(claim, glance) {
      if (glance.sessionId !== claim.sessionId || glance.scopeId !== claim.scopeId)
        throw new ScopeKey("overview does not belong to claim");
      return owned(claim)(claim, {
        table: "overviews",
        id: glance.sessionId,
        row: overviewRow(glance),
        existing: { scopeId: claim.scopeId },
      });
    },
    async putTermContinue(scopeId, key, sessionId) {
      if (key === "") throw new ScopeKey("pane key is empty");
      const id = pairId(scopeId, key);
      if (sessionId == null || sessionId === "") {
        await rows.remove("termContinue", id);
        return;
      }
      await rows.put("termContinue", id, { scopeId, key, sessionId });
    },
    async stampModelUsage(scopeId, key, at) {
      if (key === "") throw new ScopeKey("usage key is empty");
      await rows.put("modelUsage", pairId(scopeId, key), { scopeId, key, at });
    },
    async putLastUsedModel(scopeId, connection, model) {
      if (connection === "") throw new ScopeKey("connection id is empty");
      const id = pairId(scopeId, connection);
      if (model == null || model === "") {
        await rows.remove("lastUsedModel", id);
        return;
      }
      await rows.put("lastUsedModel", id, { scopeId, connection, model });
    },
    async writeAgentCall(call) {
      if (call.callId === "" || call.scopeId === "") throw new ScopeKey("agent call requires callId and scopeId");
      await rows.put("agentCalls", call.callId, {
        scopeId: call.scopeId,
        callerSessionId: call.callerSessionId,
        workerSessionId: call.workerSessionId,
        spec: call.spec,
        oneShot: call.oneShot,
        completed: call.completed,
      });
    },
    async removeAgentCall(callId) {
      await rows.remove("agentCalls", callId);
    },
    async writeAgentCallOwned(claim, call) {
      if (call.callId === "" || call.callerSessionId !== claim.sessionId || call.scopeId !== claim.scopeId)
        throw new ScopeKey("agent call does not belong to claim");
      return owned(claim)(claim, {
        table: "agentCalls",
        id: call.callId,
        row: {
          scopeId: call.scopeId,
          callerSessionId: call.callerSessionId,
          workerSessionId: call.workerSessionId,
          spec: call.spec,
          oneShot: call.oneShot,
          completed: call.completed,
        },
        existing: { scopeId: claim.scopeId, callerSessionId: claim.sessionId },
      });
    },
    async removeAgentCallOwned(claim, callId) {
      return owned(claim)(claim, {
        table: "agentCalls",
        id: callId,
        row: null,
        existing: { scopeId: claim.scopeId, callerSessionId: claim.sessionId },
      });
    },
    async claimGeneration(sessionId, scopeId, expectGeneration, holder) {
      if (holder === "") throw new ScopeKey("holder is empty");
      const current = await rows.get("generations", sessionId);
      if (current == null) {
        if (expectGeneration !== 0) return null;
        const ok = await rows.replaceIf("generations", sessionId, "generation", undefined, {
          scopeId,
          generation: 1,
          holder,
        });
        return ok ? 1 : null;
      }
      const generation = num(current, "generation") ?? 0;
      if (!Number.isSafeInteger(generation) || generation < 1) throw new ScopeKey("invalid stored generation");
      const currentHolder = text(current, "holder") ?? "";
      if (currentHolder === "" ? expectGeneration !== 0 : generation !== expectGeneration) return null;
      const next = generation + 1;
      if (!Number.isSafeInteger(next)) throw new ScopeKey("generation exhausted");
      const ok = await rows.replaceIfMatch(
        "generations",
        sessionId,
        { generation, holder: currentHolder },
        {
          scopeId,
          generation: next,
          holder,
        },
      );
      return ok ? next : null;
    },
    async takeoverGeneration(claim, nextHolder) {
      if (nextHolder === "" || claim.holder === "" || !Number.isSafeInteger(claim.generation) || claim.generation < 1)
        throw new ScopeKey("invalid generation holder");
      const next = claim.generation + 1;
      if (!Number.isSafeInteger(next)) throw new ScopeKey("generation exhausted");
      const ok = await rows.replaceIfMatch(
        "generations",
        claim.sessionId,
        { scopeId: claim.scopeId, generation: claim.generation, holder: claim.holder },
        { scopeId: claim.scopeId, generation: next, holder: nextHolder },
      );
      return ok ? next : null;
    },
    async releaseGeneration(sessionId, generation, holder) {
      if (holder === "") return false;
      const current = await rows.get("generations", sessionId);
      if (current == null) return false;
      return rows.replaceIfMatch("generations", sessionId, { generation, holder }, { ...current, holder: "" });
    },
  };
}
