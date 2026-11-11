import { runInAction } from "mobx";

import { BrokenReferenceError } from "./errors.js";
import { getModelByTag, getModelMetadata } from "./metadata.js";
import { Model } from "./model.js";
import type { SerializedDocument, SerializedModel, SerializedModelGraph, SerializedModelRow } from "./types.js";

export function isSerializedDocumentNode(val: unknown): val is SerializedModel {
  return (
    val !== null &&
    typeof val === "object" &&
    "tag" in val &&
    typeof (val as Record<string, unknown>).tag === "string" &&
    "uuid" in val &&
    typeof (val as Record<string, unknown>).uuid === "string"
  );
}

export function isSerializedModelGraph(value: SerializedModel): value is SerializedModelGraph {
  return "format" in value && value.format === "rows-v1";
}

function isModelPointer(value: unknown): value is { readonly $model: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "$model" in value &&
    typeof value.$model === "string" &&
    Object.keys(value).length === 1
  );
}

export function serializeModel(root: Model, known?: ReadonlySet<string>): SerializedModelGraph {
  const nodes: Record<string, SerializedModelRow> = {};
  const pending = [root];
  const seen = new Set<string>();
  const pointer = (value: unknown): string => {
    if (!(value instanceof Model)) throw new TypeError("Model relationship requires a Model");
    if (!seen.has(value.uuid) && !known?.has(value.uuid)) pending.push(value);
    return value.uuid;
  };
  for (let index = 0; index < pending.length; index++) {
    const node = pending[index];
    if (node === undefined || seen.has(node.uuid) || known?.has(node.uuid)) continue;
    seen.add(node.uuid);
    const meta = getModelMetadata(node.constructor);
    const fields = node as unknown as Record<string, unknown>;
    const row: SerializedModelRow = {
      uuid: node.uuid,
      tag: meta.tag,
      columns: {},
      state: {},
      refs: {},
      refLists: {},
      children: {},
      childLists: {},
      childRecords: {},
    };
    for (const col of meta.columns.values()) {
      const value = fields[col.propertyKey];
      row.columns[col.propertyKey] = col.codec ? col.codec.toDb(value) : value;
    }
    for (const field of meta.stateFields.values()) {
      const value = fields[field.propertyKey];
      const key = field.propertyKey;
      switch (field.kind) {
        case "scalar":
          row.state[key] = value;
          break;
        case "record":
          row.state[key] = value && typeof value === "object" ? { ...value } : {};
          break;
        case "ref":
          row.refs[key] = value instanceof Model ? pointer(value) : null;
          break;
        case "refList":
          row.refLists[key] = Array.isArray(value)
            ? value.map((item: unknown) => {
                if (!(item instanceof Model)) throw new TypeError("Model reference requires a Model");
                return pointer(item);
              })
            : [];
          break;
        case "child":
          row.children[key] = value == null ? null : pointer(value);
          break;
        case "childList":
          row.childLists[key] = Array.isArray(value) ? value.map(pointer) : [];
          break;
        case "childRecord": {
          const children: Record<string, string> = {};
          if (value && typeof value === "object") {
            for (const [name, child] of Object.entries(value)) if (child != null) children[name] = pointer(child);
          }
          row.childRecords[key] = children;
          break;
        }
        case "list":
          row.state[key] = Array.isArray(value)
            ? value.map((item: unknown) => (item instanceof Model ? { $model: pointer(item) } : { $value: item }))
            : [];
          break;
      }
    }
    nodes[node.uuid] = row;
  }
  return { uuid: root.uuid, tag: getModelMetadata(root.constructor).tag, format: "rows-v1", nodes };
}

function hydrateGraph(graph: SerializedModelGraph, registry: Map<string, Model>): Model {
  const created = new Set<string>();
  const constructing = new Set<string>();
  const materialize = (id: string): Model => {
    const existing = registry.get(id);
    if (existing !== undefined) return existing;
    const row = graph.nodes[id];
    if (row === undefined) throw new BrokenReferenceError(`model graph references missing node "${id}"`);
    if (constructing.has(id)) throw new BrokenReferenceError(`ownership cycle at node "${id}"`);
    constructing.add(id);
    const ctor = getModelByTag(row.tag);
    if (ctor === undefined) throw new Error(`Unknown model tag "${row.tag}"`);
    const props: Record<string, unknown> = { uuid: id, ...row.columns, ...row.state };
    for (const [key, child] of Object.entries(row.children)) props[key] = child === null ? null : materialize(child);
    for (const [key, children] of Object.entries(row.childLists)) props[key] = children.map(materialize);
    for (const [key, children] of Object.entries(row.childRecords)) {
      props[key] = Object.fromEntries(Object.entries(children).map(([name, child]) => [name, materialize(child)]));
    }
    const meta = getModelMetadata(ctor);
    for (const [key, value] of Object.entries(row.state)) {
      if (meta.stateFields.get(key)?.kind !== "list" || !Array.isArray(value)) continue;
      props[key] = value.flatMap((item: unknown) => {
        if (isModelPointer(item)) return [];
        if (item !== null && typeof item === "object" && "$value" in item) return [item.$value];
        throw new TypeError(`Invalid list entry on "${row.tag}.${key}"`);
      });
    }
    const instance: Model = new ctor(props);
    registry.set(id, instance);
    created.add(id);
    constructing.delete(id);
    return instance;
  };
  const root = materialize(graph.uuid);
  for (const id of Object.keys(graph.nodes)) materialize(id);
  // Lists and refs can point back to their owner or across sibling rows.
  for (const id of created) {
    const row = graph.nodes[id];
    const instance = registry.get(id);
    if (row === undefined || instance === undefined) continue;
    const fields = instance as unknown as Record<string, unknown>;
    const meta = getModelMetadata(instance.constructor);
    for (const [key, values] of Object.entries(row.state)) {
      if (meta.stateFields.get(key)?.kind !== "list" || !Array.isArray(values)) continue;
      fields[key] = values.map((item: unknown) => {
        if (isModelPointer(item)) return materialize(item.$model);
        if (item !== null && typeof item === "object" && "$value" in item) return item.$value;
        throw new TypeError(`Invalid list entry on "${row.tag}.${key}"`);
      });
    }
    for (const [key, target] of Object.entries(row.refs)) fields[key] = target === null ? null : materialize(target);
    for (const [key, targets] of Object.entries(row.refLists)) fields[key] = targets.map(materialize);
  }
  return root;
}

export function serializeDocument(root: Model, revision = 0): SerializedDocument {
  return {
    revision,
    root: serializeModel(root),
  };
}

function materializeNode(node: SerializedModel, registry: Map<string, Model>): Model {
  if (isSerializedModelGraph(node)) return hydrateGraph(node, registry);
  const existing = registry.get(node.uuid);
  if (existing) {
    return existing;
  }

  const ctor = getModelByTag(node.tag);
  if (!ctor) {
    if (!node.tag) {
      return (existing ?? node) as unknown as Model;
    }
    throw new Error(`Unknown model tag "${node.tag}"`);
  }

  const props: Record<string, unknown> = {
    uuid: node.uuid,
    ...node.columns,
    ...node.state,
  };

  for (const [key, childNode] of Object.entries(node.children)) {
    props[key] = childNode ? materializeNode(childNode, registry) : null;
  }

  for (const [key, childList] of Object.entries(node.childLists)) {
    props[key] = childList.map((childNode) => materializeNode(childNode, registry));
  }

  if (node.childRecords) {
    for (const [key, rec] of Object.entries(node.childRecords)) {
      const hydratedRec: Record<string, Model> = {};
      for (const [k, childNode] of Object.entries(rec)) {
        hydratedRec[k] = materializeNode(childNode, registry);
      }
      props[key] = hydratedRec;
    }
  }

  if (node.state) {
    for (const [key, val] of Object.entries(node.state)) {
      if (Array.isArray(val)) {
        props[key] = val.map((item) => {
          if (isSerializedDocumentNode(item)) {
            return materializeNode(item, registry);
          }
          return item;
        });
      }
    }
  }

  const instance = new ctor(props) as Model;
  registry.set(instance.uuid, instance);
  return instance;
}

function linkReferences(node: SerializedModel, registry: Map<string, Model>, seen = new Set<string>()): void {
  if (isSerializedModelGraph(node)) return;
  if (seen.has(node.uuid)) return;
  seen.add(node.uuid);
  const instance = registry.get(node.uuid);
  if (!instance) {
    return;
  }

  for (const [key, refUuid] of Object.entries(node.refs)) {
    if (refUuid === null) {
      (instance as any)[key] = null;
    } else {
      const target = registry.get(refUuid);
      if (!target) {
        throw new BrokenReferenceError(`model "${node.tag}" references missing node "${refUuid}" on field "${key}"`);
      }
      (instance as any)[key] = target;
    }
  }

  for (const [key, refUuids] of Object.entries(node.refLists)) {
    const targets: Model[] = [];
    for (const refUuid of refUuids) {
      const target = registry.get(refUuid);
      if (!target) {
        throw new BrokenReferenceError(`model "${node.tag}" references missing node "${refUuid}" on field "${key}"`);
      }
      targets.push(target);
    }
    const currentList = (instance as any)[key];
    if (Array.isArray(currentList)) {
      currentList.splice(0, currentList.length, ...targets);
    } else {
      (instance as any)[key] = targets;
    }
  }

  for (const childNode of Object.values(node.children)) {
    if (childNode) {
      linkReferences(childNode, registry, seen);
    }
  }

  for (const childList of Object.values(node.childLists)) {
    for (const childNode of childList) {
      linkReferences(childNode, registry, seen);
    }
  }

  if (node.childRecords) {
    for (const rec of Object.values(node.childRecords)) {
      for (const childNode of Object.values(rec)) {
        linkReferences(childNode, registry, seen);
      }
    }
  }

  if (node.state) {
    for (const val of Object.values(node.state)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (isSerializedDocumentNode(item)) {
            linkReferences(item, registry, seen);
          }
        }
      }
    }
  }
}

export function hydrateModel<T extends Model>(
  snapshot: SerializedDocument | SerializedModel,
  existingRegistry?: Map<string, Model>,
): T {
  return runInAction(() => {
    const rootNode = "root" in snapshot ? snapshot.root : snapshot;
    const registry = existingRegistry ?? new Map<string, Model>();

    const root = materializeNode(rootNode, registry);
    linkReferences(rootNode, registry);

    return root as T;
  });
}
