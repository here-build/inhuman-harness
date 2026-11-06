import { observable, runInAction } from "mobx";

import { ReactiveAwareness, type AwarenessShape } from "./awareness.js";
import { BrokenReferenceError } from "./errors.js";
import { getModelMetadata } from "./metadata.js";
import type { Model, ModelContainerLink } from "./model.js";
import { hydrateModel, serializeModel } from "./serialize.js";
import { CONTAINER_LINK } from "./symbols.js";
import type { ModelPatch, ModelPatchBatch, SerializedDocument, SerializedDocumentNode } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type DocumentUpdateListener = (update: Uint8Array, origin?: unknown) => void;

export class DocumentContainer<
  TRoot extends Model = Model,
  TAwareness extends AwarenessShape = AwarenessShape,
> {
  root: TRoot;
  readonly guid: string;
  readonly awareness: ReactiveAwareness<TAwareness>;
  @observable.ref accessor revision: number;
  #destroyed = false;

  readonly #registry = new Map<string, Model>();
  readonly #listeners = new Set<(batch: ModelPatchBatch) => void>();
  readonly #updateListeners = new Set<DocumentUpdateListener>();
  readonly #destroyListeners = new Set<() => void>();
  readonly #meta = new Map<string, Map<string, string>>();
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
      meta?: Record<string, Record<string, string>>;
    },
  ) {
    this.root = root;
    this.guid = options?.guid ?? root.uuid;
    this.revision = options?.revision ?? 0;
    this.awareness = new ReactiveAwareness<TAwareness>(options?.clientId);
    if (options?.meta) {
      for (const [ns, entries] of Object.entries(options.meta)) {
        const rawMap = new Map<string, string>(Object.entries(entries));
        this.#meta.set(ns, this.#wrapMetaMap(rawMap));
      }
    }
    this.registerNode(root);
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

  on(event: "update", listener: DocumentUpdateListener): void;
  on(event: "destroy", listener: () => void): void;
  on(event: "update" | "destroy", listener: DocumentUpdateListener | (() => void)): void {
    if (event === "update") {
      this.#updateListeners.add(listener as DocumentUpdateListener);
    } else {
      this.#destroyListeners.add(listener as () => void);
    }
  }

  off(event: "update", listener: DocumentUpdateListener): void;
  off(event: "destroy", listener: () => void): void;
  off(event: "update" | "destroy", listener: DocumentUpdateListener | (() => void)): void {
    if (event === "update") {
      this.#updateListeners.delete(listener as DocumentUpdateListener);
    } else {
      this.#destroyListeners.delete(listener as () => void);
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
    this.#updateListeners.clear();
    this.#listeners.clear();
    this.awareness.destroy();
  }

  static fromSnapshot<T extends Model = Model>(snapshot: SerializedDocument): DocumentContainer<any> {
    const root = hydrateModel<T>(snapshot);
    return new DocumentContainer<T>(root, { revision: snapshot.revision, meta: snapshot.meta });
  }

  get isApplyingPatches(): boolean {
    return this.#isApplyingPatches;
  }

  getNode(uuid: string): Model | undefined {
    return this.#registry.get(uuid);
  }

  loadEntity(uuid: string): Model | undefined {
    return this.#registry.get(uuid);
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

  registerNode(node: Model): void {
    const alreadyRegistered = this.#registry.has(node.uuid);
    if (!alreadyRegistered) {
      this.#registry.set(node.uuid, node);

      const link: ModelContainerLink = {
        container: this,
        isApplyingPatches: this.#isApplyingPatches,
        awareness: this.awareness,
        recordPatch: (patch: ModelPatch) => this.recordPatch(patch),
        registerNode: (child: Model) => this.registerNode(child),
        transact: <T>(fn: () => T) => this.transact(fn),
      };

      (node as any)[CONTAINER_LINK] = link;
    }

    const meta = getModelMetadata(node.constructor);
    for (const field of meta.stateFields.values()) {
      if (field.kind === "child") {
        const child = (node as any)[field.propertyKey] as Model | null;
        if (child) {
          this.registerNode(child);
        }
      } else if (field.kind === "childList") {
        const list = (node as any)[field.propertyKey] as (Model | null | undefined)[] | undefined;
        if (Array.isArray(list)) {
          for (const child of list) {
            if (child) {
              this.registerNode(child);
            }
          }
        }
      } else if (field.kind === "childRecord") {
        const rec = (node as any)[field.propertyKey] as Record<string, Model | undefined> | undefined;
        if (rec && typeof rec === "object") {
          for (const child of Object.values(rec)) {
            if (child) {
              this.registerNode(child);
            }
          }
        }
      }
    }
  }

  unregisterNode(node: Model): void {
    this.#registry.delete(node.uuid);
    delete (node as any)[CONTAINER_LINK];
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
    const batch: ModelPatchBatch = {
      revision: this.revision,
      patches: [patch],
    };
    this.#emitBatch(batch);
  }

  #emitBatch(batch: ModelPatchBatch, origin?: unknown): void {
    for (const listener of this.#listeners) {
      listener(batch);
    }
    if (this.#updateListeners.size > 0) {
      const encoded = textEncoder.encode(JSON.stringify(this.toSnapshot()));
      for (const listener of this.#updateListeners) {
        listener(encoded, origin);
      }
    }
  }

  transact<T>(fn: () => T, origin?: unknown): T {
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
          const batch: ModelPatchBatch = {
            revision: this.revision,
            patches,
          };
          this.#emitBatch(batch, origin);
        }
      }
    }
  }

  applyPatchBatch(batch: ModelPatchBatch): void {
    this.#isApplyingPatches = true;
    try {
      runInAction(() => {
        for (const patch of batch.patches) {
          this.#applySinglePatch(patch);
        }
        this.revision = batch.revision;
      });
    } finally {
      this.#isApplyingPatches = false;
    }
  }

  #applySinglePatch(patch: ModelPatch): void {
    const node = this.#registry.get(patch.nodeId);
    if (!node) {
      throw new Error(`Target node "${patch.nodeId}" not found in document container`);
    }

    const meta = getModelMetadata(node.constructor);
    const colMeta = meta.columns.get(patch.field);
    const stateMeta = meta.stateFields.get(patch.field);

    if (patch.op === "set") {
      if (patch.key != null) {
        const rec = (node as any)[patch.field];
        if (rec && typeof rec === "object") {
          if (stateMeta?.kind === "childRecord") {
            if (patch.value == null) {
              delete rec[patch.key];
            } else {
              const child = hydrateModel<Model>(patch.value as SerializedDocumentNode);
              this.registerNode(child);
              rec[patch.key] = child;
            }
          } else {
            rec[patch.key] = patch.value;
          }
        }
        return;
      }

      if (stateMeta?.kind === "ref") {
        const target = patch.value ? (this.#registry.get(patch.value as string) ?? null) : null;
        if (patch.value && !target) {
          throw new BrokenReferenceError(
            `Target node "${patch.value}" not found for ref field "${patch.field}" on "${patch.nodeId}"`,
          );
        }
        (node as any)[patch.field] = target;
      } else if (stateMeta?.kind === "child") {
        if (patch.value == null) {
          (node as any)[patch.field] = null;
        } else {
          const child = hydrateModel<Model>(patch.value as SerializedDocumentNode);
          this.registerNode(child);
          (node as any)[patch.field] = child;
        }
      } else if (colMeta) {
        const modelVal = colMeta.codec ? colMeta.codec.toModel(patch.value) : patch.value;
        (node as any)[patch.field] = modelVal;
      } else {
        (node as any)[patch.field] = patch.value;
      }
      return;
    }

    if (patch.op === "splice") {
      const arr = (node as any)[patch.field];
      if (!Array.isArray(arr)) {
        throw new TypeError(`Field "${patch.field}" on "${patch.nodeId}" is not an array`);
      }

      let items: unknown[];
      if (stateMeta?.kind === "refList") {
        items = (patch.items as (string | null)[]).map((id) => {
          if (!id) return null;
          const target = this.#registry.get(id);
          if (!target) {
            throw new BrokenReferenceError(`Missing ref node "${id}" during patch splice`);
          }
          return target;
        });
      } else if (stateMeta?.kind === "childList") {
        items = (patch.items as SerializedDocumentNode[]).map((snap) => {
          const child = hydrateModel<Model>(snap);
          this.registerNode(child);
          return child;
        });
      } else {
        items = patch.items as unknown[];
      }

      arr.splice(patch.index, patch.deleteCount, ...items);
      return;
    }

    const rec = (node as any)[patch.field];
    if (rec && typeof rec === "object") {
      delete rec[patch.key];
    }
  }

  getMetaMap(name: string): Map<string, string> {
    let map = this.#meta.get(name);
    if (!map) {
      map = this.#wrapMetaMap(new Map<string, string>());
      this.#meta.set(name, map);
    }
    return map;
  }

  setMeta(namespace: string, key: string, value: string): void {
    this.getMetaMap(namespace).set(key, value);
  }

  getMeta(namespace: string, key: string): string | undefined {
    return this.#meta.get(namespace)?.get(key);
  }

  deleteMeta(namespace: string, key: string): boolean {
    return this.getMetaMap(namespace).delete(key);
  }

  #wrapMetaMap(raw: Map<string, string>): Map<string, string> {
    const container = this;
    return new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "set") {
          return (key: string, value: string) => {
            const strVal = String(value);
            const prev = target.get(key);
            if (prev !== strVal) {
              target.set(key, strVal);
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

  getMap(name: string): Map<string, string> {
    return this.getMetaMap(name);
  }

  hydrateFromSnapshot(snapshot: SerializedDocument, origin?: unknown): void {
    this.#isApplyingPatches = true;
    try {
      runInAction(() => {
        const nextRoot = hydrateModel<TRoot>(snapshot);
        if (this.root && this.root.constructor === nextRoot.constructor) {
          const meta = getModelMetadata(this.root.constructor);
          (this.root as any).uuid = nextRoot.uuid;
          for (const col of meta.columns.keys()) {
            (this.root as any)[col] = (nextRoot as any)[col];
          }
          for (const [key, field] of meta.stateFields.entries()) {
            const val = (nextRoot as any)[key];
            if (field.kind === "list" || field.kind === "refList" || field.kind === "childList") {
              const targetArr = (this.root as any)[key];
              if (Array.isArray(targetArr) && Array.isArray(val)) {
                targetArr.splice(0, targetArr.length, ...val);
              } else {
                (this.root as any)[key] = val;
              }
            } else if (field.kind === "record" || field.kind === "childRecord") {
              const targetRec = (this.root as any)[key];
              if (targetRec && typeof targetRec === "object" && val && typeof val === "object") {
                for (const k of Object.keys(targetRec)) {
                  if (!(k in val)) delete targetRec[k];
                }
                for (const [k, v] of Object.entries(val)) {
                  targetRec[k] = v;
                }
              } else {
                (this.root as any)[key] = val;
              }
            } else {
              (this.root as any)[key] = val;
            }
          }
          this.#registry.clear();
          this.registerNode(this.root);
        } else {
          this.root = nextRoot;
          this.#registry.clear();
          this.registerNode(nextRoot);
        }
        if (snapshot.meta) {
          this.#meta.clear();
          for (const [ns, entries] of Object.entries(snapshot.meta)) {
            this.#meta.set(ns, this.#wrapMetaMap(new Map(Object.entries(entries))));
          }
        }
        this.revision = Math.max(this.revision, snapshot.revision);
      });
    } finally {
      this.#isApplyingPatches = false;
    }
    if (this.#updateListeners.size > 0) {
      const encoded = textEncoder.encode(JSON.stringify(snapshot));
      for (const listener of this.#updateListeners) {
        listener(encoded, origin);
      }
    }
  }

  encodeStateAsUpdate(): Uint8Array {
    this.registerNode(this.root);
    return textEncoder.encode(JSON.stringify(this.toSnapshot()));
  }

  encodeStateVector(): Uint8Array {
    return textEncoder.encode(JSON.stringify({ revision: this.revision }));
  }

  applyUpdate(update: Uint8Array, origin?: unknown): void {
    if (update.byteLength === 0) return;
    if (update.byteLength === 2 && update[0] === 0 && update[1] === 0) return;
    const text = textDecoder.decode(update);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if ("root" in parsed && parsed.root && typeof parsed.root === "object") {
      this.hydrateFromSnapshot(parsed as unknown as SerializedDocument, origin);
      return;
    }
    if ("patches" in parsed && Array.isArray(parsed.patches)) {
      this.applyPatchBatch(parsed as unknown as ModelPatchBatch);
      if (this.#updateListeners.size > 0) {
        for (const listener of this.#updateListeners) {
          listener(update, origin);
        }
      }
    }
  }

  toSnapshot(): SerializedDocument {
    this.registerNode(this.root);
    const meta: Record<string, Record<string, string>> = {};
    for (const [ns, map] of this.#meta) {
      if (map.size > 0) {
        meta[ns] = Object.fromEntries(map.entries());
      }
    }
    return {
      revision: this.revision,
      root: serializeModel(this.root),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
  }
}

export function encodeDocumentStateAsUpdate(doc: DocumentContainer<any, any>): Uint8Array {
  return doc.encodeStateAsUpdate();
}

export function encodeDocumentStateVector(doc: DocumentContainer<any, any>): Uint8Array {
  return doc.encodeStateVector();
}

export function applyDocumentUpdate(doc: DocumentContainer<any, any>, update: Uint8Array, origin?: unknown): void {
  doc.applyUpdate(update, origin);
}

export function mergeDocumentUpdates(updates: readonly Uint8Array[]): Uint8Array {
  const nonEmpty = updates.filter(
    (u) => u.byteLength > 0 && !(u.byteLength === 2 && u[0] === 0 && u[1] === 0),
  );
  if (nonEmpty.length === 0) return new Uint8Array([0, 0]);
  return nonEmpty[nonEmpty.length - 1]!;
}
