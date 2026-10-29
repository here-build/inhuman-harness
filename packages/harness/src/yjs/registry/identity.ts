/**
 * Stored image identity: filenames are sha256(id); identity lives in the
 * Y.Doc. Kernel is fixed. Session/project read one root field off a
 * throwaway doc — not domain models, not a live room.
 */
import { join } from "node:path";

import * as Y from "yjs";

import {
  documentImageSegments,
  KERNEL_DOCUMENT_GUID,
  KERNEL_DOCUMENT_KEY,
  PROJECT_DOCUMENT_GUID_PREFIX,
  sessionDocumentGuid,
  type DocumentKey,
  type DocumentKind,
  type InventoryErrorReason,
} from "@/protocol/document";

import { readUpdateLog } from "../update-log.js";

/** Matches SessionRoot @syncing tag. */
export const SESSION_ROOT_TYPE = "harness:session:root";
/** Matches ProjectRoot @syncing tag. */
export const PROJECT_ROOT_TYPE = "harness:project:root";

const EXTRACT_GUID = "inventory-extract";

export type IdentityDecode =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: InventoryErrorReason };

export function documentImagePath(root: string, kind: DocumentKind, id: string): string {
  return join(root, ...documentImageSegments(kind, id));
}

/** Live replica guid. Restore uses the kind prefix, not a minted project id. */
export function documentGuid(key: DocumentKey): string {
  switch (key.kind) {
    case "kernel":
      return KERNEL_DOCUMENT_GUID;
    case "sessions":
      return sessionDocumentGuid(key.id);
    case "projects":
      return PROJECT_DOCUMENT_GUID_PREFIX;
  }
}

export function decodeImageIdentity(kind: DocumentKind, bytes: Uint8Array): IdentityDecode {
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  const updates = readUpdateLog(bytes);
  const first = updates?.[0];
  if (first == null) return { ok: false, reason: "corrupt" };
  const doc = new Y.Doc({ guid: EXTRACT_GUID });
  try {
    Y.applyUpdate(doc, first);
  } catch {
    doc.destroy();
    return { ok: false, reason: "corrupt" };
  }
  try {
    if (kind === "kernel") return { ok: true, id: KERNEL_DOCUMENT_KEY.id };
    const typeName = kind === "sessions" ? SESSION_ROOT_TYPE : PROJECT_ROOT_TYPE;
    const field = kind === "sessions" ? "sessionId" : "path";
    const id = readRootField(doc, typeName, field);
    if (id == null) return { ok: false, reason: "decode-failure" };
    return { ok: true, id };
  } finally {
    doc.destroy();
  }
}

export function identifyStoredImage(
  root: string,
  kind: DocumentKind,
  storagePath: string,
  bytes: Uint8Array,
): IdentityDecode {
  const decoded = decodeImageIdentity(kind, bytes);
  if (!decoded.ok) return decoded;
  if (documentImagePath(root, kind, decoded.id) !== storagePath) {
    return { ok: false, reason: "mismatch" };
  }
  return decoded;
}

function readRootField(doc: Y.Doc, typeName: string, field: string): string | null {
  const meta = doc.getMap("meta");
  const types = doc.getMap("types");
  const rootUuid = meta.get("root");
  if (typeof rootUuid !== "string" || rootUuid === "") return null;
  const typeMap = types.get(typeName);
  if (!(typeMap instanceof Y.Map)) return null;
  const node = typeMap.get(rootUuid);
  if (!(node instanceof Y.XmlElement)) return null;
  const value = node.getAttribute(field);
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id === "" ? null : id;
}
