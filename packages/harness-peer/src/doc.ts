import {
  DocumentContainer,
  Model,
  model,
} from "@inhuman.tools/model";

@model("harness:peer:doc-root")
export class DocRoot extends Model {}

export type Doc = DocumentContainer<any, any>;
export { DocumentContainer } from "@inhuman.tools/model";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type CreateDocOptions = {
  readonly guid?: string;
  readonly revision?: number;
  readonly clientId?: number;
  readonly meta?: Record<string, Record<string, unknown>>;
};

export function createDoc(options?: CreateDocOptions): DocumentContainer<DocRoot> {
  const root = new DocRoot();
  return new DocumentContainer<DocRoot>(root, {
    guid: options?.guid,
    revision: options?.revision,
    clientId: options?.clientId,
    meta: options?.meta,
  });
}

export function encodeStateAsUpdate(
  doc: DocumentContainer<any, any>,
  _targetStateVector?: Uint8Array,
): Uint8Array {
  return doc.encodeStateAsUpdate();
}

export function applyUpdate(
  doc: DocumentContainer<any, any>,
  update: Uint8Array,
  origin?: unknown,
): void {
  doc.applyUpdate(update, origin);
}

export function encodeStateVector(
  doc:
    | DocumentContainer<any, any>
    | { readonly guid?: string; readonly revision?: number; readonly clientID?: number }
    | Map<string | number, number>
    | Uint8Array,
): Uint8Array {
  if (doc instanceof Uint8Array) return doc;
  if (doc instanceof Map) {
    const entries = Object.fromEntries(
      [...doc.entries()].map(([k, v]) => [String(k), v]),
    );
    return textEncoder.encode(JSON.stringify(entries));
  }
  const guid = "guid" in doc && typeof doc.guid === "string" ? doc.guid : "";
  const revision = "revision" in doc && typeof doc.revision === "number" ? doc.revision : 0;
  return textEncoder.encode(JSON.stringify({ guid, revision }));
}

export function decodeStateVector(bytes: Uint8Array): Map<string, number> {
  const map = new Map<string, number>();
  if (bytes.byteLength === 0) return map;
  try {
    const text = textDecoder.decode(bytes);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if ("guid" in parsed && typeof parsed.guid === "string") {
        map.set(parsed.guid, typeof parsed.revision === "number" ? parsed.revision : 0);
      } else {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "number") map.set(k, v);
        }
      }
    }
  } catch {
    // ignore
  }
  return map;
}
