import { BrokenReferenceError } from "./errors.js";
import { getModelByTag, getModelMetadata } from "./metadata.js";
import type { Model } from "./model.js";
import type { SerializedDocument, SerializedDocumentNode } from "./types.js";

export function serializeModel(root: Model): SerializedDocumentNode {
  const ctor = root.constructor;
  const meta = getModelMetadata(ctor);

  const columns: Record<string, unknown> = {};
  for (const col of meta.columns.values()) {
    const val = (root as any)[col.propertyKey];
    columns[col.propertyKey] = col.codec ? col.codec.toDb(val) : val;
  }

  const state: Record<string, unknown> = {};
  const refs: Record<string, string | null> = {};
  const refLists: Record<string, string[]> = {};
  const children: Record<string, SerializedDocumentNode | null> = {};
  const childLists: Record<string, SerializedDocumentNode[]> = {};

  for (const field of meta.stateFields.values()) {
    const val = (root as any)[field.propertyKey];
    switch (field.kind) {
      case "scalar":
        state[field.propertyKey] = val;
        break;
      case "ref":
        refs[field.propertyKey] = (val as Model | null)?.uuid ?? null;
        break;
      case "child":
        children[field.propertyKey] = val ? serializeModel(val as Model) : null;
        break;
      case "list":
        state[field.propertyKey] = Array.isArray(val) ? [...val] : [];
        break;
      case "refList":
        refLists[field.propertyKey] = Array.isArray(val)
          ? (val as (Model | null)[]).map((m) => m?.uuid).filter((id): id is string => typeof id === "string")
          : [];
        break;
      case "childList":
        childLists[field.propertyKey] = Array.isArray(val) ? val.map((m: Model) => serializeModel(m)) : [];
        break;
      case "record":
        state[field.propertyKey] = val && typeof val === "object" ? { ...val } : {};
        break;
    }
  }

  return {
    uuid: root.uuid,
    tag: meta.tag,
    columns,
    state,
    refs,
    refLists,
    children,
    childLists,
  };
}

export function serializeDocument(root: Model, revision = 0): SerializedDocument {
  return {
    revision,
    root: serializeModel(root),
  };
}

function materializeNode(node: SerializedDocumentNode, registry: Map<string, Model>): Model {
  const ctor = getModelByTag(node.tag);
  if (!ctor) {
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

  const instance = new ctor(props) as Model;
  registry.set(instance.uuid, instance);
  return instance;
}

function linkReferences(node: SerializedDocumentNode, registry: Map<string, Model>): void {
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
        throw new BrokenReferenceError(
          `Broken reference: model "${node.tag}" (${node.uuid}) references missing node "${refUuid}" on field "${key}"`,
        );
      }
      (instance as any)[key] = target;
    }
  }

  for (const [key, refUuids] of Object.entries(node.refLists)) {
    const targets: Model[] = [];
    for (const refUuid of refUuids) {
      const target = registry.get(refUuid);
      if (!target) {
        throw new BrokenReferenceError(
          `Broken reference list: model "${node.tag}" (${node.uuid}) references missing node "${refUuid}" on field "${key}"`,
        );
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
      linkReferences(childNode, registry);
    }
  }

  for (const childList of Object.values(node.childLists)) {
    for (const childNode of childList) {
      linkReferences(childNode, registry);
    }
  }
}

export function hydrateModel<T extends Model>(snapshot: SerializedDocument | SerializedDocumentNode): T {
  const rootNode = "root" in snapshot ? snapshot.root : snapshot;
  const registry = new Map<string, Model>();

  // Pass 1: Tree Materialization
  const root = materializeNode(rootNode, registry);

  // Pass 2: Reference Linking
  linkReferences(rootNode, registry);

  return root as T;
}
