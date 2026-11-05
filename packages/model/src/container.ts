import { observable, runInAction } from "mobx";

import { ReactiveAwareness, type AwarenessShape } from "./awareness.js";
import { BrokenReferenceError } from "./errors.js";
import { getModelMetadata } from "./metadata.js";
import type { Model, ModelContainerLink } from "./model.js";
import { hydrateModel, serializeModel } from "./serialize.js";
import { CONTAINER_LINK } from "./symbols.js";
import type { ModelPatch, ModelPatchBatch, SerializedDocument, SerializedDocumentNode } from "./types.js";

export class DocumentContainer<
  TRoot extends Model = Model,
  TAwareness extends AwarenessShape = AwarenessShape,
> {
  readonly root: TRoot;
  readonly awareness: ReactiveAwareness<TAwareness>;
  @observable.ref accessor revision: number;
  #destroyed = false;

  readonly #registry = new Map<string, Model>();
  readonly #listeners = new Set<(batch: ModelPatchBatch) => void>();
  readonly #bufferedPatches: ModelPatch[] = [];
  #txDepth = 0;
  #isApplyingPatches = false;

  constructor(root: TRoot, options?: { revision?: number; clientId?: number }) {
    this.root = root;
    this.revision = options?.revision ?? 0;
    this.awareness = new ReactiveAwareness<TAwareness>(options?.clientId ?? 1);
    this.registerNode(root);
  }

  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#listeners.clear();
    this.awareness.clearAll();
  }

  static fromSnapshot<T extends Model = Model>(snapshot: SerializedDocument): DocumentContainer<any> {
    const root = hydrateModel<T>(snapshot);
    return new DocumentContainer<T>(root, { revision: snapshot.revision });
  }

  get isApplyingPatches(): boolean {
    return this.#isApplyingPatches;
  }

  getNode(uuid: string): Model | undefined {
    return this.#registry.get(uuid);
  }

  get registry(): ReadonlyMap<string, Model> {
    return this.#registry;
  }

  registerNode(node: Model): void {
    if (this.#registry.has(node.uuid)) {
      return;
    }

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
      if (this.#txDepth === 0 && this.#bufferedPatches.length > 0) {
        const patches = [...this.#bufferedPatches];
        this.#bufferedPatches.length = 0;
        this.revision++;
        const batch: ModelPatchBatch = {
          revision: this.revision,
          patches,
        };
        for (const listener of this.#listeners) {
          listener(batch);
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

  toSnapshot(): SerializedDocument {
    return {
      revision: this.revision,
      root: serializeModel(this.root),
    };
  }
}
