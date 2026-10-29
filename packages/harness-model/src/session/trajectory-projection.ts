/**
 * Redux time-travel on the meta layer. Metadata on trajectory nodes is
 * the action log. Pack reducers are formulas. `storageAfter` is the projection.
 */
import { ProgrammaticJob } from "./jobs/ProgrammaticJob.js";
import { ToolCallJob } from "./jobs/ToolCallJob.js";
import { EMPTY_PROJECTION_REGISTRY, projectionsOf, type PluginProjectionRegistry } from "./projection-registry.js";
import type { SessionRoot } from "./SessionRoot.js";
import { reactChunks, SessionTurn } from "./turn/session-turn.js";

/**
 * Same shape as plugin-sdk `PluginProjection`. Sdk does not import that package.
 * A `:post` round hook that wants another round emits `self/notify`.
 */
export type HostPluginProjection<S = unknown, A = unknown> = {
  readonly initial: () => S;
  readonly reduce: (state: S, action: A) => S;
  readonly hostOnly?: (action: A) => boolean;
};

type PluginMetaEnvelope = {
  readonly sealed?: boolean;
  readonly action: unknown;
};

export type PluginStorageMap = Readonly<Record<string, unknown>>;

export const EMPTY_STORAGE: PluginStorageMap = Object.freeze({});

const EMPTY_META: Readonly<Record<string, string>> = Object.freeze({});

export function writePluginMeta(
  node: ToolCallJob | ProgrammaticJob,
  pluginId: string,
  action: unknown,
  sealed = false,
): void {
  const id = pluginId.trim();
  if (id === "") return;
  node.stampPluginMeta(id, JSON.stringify(sealed ? { sealed: true, action } : { action }));
}

export function applyNodeStorage(
  prior: PluginStorageMap,
  node: unknown,
  registry: PluginProjectionRegistry = EMPTY_PROJECTION_REGISTRY,
): PluginStorageMap {
  const metas = node instanceof ToolCallJob || node instanceof ProgrammaticJob ? node.pluginMeta : EMPTY_META;
  const ids = Object.keys(metas);
  if (ids.length === 0) return prior;
  let next: Record<string, unknown> | null = null;
  for (const pluginId of ids) {
    const projection = registry.get(pluginId);
    if (projection == null) continue;
    const raw = metas[pluginId] ?? "";
    let envelope: PluginMetaEnvelope | null;
    try {
      const parsed: unknown = JSON.parse(raw === "" ? "null" : raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("action" in parsed)) {
        envelope = null;
      } else {
        envelope = { action: parsed.action, sealed: "sealed" in parsed && parsed.sealed === true };
      }
    } catch {
      envelope = null;
    }
    if (envelope == null) continue;
    if (projection.hostOnly?.(envelope.action) === true && envelope.sealed !== true) continue;
    const before = (next ?? prior)[pluginId] ?? projection.initial();
    const after = projection.reduce(before, envelope.action);
    if (after === before && next == null && Object.is((prior as Record<string, unknown>)[pluginId], before)) continue;
    next ??= { ...prior };
    next[pluginId] = after;
  }
  return next ?? prior;
}

export function applySubtreeStorage(
  prior: PluginStorageMap,
  node: unknown,
  registry: PluginProjectionRegistry = EMPTY_PROJECTION_REGISTRY,
): PluginStorageMap {
  let state = applyNodeStorage(prior, node, registry);
  if (node instanceof ProgrammaticJob) {
    for (const child of node.children) state = applySubtreeStorage(state, child, registry);
  }
  return state;
}

function containsNode(root: unknown, node: unknown): boolean {
  if (root === node) return true;
  if (!(root instanceof ProgrammaticJob)) return false;
  for (const child of root.children) {
    if (containsNode(child, node)) return true;
  }
  return false;
}

export function projectionOver(
  prior: PluginStorageMap,
  chunks: readonly unknown[],
  until: unknown | null,
  registry: PluginProjectionRegistry = EMPTY_PROJECTION_REGISTRY,
): PluginStorageMap {
  let state = prior;
  for (const chunk of chunks) {
    if (until != null && chunk === until) break;
    state = applySubtreeStorage(state, chunk, registry);
  }
  return state;
}

/** `head`'s tail ancestry, oldest first. A `turnTail` cycle starts at its oldest turn. */
function spineOldestFirst(head: SessionTurn | null): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const seen = new Set<SessionTurn>();
  for (let cell = head; cell != null && !seen.has(cell);) {
    seen.add(cell);
    turns.push(cell);
    cell = cell.turnTail instanceof SessionTurn ? cell.turnTail : null;
  }
  return turns.reverse();
}

/** Every tape from genesis through `turn`, folded oldest first. */
export function storageAfterTurn(
  turn: SessionTurn,
  registry: PluginProjectionRegistry = projectionsOf(turn),
): PluginStorageMap {
  let state: PluginStorageMap = EMPTY_STORAGE;
  for (const cell of spineOldestFirst(turn)) state = projectionOver(state, reactChunks(cell), null, registry);
  return state;
}

export function storageBefore(
  session: Pick<SessionRoot, "head">,
  node: unknown,
  registry: PluginProjectionRegistry = projectionsOf(session),
): PluginStorageMap {
  let state: PluginStorageMap = EMPTY_STORAGE;
  for (const turn of spineOldestFirst(session.head ?? null)) {
    const chunks = reactChunks(turn);
    if (chunks.includes(node as never)) return projectionOver(state, chunks, node, registry);
    for (const chunk of chunks) {
      if (chunk === node || !containsNode(chunk, node)) continue;
      let next = projectionOver(state, chunks, chunk, registry);
      next = applyNodeStorage(next, chunk, registry);
      if (chunk instanceof ProgrammaticJob) next = projectionOver(next, chunk.children, node, registry);
      return next;
    }
    state = projectionOver(state, chunks, null, registry);
  }
  return state;
}

/** Same-round admits sit on `turn.children` before they join the tape. */
export function storageIncludingOffTape(
  turn: SessionTurn,
  registry: PluginProjectionRegistry = projectionsOf(turn),
): PluginStorageMap {
  let state = turn.storageAfter;
  const onTape: readonly unknown[] = reactChunks(turn);
  for (const child of turn.children) {
    if (onTape.includes(child)) continue;
    state = applySubtreeStorage(state, child, registry);
  }
  return state;
}
