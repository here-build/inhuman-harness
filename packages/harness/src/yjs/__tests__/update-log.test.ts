import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeLogEntry, isEmptyUpdate, readUpdateLog } from "../update-log.js";

function update(key: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("root").set(key, true);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}

function keys(updates: Uint8Array[] | null): string[] {
  if (updates == null) return [];
  const doc = new Y.Doc();
  for (const entry of updates) Y.applyUpdate(doc, entry);
  const found = [...doc.getMap("root").keys()].sort();
  doc.destroy();
  return found;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function delta(doc: Y.Doc, key: string): Uint8Array {
  const vector = Y.encodeStateVector(doc);
  doc.getMap("root").set(key, true);
  return Y.encodeStateAsUpdate(doc, vector);
}

describe("update log", () => {
  it("reads one update unchanged and merges several appended entries", () => {
    const first = update("one");
    const second = update("two");
    const log = concat([encodeLogEntry(first), encodeLogEntry(second)]);
    expect({
      unframed: keys(readUpdateLog(first)),
      logged: keys(readUpdateLog(log)),
      empty: readUpdateLog(new Uint8Array()),
      blank: isEmptyUpdate(new Uint8Array([0, 0])),
      garbage: readUpdateLog(new Uint8Array([0, 1, 2, 3])),
    }).toEqual({
      unframed: ["one"],
      logged: ["one", "two"],
      empty: null,
      blank: true,
      garbage: null,
    });
  });

  it("joins a snapshot with later appended entries, including one past 64KiB", () => {
    const head = new Y.Doc();
    head.getMap("root").set("blob", "x".repeat(80_000));
    const bare = Y.encodeStateAsUpdate(head);
    const first = delta(head, "one");
    const second = delta(head, "two");
    head.destroy();
    const image = concat([encodeLogEntry(bare), encodeLogEntry(first), encodeLogEntry(second)]);
    const torn = concat([image, new Uint8Array([0, 0, 1])]);
    expect({
      parts: readUpdateLog(image)?.length,
      keys: keys(readUpdateLog(image)),
      torn: keys(readUpdateLog(torn)),
    }).toEqual({
      parts: 3,
      keys: ["blob", "one", "two"],
      torn: ["blob", "one", "two"],
    });
  });

  it("drops a torn final log entry and keeps the durable prefix", () => {
    const first = update("one");
    const second = update("two");
    const torn = concat([encodeLogEntry(first), encodeLogEntry(second), new Uint8Array([0, 0, 9, 9, 1])]);
    expect(keys(readUpdateLog(torn))).toEqual(["one", "two"]);
  });
});
