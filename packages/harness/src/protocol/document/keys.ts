/**
 * Document identity, public rooms, storage-path hashing, and Y.Doc guid
 * prefixes. Directory names are not identities; images live at
 * `documents/{kind}/{sha256(id)}.yjs`.
 */
import { createHash } from "node:crypto";

import type { Decoder, Encoder } from "./codec.js";

export const DOCUMENT_KINDS = ["kernel", "sessions", "projects"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export type DocumentKey = {
  readonly kind: DocumentKind;
  readonly id: string;
};

/** Storage kind `kernel`, identity `"kernel"`. */
export const KERNEL_DOCUMENT_KEY: DocumentKey = {
  kind: "kernel",
  id: "kernel",
};

/** Matches KernelPlexus. A project guid is minted, not hashed from path. */
export const KERNEL_DOCUMENT_GUID = "harness:kernel";
export const SESSION_DOCUMENT_GUID_PREFIX = "harness:session:";
export const PROJECT_DOCUMENT_GUID_PREFIX = "harness:project";

export const PUBLIC_ROOM = {
  kernel: "kernel",
  project: "project",
  session: "session",
} as const;
export type PublicRoomName = (typeof PUBLIC_ROOM)[keyof typeof PUBLIC_ROOM];

export function isDocumentKind(value: string): value is DocumentKind {
  return value === "kernel" || value === "sessions" || value === "projects";
}

export function parseDocumentKind(value: string): DocumentKind {
  if (isDocumentKind(value)) return value;
  throw new Error(`unknown document kind: ${value}`);
}

export function documentKey(kind: DocumentKind, id: string): DocumentKey {
  const trimmed = id.trim();
  if (trimmed === "") throw new Error("document id is required");
  return { kind, id: trimmed };
}

export function documentKeysEqual(a: DocumentKey, b: DocumentKey): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export function sessionDocumentGuid(sessionId: string): string {
  return `${SESSION_DOCUMENT_GUID_PREFIX}${sessionId}`;
}

export function publicRoomName(kind: DocumentKind): PublicRoomName {
  switch (kind) {
    case "kernel":
      return PUBLIC_ROOM.kernel;
    case "projects":
      return PUBLIC_ROOM.project;
    case "sessions":
      return PUBLIC_ROOM.session;
  }
}

export function sha256Hex(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export function documentImageFileName(id: string): string {
  return `${sha256Hex(id)}.yjs`;
}

/** Path segments under a daemon root. Join with the platform separator at the store. */
export function documentImageSegments(kind: string, id: string): readonly ["documents", string, string] {
  return ["documents", kind, documentImageFileName(id)];
}

export function writeDocumentKey(encoder: Encoder, key: DocumentKey): void {
  encoder.writeVarString(key.kind);
  encoder.writeVarString(key.id);
}

export function readDocumentKey(decoder: Decoder): DocumentKey {
  return documentKey(parseDocumentKind(decoder.readVarString()), decoder.readVarString());
}
