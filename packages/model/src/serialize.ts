import { runInAction } from "mobx";

import { BrokenReferenceError } from "./errors.js";
import { getModelByTag, getModelMetadata } from "./metadata.js";
import { Model } from "./model.js";
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
  const childRecords: Record<string, Record<string, SerializedDocumentNode>> = {};

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
        children[field.propertyKey] =
          val instanceof Model
            ? serializeModel(val as Model)
            : val && typeof val === "object" && "tag" in val && "uuid" in val
              ? (val as SerializedDocumentNode)
              : null;
        break;
      case "list":
        state[field.propertyKey] = Array.isArray(val)
          ? val.map((item) =>
              item instanceof Model
                ? serializeModel(item)
                : item && typeof item === "object" && "tag" in item && "uuid" in item
                  ? (item as SerializedDocumentNode)
                  : item,
            )
          : [];
        break;
      case "refList":
        refLists[field.propertyKey] = Array.isArray(val)
          ? (val as (Model | null)[]).map((m) => m?.uuid).filter((id): id is string => typeof id === "string")
          : [];
        break;
      case "childList":
        childLists[field.propertyKey] = Array.isArray(val)
          ? val.map((m: any) =>
              m instanceof Model
                ? serializeModel(m)
                : m && typeof m === "object" && "tag" in m && "uuid" in m
                  ? (m as SerializedDocumentNode)
                  : m,
            )
          : [];
        break;
      case "childRecord": {
        const rec: Record<string, SerializedDocumentNode> = {};
        if (val && typeof val === "object") {
          for (const [k, child] of Object.entries(val as Record<string, any>)) {
            if (child) {
              rec[k] =
                child instanceof Model
                  ? serializeModel(child)
                  : child && typeof child === "object" && "tag" in child && "uuid" in child
                    ? (child as SerializedDocumentNode)
                    : child;
            }
          }
        }
        childRecords[field.propertyKey] = rec;
        break;
      }
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
    childRecords,
  };
}

export function serializeDocument(root: Model, revision = 0): SerializedDocument {
  return {
    revision,
    root: serializeModel(root),
  };
}

function materializeNode(node: SerializedDocumentNode, registry: Map<string, Model>): Model {
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
          if (item && typeof item === "object" && "tag" in item && "uuid" in item) {
            return materializeNode(item as SerializedDocumentNode, registry);
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
          `model "${node.tag}" references missing node "${refUuid}" on field "${key}"`,
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
          `model "${node.tag}" references missing node "${refUuid}" on field "${key}"`,
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

  if (node.childRecords) {
    for (const rec of Object.values(node.childRecords)) {
      for (const childNode of Object.values(rec)) {
        linkReferences(childNode, registry);
      }
    }
  }

  if (node.state) {
    for (const val of Object.values(node.state)) {
      if (Array.isArray(val)) {
        for (const item of val) {
          if (item && typeof item === "object" && "tag" in item && "uuid" in item) {
            linkReferences(item as SerializedDocumentNode, registry);
          }
        }
      }
    }
  }
}

export function hydrateModel<T extends Model>(
  snapshot: SerializedDocument | SerializedDocumentNode,
  existingRegistry?: Map<string, Model>,
): T {
  return runInAction(() => {
    const rootNode = "root" in snapshot ? snapshot.root : snapshot;
    const registry = existingRegistry ?? new Map<string, Model>();

    // Pass 1: Tree Materialization
    const root = materializeNode(rootNode, registry);

    // Pass 2: Reference Linking
    linkReferences(rootNode, registry);

    return root as T;
  });
}
