import { observable, runInAction } from "mobx";

import { ReactiveAwareness, type AwarenessShape } from "./awareness.js";
import { BrokenReferenceError } from "./errors.js";
import { getModelByTag, getModelMetadata } from "./metadata.js";
import { Model, type ModelContainerLink } from "./model.js";
import {
  collectReachableNodes,
  hydrateFromNodeRows,
  hydrateModel,
  isModelPointer,
  isSerializedDocumentNode,
  serializeModel,
  serializeNodeRow,
} from "./serialize.js";
import { CONTAINER_LINK } from "./symbols.js";
import type {
  ModelNodeDelta,
  ModelPatch,
  ModelPatchBatch,
  SerializedDocument,
  SerializedModel,
  SerializedModelRow,
} from "./types.js";

function extractNodeId(rawKey: string): string {
  if (rawKey.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(rawKey);
      if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string") {
        return parsed[1];
      }
    } catch {
      // treat as literal nodeId
    }
  }
  return rawKey;
}

function reconcileArrayInPlace(target: unknown[], next: readonly unknown[]): void {
  let start = 0;
  const minLen = Math.min(target.length, next.length);
  while (start < minLen && Object.is(target[start], next[start])) {
    start++;
  }
  if (start === target.length && start === next.length) {
    return;
  }
  let end = 0;
  while (
    end < target.length - start &&
    end < next.length - start &&
    Object.is(target[target.length - 1 - end], next[next.length - 1 - end])
  ) {
    end++;
  }
  const deleteCount = target.length - start - end;
  const insertItems = next.slice(start, next.length - end);
  target.splice(start, deleteCount, ...insertItems);
}

export class DocumentContainer<TRoot extends Model = Model, TAwareness extends AwarenessShape = AwarenessShape> {
  @observable.ref accessor root: TRoot;
  guid: string;
  readonly awareness: ReactiveAwareness<TAwareness>;
  @observable.ref accessor revision: number;
  #destroyed = false;

  readonly #registry = new Map<string, Model>();
  readonly #knownNodes = new Set<string>();
  readonly #committedNodeIds = new Set<string>();
  readonly #dirtyNodeRevisions = new Map<string, number>();
  readonly #detachedCandidates = new Set<string>();
  readonly #listeners = new Set<(batch: ModelPatchBatch) => void>();
  readonly #destroyListeners = new Set<() => void>();
  readonly #meta = new Map<string, Map<string, unknown>>();
  readonly #bufferedPatches: ModelPatch[] = [];
  #txDepth = 0;
  #metaModifiedInTx = false;
  #isApplyingPatches = false;

  constructor(
    root: TRoot,
    options?: {
      revision?: number;
      clientId?: number;
      guid?: string;
      meta?: Record<string, Record<string, unknown>>;
    },
  ) {
    this.root = root;
    this.guid = options?.guid ?? root.uuid;
    this.revision = options?.revision ?? 0;
    this.awareness = new ReactiveAwareness<TAwareness>(options?.clientId);
    this.awareness.doc = this;
    if (options?.meta) {
      for (const [ns, entries] of Object.entries(options.meta)) {
        const rawMap = new Map<string, unknown>(Object.entries(entries));
        this.#meta.set(ns, this.#wrapMetaMap(rawMap));
      }
    }
    this.registerNode(root);
    for (const id of this.#registry.keys()) {
      this.#knownNodes.add(id);
      this.#dirtyNodeRevisions.set(id, this.revision);
    }
  }

  get doc(): this {
    return this;
  }

  get clientID(): number {
    return this.awareness.clientId;
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  on(event: "destroy", listener: () => void): void {
    if (event === "destroy") {
      this.#destroyListeners.add(listener);
    }
  }

  off(event: "destroy", listener: () => void): void {
    if (event === "destroy") {
      this.#destroyListeners.delete(listener);
    }
  }

  onDestroy(listener: () => void): () => void {
    this.#destroyListeners.add(listener);
    return () => {
      this.#destroyListeners.delete(listener);
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const listener of this.#destroyListeners) {
      try {
        listener();
      } catch {
        // preserve destroy semantics
      }
    }
    this.#destroyListeners.clear();
    this.#listeners.clear();
    this.awareness.destroy();
  }

  [Symbol.dispose](): void {
    this.destroy();
  }

  static fromSnapshot<T extends Model = Model>(snapshot: SerializedDocument): DocumentContainer<any> {
    const root = hydrateModel<T>(snapshot);
    const container = new DocumentContainer<T>(root, {
      guid: snapshot.guid,
      revision: snapshot.revision,
      meta: snapshot.meta,
    });
    container.markAllNodesCommitted();
    return container;
  }

  static fromNodeRows<T extends Model = Model>(
    rows: readonly SerializedModelRow[],
    options?: {
      readonly rootId?: string;
      readonly revision?: number;
      readonly clientId?: number;
      readonly guid?: string;
      readonly meta?: Record<string, Record<string, unknown>>;
    },
  ): DocumentContainer<any> {
    const resolvedRootId = options?.rootId ?? rows[0]?.uuid;
    if (!resolvedRootId) {
      throw new BrokenReferenceError("Cannot hydrate DocumentContainer from empty node rows without rootId");
    }
    const root = hydrateFromNodeRows<T>(resolvedRootId, rows);
    const container = new DocumentContainer<T>(root, {
      guid: options?.guid,
      revision: options?.revision ?? 0,
      clientId: options?.clientId,
      meta: options?.meta,
    });
    container.markAllNodesCommitted();
    return container;
  }

  get isApplyingPatches(): boolean {
    return this.#isApplyingPatches;
  }

  getNode(uuid: string): Model | undefined {
    return this.#registry.get(uuid);
  }

  loadEntity<T extends Model = Model>(uuid: string): T | undefined {
    return this.#registry.get(uuid) as T | undefined;
  }

  getAllOfType<T extends Model>(ctor: abstract new (...args: any[]) => T): T[] {
    this.registerNode(this.root);
    const out: T[] = [];
    for (const node of this.#registry.values()) {
      if (node instanceof ctor) {
        out.push(node);
      }
    }
    return out;
  }

  get registry(): ReadonlyMap<string, Model> {
    return this.#registry;
  }

  #bindSingleNode(node: Model): void {
    const current = this.#registry.get(node.uuid);
    const currentLink = node[CONTAINER_LINK];
    if (current === node && currentLink?.container === this) {
      return;
    }

    this.#registry.set(node.uuid, node);
    if (this.#isApplyingPatches) {
      this.#knownNodes.add(node.uuid);
    } else if (!this.#committedNodeIds.has(node.uuid)) {
      this.#dirtyNodeRevisions.set(node.uuid, this.revision);
    }

    const container = this;
    const link: ModelContainerLink = {
      container: this,
      get isApplyingPatches(): boolean {
        return container.#isApplyingPatches;
      },
      awareness: this.awareness,
      recordPatch: (patch: ModelPatch) => this.recordPatch(patch),
      registerNode: (child: Model) => this.registerNode(child),
      notifyDetached: (detached: Model) => {
        if (!this.#isApplyingPatches && detached && detached.uuid) {
          this.#detachedCandidates.add(detached.uuid);
        }
      },
      serializeNode: (child: Model) => {
        this.registerNode(child);
        const graph = serializeModel(child, this.#knownNodes);
        for (const id of Object.keys(graph.nodes)) this.#knownNodes.add(id);
        return graph;
      },
      transact: <T>(fn: () => T) => this.transact(fn),
    };

    node[CONTAINER_LINK] = link;
  }

  registerNode(node: Model): void {
    if (!node || !node.uuid) return;
    const current = this.#registry.get(node.uuid);
    const currentLink = node[CONTAINER_LINK];
    if (current === node && currentLink?.container === this) {
      return;
    }

    this.#bindSingleNode(node);

    const meta = getModelMetadata(node.constructor);
    for (const field of meta.stateFields.values()) {
      const value = (node as unknown as Record<string, unknown>)[field.propertyKey];
      if (field.kind === "child" || field.kind === "ref") {
        if (value instanceof Model) {
          this.registerNode(value);
        }
      } else if (field.kind === "childList" || field.kind === "refList" || field.kind === "list") {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item instanceof Model) {
              this.registerNode(item);
            }
          }
        }
      } else if (field.kind === "childRecord") {
        if (value && typeof value === "object") {
          for (const child of Object.values(value)) {
            if (child instanceof Model) {
              this.registerNode(child);
            }
          }
        }
      }
    }
  }

  unregisterNode(node: Model): void {
    this.#registry.delete(node.uuid);
    this.#knownNodes.delete(node.uuid);
    delete node[CONTAINER_LINK];
  }

  pruneUnreachableNodes(): string[] {
    const reachable = collectReachableNodes(this.root);
    for (const node of reachable.values()) {
      this.#bindSingleNode(node);
    }
    const pruned: string[] = [];
    for (const [id, node] of [...this.#registry.entries()]) {
      if (!reachable.has(id)) {
        this.unregisterNode(node);
        this.#dirtyNodeRevisions.delete(id);
        pruned.push(id);
      }
    }
    this.#detachedCandidates.clear();
    return pruned;
  }

  markAllNodesCommitted(): void {
    this.pruneUnreachableNodes();
    this.#committedNodeIds.clear();
    for (const id of this.#registry.keys()) {
      this.#committedNodeIds.add(id);
    }
    this.#dirtyNodeRevisions.clear();
    this.#detachedCandidates.clear();
  }

  peekNodeDelta(): ModelNodeDelta {
    this.registerNode(this.root);
    if (this.#detachedCandidates.size > 0) {
      this.pruneUnreachableNodes();
    }

    const toSerialize = new Set<string>();
    for (const id of this.#dirtyNodeRevisions.keys()) {
      if (this.#registry.has(id)) {
        toSerialize.add(id);
      } else {
        this.#dirtyNodeRevisions.delete(id);
      }
    }
    for (const id of this.#registry.keys()) {
      if (!this.#committedNodeIds.has(id)) {
        toSerialize.add(id);
      }
    }

    const upserts: SerializedModelRow[] = [];
    const queue = [...toSerialize];
    const emitted = new Set<string>();

    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
      if (emitted.has(id)) continue;
      const node = this.#registry.get(id);
      if (!node) continue;
      emitted.add(id);
      const row = serializeNodeRow(node, (target) => {
        if (!this.#registry.has(target.uuid)) {
          this.registerNode(target);
        }
        if (!this.#committedNodeIds.has(target.uuid) && !emitted.has(target.uuid)) {
          queue.push(target.uuid);
        }
      });
      upserts.push(row);
    }

    const deletes: string[] = [];
    for (const committedId of this.#committedNodeIds) {
      if (!this.#registry.has(committedId)) {
        deletes.push(committedId);
      }
    }

    return {
      rootId: this.root.uuid,
      revision: this.revision,
      upserts,
      deletes,
    };
  }

  commitNodeDelta(delta: {
    readonly revision: number;
    readonly upserts: readonly { readonly uuid: string }[];
    readonly deletes: readonly string[];
  }): void {
    for (const row of delta.upserts) {
      this.#committedNodeIds.add(row.uuid);
      const dirtyRev = this.#dirtyNodeRevisions.get(row.uuid);
      if (dirtyRev !== undefined && dirtyRev <= delta.revision) {
        this.#dirtyNodeRevisions.delete(row.uuid);
      }
    }
    for (const rawId of delta.deletes) {
      const id = extractNodeId(rawId);
      this.#committedNodeIds.delete(id);
      const dirtyRev = this.#dirtyNodeRevisions.get(id);
      if (dirtyRev !== undefined && dirtyRev <= delta.revision) {
        this.#dirtyNodeRevisions.delete(id);
      }
    }
  }

  takeNodeDelta(): ModelNodeDelta {
    const delta = this.peekNodeDelta();
    this.commitNodeDelta(delta);
    return delta;
  }

  toNodeRows(): SerializedModelRow[] {
    const graph = serializeModel(this.root);
    return Object.values(graph.nodes);
  }

  applyNodeRows(delta: {
    readonly rootId?: string;
    readonly revision?: number;
    readonly upserts: readonly SerializedModelRow[];
    readonly deletes?: readonly string[];
    readonly reset?: boolean;
  }): void {
    if (
      delta.upserts.length === 0 &&
      (!delta.deletes || delta.deletes.length === 0) &&
      !delta.reset
    ) {
      if (delta.revision !== undefined) {
        runInAction(() => {
          this.revision = Math.max(this.revision, delta.revision!);
        });
      }
      return;
    }

    const upsertMap = new Map<string, SerializedModelRow>();
    for (const row of delta.upserts) {
      upsertMap.set(row.uuid, row);
    }

    const targetRootId = delta.rootId ?? this.root?.uuid;

    this.#isApplyingPatches = true;
    try {
      runInAction(() => {
        if (targetRootId && upsertMap.has(targetRootId) && this.root) {
          const rootRow = upsertMap.get(targetRootId)!;
          const currentTag = getModelMetadata(this.root.constructor).tag;
          if (currentTag === rootRow.tag) {
            if (this.root.uuid !== targetRootId) {
              this.#registry.delete(this.root.uuid);
              this.#committedNodeIds.delete(this.root.uuid);
              (this.root as { uuid: string }).uuid = targetRootId;
            }
            this.#bindSingleNode(this.root);
          }
        }

        const created = new Set<string>();
        const constructing = new Set<string>();

        const resolveNode = (id: string): Model => {
          const existing = this.#registry.get(id);
          const upsertRow = upsertMap.get(id);
          if (existing !== undefined) {
            if (upsertRow === undefined || getModelMetadata(existing.constructor).tag === upsertRow.tag) {
              return existing;
            }
            this.unregisterNode(existing);
          }
          if (upsertRow === undefined) {
            throw new BrokenReferenceError(`model graph references missing node "${id}"`);
          }
          if (constructing.has(id)) {
            throw new BrokenReferenceError(`ownership cycle at node "${id}"`);
          }
          constructing.add(id);
          const ctor = getModelByTag(upsertRow.tag);
          if (ctor === undefined) {
            throw new Error(`Unknown model tag "${upsertRow.tag}"`);
          }

          const props: Record<string, unknown> = {
            uuid: id,
            ...upsertRow.columns,
            ...upsertRow.state,
          };
          for (const [key, childId] of Object.entries(upsertRow.children)) {
            props[key] = childId === null ? null : resolveNode(childId);
          }
          for (const [key, childIds] of Object.entries(upsertRow.childLists)) {
            props[key] = childIds.map(resolveNode);
          }
          for (const [key, childRec] of Object.entries(upsertRow.childRecords)) {
            props[key] = Object.fromEntries(
              Object.entries(childRec).map(([name, childId]) => [name, resolveNode(childId)]),
            );
          }

          const meta = getModelMetadata(ctor);
          for (const [key, value] of Object.entries(upsertRow.state)) {
            if (meta.stateFields.get(key)?.kind !== "list" || !Array.isArray(value)) continue;
            props[key] = value.flatMap((item: unknown) => {
              if (isModelPointer(item)) return [];
              if (item !== null && typeof item === "object" && "$value" in item) return [item.$value];
              throw new TypeError(`Invalid list entry on "${upsertRow.tag}.${key}"`);
            });
          }

          const instance: Model = new ctor(props);
          this.#bindSingleNode(instance);
          created.add(id);
          constructing.delete(id);
          return instance;
        };

        if (targetRootId && upsertMap.has(targetRootId)) {
          const nextRoot = resolveNode(targetRootId) as TRoot;
          if (nextRoot !== this.root) {
            this.root = nextRoot;
          }
        }

        for (const id of upsertMap.keys()) {
          resolveNode(id);
        }

        for (const row of delta.upserts) {
          const instance = this.#registry.get(row.uuid);
          if (!instance) continue;
          const fields = instance as unknown as Record<string, unknown>;
          const meta = getModelMetadata(instance.constructor);

          if (created.has(row.uuid)) {
            for (const [key, values] of Object.entries(row.state)) {
              if (meta.stateFields.get(key)?.kind !== "list" || !Array.isArray(values)) continue;
              const resolvedList = values.map((item: unknown) => {
                if (isModelPointer(item)) return resolveNode(item.$model);
                if (item !== null && typeof item === "object" && "$value" in item) return item.$value;
                throw new TypeError(`Invalid list entry on "${row.tag}.${key}"`);
              });
              const targetArr = fields[key];
              if (Array.isArray(targetArr)) {
                reconcileArrayInPlace(targetArr, resolvedList);
              } else {
                fields[key] = resolvedList;
              }
            }
            for (const [key, target] of Object.entries(row.refs)) {
              fields[key] = target === null ? null : resolveNode(target);
            }
            for (const [key, targets] of Object.entries(row.refLists)) {
              const resolvedRefs = targets.map(resolveNode);
              const targetArr = fields[key];
              if (Array.isArray(targetArr)) {
                reconcileArrayInPlace(targetArr, resolvedRefs);
              } else {
                fields[key] = resolvedRefs;
              }
            }
            continue;
          }

          // Reconcile existing instance in-place
          for (const [key, col] of meta.columns.entries()) {
            if (!Object.hasOwn(row.columns, key)) continue;
            const rawVal = row.columns[key];
            const modelVal = col.codec ? col.codec.toModel(rawVal) : rawVal;
            if (!Object.is(fields[key], modelVal)) {
              fields[key] = modelVal;
            }
          }

          for (const [key, stateField] of meta.stateFields.entries()) {
            switch (stateField.kind) {
              case "scalar": {
                if (!Object.hasOwn(row.state, key)) continue;
                const nextVal = row.state[key];
                if (!Object.is(fields[key], nextVal)) {
                  fields[key] = nextVal;
                }
                break;
              }
              case "record": {
                if (!Object.hasOwn(row.state, key)) continue;
                const nextRec = row.state[key];
                const targetRec = fields[key];
                if (
                  targetRec &&
                  typeof targetRec === "object" &&
                  nextRec &&
                  typeof nextRec === "object" &&
                  !Array.isArray(nextRec)
                ) {
                  const recObj = targetRec as Record<string, unknown>;
                  const nextObj = nextRec as Record<string, unknown>;
                  for (const k of Object.keys(recObj)) {
                    if (!Object.hasOwn(nextObj, k)) {
                      delete recObj[k];
                    }
                  }
                  for (const [k, v] of Object.entries(nextObj)) {
                    if (!Object.is(recObj[k], v)) {
                      recObj[k] = v;
                    }
                  }
                } else if (nextRec && typeof nextRec === "object") {
                  fields[key] = { ...(nextRec as Record<string, unknown>) };
                }
                break;
              }
              case "list": {
                if (!Object.hasOwn(row.state, key)) continue;
                const values = row.state[key];
                if (!Array.isArray(values)) continue;
                const nextList = values.map((item: unknown) => {
                  if (isModelPointer(item)) return resolveNode(item.$model);
                  if (item !== null && typeof item === "object" && "$value" in item) return item.$value;
                  throw new TypeError(`Invalid list entry on "${row.tag}.${key}"`);
                });
                const targetArr = fields[key];
                if (Array.isArray(targetArr)) {
                  reconcileArrayInPlace(targetArr, nextList);
                } else {
                  fields[key] = nextList;
                }
                break;
              }
              case "child": {
                if (!Object.hasOwn(row.children, key)) continue;
                const childId = row.children[key];
                const nextChild = childId == null ? null : resolveNode(childId);
                if (fields[key] !== nextChild) {
                  fields[key] = nextChild;
                }
                break;
              }
              case "childList": {
                if (!Object.hasOwn(row.childLists, key)) continue;
                const childIds = row.childLists[key] ?? [];
                const nextChildren = childIds.map(resolveNode);
                const targetArr = fields[key];
                if (Array.isArray(targetArr)) {
                  reconcileArrayInPlace(targetArr, nextChildren);
                } else {
                  fields[key] = nextChildren;
                }
                break;
              }
              case "childRecord": {
                if (!Object.hasOwn(row.childRecords, key)) continue;
                const childMap = row.childRecords[key] ?? {};
                const targetRec = fields[key];
                if (targetRec && typeof targetRec === "object") {
                  const recObj = targetRec as Record<string, unknown>;
                  for (const k of Object.keys(recObj)) {
                    if (!Object.hasOwn(childMap, k)) {
                      delete recObj[k];
                    }
                  }
                  for (const [k, childId] of Object.entries(childMap)) {
                    const nextChild = resolveNode(childId);
                    if (recObj[k] !== nextChild) {
                      recObj[k] = nextChild;
                    }
                  }
                } else {
                  const built: Record<string, Model> = {};
                  for (const [k, childId] of Object.entries(childMap)) {
                    built[k] = resolveNode(childId);
                  }
                  fields[key] = built;
                }
                break;
              }
              case "ref": {
                if (!Object.hasOwn(row.refs, key)) continue;
                const refId = row.refs[key];
                const nextRef = refId == null ? null : resolveNode(refId);
                if (fields[key] !== nextRef) {
                  fields[key] = nextRef;
                }
                break;
              }
              case "refList": {
                if (!Object.hasOwn(row.refLists, key)) continue;
                const refIds = row.refLists[key] ?? [];
                const nextRefs = refIds.map(resolveNode);
                const targetArr = fields[key];
                if (Array.isArray(targetArr)) {
                  reconcileArrayInPlace(targetArr, nextRefs);
                } else {
                  fields[key] = nextRefs;
                }
                break;
              }
            }
          }
        }

        if (delta.deletes) {
          for (const rawId of delta.deletes) {
            const nodeId = extractNodeId(rawId);
            if (nodeId === this.root.uuid) continue;
            const existing = this.#registry.get(nodeId);
            if (existing) {
              this.unregisterNode(existing);
            }
            this.#committedNodeIds.delete(nodeId);
          }
        }

        this.pruneUnreachableNodes();
        this.#committedNodeIds.clear();
        for (const id of this.#registry.keys()) {
          this.#committedNodeIds.add(id);
          this.#knownNodes.add(id);
        }
        this.#dirtyNodeRevisions.clear();
        this.#detachedCandidates.clear();

        if (delta.revision !== undefined) {
          this.revision = delta.reset ? delta.revision : Math.max(this.revision, delta.revision);
        }
      });
    } finally {
      this.#isApplyingPatches = false;
    }
  }

  onPatch(listener: (batch: ModelPatchBatch) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  recordPatch(patch: ModelPatch): void {
    if (this.#isApplyingPatches) {
      return;
    }

    if (this.#txDepth > 0) {
      this.#bufferedPatches.push(patch);
      return;
    }

    this.revision++;
    this.#dirtyNodeRevisions.set(patch.nodeId, this.revision);
    const batch: ModelPatchBatch = {
      revision: this.revision,
      patches: [patch],
    };
    this.#emitBatch(batch);
  }

  #emitBatch(batch: ModelPatchBatch): void {
    for (const listener of this.#listeners) {
      listener(batch);
    }
  }

  transact<T>(fn: () => T): T {
    this.#txDepth++;
    try {
      const result = runInAction(fn);
      return result;
    } finally {
      this.#txDepth--;
      if (this.#txDepth === 0) {
        const hasPatches = this.#bufferedPatches.length > 0;
        const hasMeta = this.#metaModifiedInTx;
        if (hasPatches || hasMeta) {
          const patches = [...this.#bufferedPatches];
          this.#bufferedPatches.length = 0;
          this.#metaModifiedInTx = false;
          this.revision++;
          for (const patch of patches) {
            this.#dirtyNodeRevisions.set(patch.nodeId, this.revision);
          }
          const batch: ModelPatchBatch = {
            revision: this.revision,
            patches,
          };
          this.#emitBatch(batch);
        }
      }
    }
  }

  applyPatchBatch(batch: ModelPatchBatch): void {
    if (batch.patches.length > 0 && !batch.patches.some((patch) => this.#registry.has(patch.nodeId))) {
      return;
    }
    this.#isApplyingPatches = true;
    try {
      runInAction(() => {
        for (const patch of batch.patches) {
          this.#applySinglePatch(patch);
        }
        this.pruneUnreachableNodes();
        this.revision = batch.revision;
      });
    } finally {
      this.#isApplyingPatches = false;
    }
  }

  #listItem(value: unknown, normalized: boolean): unknown {
    if (normalized) {
      if (value !== null && typeof value === "object" && "$value" in value) return value.$value;
      if (value !== null && typeof value === "object" && "$model" in value) value = value.$model;
      else throw new TypeError("Invalid normalized list item");
    }
    if (!isSerializedDocumentNode(value)) return value;
    const child = hydrateModel<Model>(value, this.#registry);
    this.registerNode(child);
    return child;
  }

  #applySinglePatch(patch: ModelPatch): void {
    const node = this.#registry.get(patch.nodeId);
    if (!node) {
      return;
    }

    const meta = getModelMetadata(node.constructor);
    const colMeta = meta.columns.get(patch.field);
    const stateMeta = meta.stateFields.get(patch.field);

    const rec = (node as unknown as Record<string, unknown>)[patch.field];
    if (patch.op === "set") {
      if (patch.key != null) {
        if (rec && typeof rec === "object") {
          const recObj = rec as Record<string, unknown>;
          if (stateMeta?.kind === "childRecord" || isSerializedDocumentNode(patch.value)) {
            if (patch.value == null) {
              delete recObj[patch.key];
            } else {
              const child = hydrateModel<Model>(patch.value as SerializedModel, this.#registry);
              this.registerNode(child);
              recObj[patch.key] = child;
            }
          } else {
            recObj[patch.key] = patch.value;
          }
        }
        return;
      }

      switch (stateMeta?.kind) {
        case "ref": {
          const target = isSerializedDocumentNode(patch.value)
            ? hydrateModel<Model>(patch.value, this.#registry)
            : typeof patch.value === "string"
              ? (this.#registry.get(patch.value) ?? null)
              : null;
          if (target !== null) this.registerNode(target);
          (node as unknown as Record<string, unknown>)[patch.field] = target;
          break;
        }
        case "child": {
          if (patch.value == null) {
            (node as unknown as Record<string, unknown>)[patch.field] = null;
          } else {
            const child = hydrateModel<Model>(patch.value as SerializedModel, this.#registry);
            this.registerNode(child);
            (node as unknown as Record<string, unknown>)[patch.field] = child;
          }
          break;
        }
        case "childRecord": {
          if (patch.value === null || typeof patch.value !== "object")
            throw new TypeError("Child record requires an object");
          const children: Record<string, Model> = {};
          for (const [key, value] of Object.entries(patch.value)) {
            if (!isSerializedDocumentNode(value)) throw new TypeError("Child record requires model rows");
            const child = hydrateModel<Model>(value, this.#registry);
            this.registerNode(child);
            children[key] = child;
          }
          (node as unknown as Record<string, unknown>)[patch.field] = children;
          break;
        }
        case "list":
        case "childList":
        case "refList": {
          if (!Array.isArray(patch.value)) throw new TypeError(`Field "${patch.field}" requires an array`);
          const values: unknown[] = patch.value;
          const items = values.map((value) => {
            if (stateMeta.kind === "list") return this.#listItem(value, patch.encoding === "rows-v1");
            if (stateMeta.kind === "refList" && typeof value === "string") return this.#registry.get(value);
            if (!isSerializedDocumentNode(value)) return value;
            const child = hydrateModel<Model>(value, this.#registry);
            this.registerNode(child);
            return child;
          });
          (node as unknown as Record<string, unknown>)[patch.field] = items;
          break;
        }
        default: {
          if (colMeta) {
            const modelVal = colMeta.codec ? colMeta.codec.toModel(patch.value) : patch.value;
            (node as unknown as Record<string, unknown>)[patch.field] = modelVal;
          } else {
            if (isSerializedDocumentNode(patch.value)) {
              const child = hydrateModel<Model>(patch.value, this.#registry);
              this.registerNode(child);
              (node as unknown as Record<string, unknown>)[patch.field] = child;
            } else {
              (node as unknown as Record<string, unknown>)[patch.field] = patch.value;
            }
          }
        }
      }
      return;
    }

    if (patch.op === "splice") {
      const arr = (node as unknown as Record<string, unknown>)[patch.field];
      if (!Array.isArray(arr)) {
        throw new TypeError(`Field "${patch.field}" on "${patch.nodeId}" is not an array`);
      }

      let items: unknown[];
      if (stateMeta?.kind === "refList") {
        items = patch.items
          .map((value) => {
            if (isSerializedDocumentNode(value)) {
              const target = hydrateModel<Model>(value, this.#registry);
              this.registerNode(target);
              return target;
            }
            return typeof value === "string" ? this.#registry.get(value) : undefined;
          })
          .filter((target): target is Model => target !== undefined);
      } else if (stateMeta?.kind === "childList") {
        items = (patch.items as SerializedModel[]).map((snap) => {
          const child = hydrateModel<Model>(snap, this.#registry);
          this.registerNode(child);
          return child;
        });
      } else {
        items = patch.items.map((item) => this.#listItem(item, patch.encoding === "rows-v1"));
      }

      arr.splice(patch.index, patch.deleteCount, ...items);
      return;
    }

    if (patch.op === "del") {
      const targetRec = (node as unknown as Record<string, unknown>)[patch.field];
      if (targetRec && typeof targetRec === "object") {
        delete (targetRec as Record<string, unknown>)[patch.key];
      }
    }
  }

  getMetaMap(name: string): Map<string, unknown> {
    let map = this.#meta.get(name);
    if (!map) {
      map = this.#wrapMetaMap(new Map<string, unknown>());
      this.#meta.set(name, map);
    }
    return map;
  }

  setMeta(namespace: string, key: string, value: unknown): void {
    this.getMetaMap(namespace).set(key, value);
  }

  getMeta(namespace: string, key: string): unknown | undefined {
    return this.#meta.get(namespace)?.get(key);
  }

  deleteMeta(namespace: string, key: string): boolean {
    return this.getMetaMap(namespace).delete(key);
  }

  exportMeta(): Record<string, Record<string, unknown>> {
    const meta: Record<string, Record<string, unknown>> = {};
    for (const [ns, map] of this.#meta) {
      if (map.size > 0) {
        meta[ns] = Object.fromEntries(map.entries());
      }
    }
    return meta;
  }

  importMeta(meta: Record<string, Record<string, unknown>>): void {
    this.#isApplyingPatches = true;
    try {
      this.#meta.clear();
      for (const [ns, entries] of Object.entries(meta)) {
        this.#meta.set(ns, this.#wrapMetaMap(new Map(Object.entries(entries))));
      }
    } finally {
      this.#isApplyingPatches = false;
    }
  }

  #wrapMetaMap(raw: Map<string, unknown>): Map<string, unknown> {
    const container = this;
    return new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "toJSON") {
          return () => Object.fromEntries(target.entries());
        }
        if (prop === "set") {
          return (key: string, value: unknown) => {
            const prev = target.get(key);
            if (prev !== value) {
              target.set(key, value);
              container.#onMetaModified();
            }
            return receiver;
          };
        }
        if (prop === "delete") {
          return (key: string) => {
            const existed = target.delete(key);
            if (existed) {
              container.#onMetaModified();
            }
            return existed;
          };
        }
        if (prop === "clear") {
          return () => {
            if (target.size > 0) {
              target.clear();
              container.#onMetaModified();
            }
          };
        }
        const val = Reflect.get(target, prop, target);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
  }

  #onMetaModified(): void {
    if (this.#isApplyingPatches) return;
    if (this.#txDepth > 0) {
      this.#metaModifiedInTx = true;
    } else {
      this.revision++;
      const batch: ModelPatchBatch = {
        revision: this.revision,
        patches: [],
      };
      this.#emitBatch(batch);
    }
  }

  getMap<T = unknown>(name: string): Map<string, T> {
    return this.getMetaMap(name) as unknown as Map<string, T>;
  }

  hydrateFromSnapshot(snapshot: SerializedDocument): void {
    const currentTag = this.root ? getModelMetadata(this.root.constructor).tag : undefined;
    if (this.revision > snapshot.revision && currentTag === snapshot.root.tag) {
      return;
    }
    if ("nodes" in snapshot.root && snapshot.root.format === "rows-v1") {
      if (snapshot.guid) {
        this.guid = snapshot.guid;
      }
      if (snapshot.meta) {
        this.importMeta(snapshot.meta);
      }
      this.applyNodeRows({
        rootId: snapshot.root.uuid,
        revision: snapshot.revision,
        upserts: Object.values(snapshot.root.nodes),
        deletes: [],
        reset: true,
      });
      return;
    }

    this.#isApplyingPatches = true;
    try {
      runInAction(() => {
        const nextRegistry = new Map<string, Model>();
        const nextRoot = hydrateModel<TRoot>(snapshot, nextRegistry);
        this.root = nextRoot;
        this.#registry.clear();
        this.#knownNodes.clear();
        this.registerNode(nextRoot);
        this.guid = snapshot.guid ?? nextRoot.uuid;
        if (snapshot.meta) {
          this.importMeta(snapshot.meta);
        }
        this.markAllNodesCommitted();
        this.revision = Math.max(this.revision, snapshot.revision);
      });
    } finally {
      this.#isApplyingPatches = false;
    }
  }

  toSnapshot(): SerializedDocument {
    this.pruneUnreachableNodes();
    const meta = this.exportMeta();
    const graph = serializeModel(this.root);
    this.#knownNodes.clear();
    for (const id of Object.keys(graph.nodes)) this.#knownNodes.add(id);
    return {
      guid: this.guid,
      revision: this.revision,
      root: graph,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }
}
