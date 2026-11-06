import { DocumentContainer, Model, model, state } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { encodeLogEntry, isEmptyUpdate, readUpdateLog } from "../update-log.js";

@model("test:update-log:root")
class UpdateLogTestRoot extends Model {
  @state accessor one: boolean = false;
  @state accessor two: boolean = false;
  @state accessor blob: boolean = false;
  @state accessor big: string = "";
}

function keys(updates: Uint8Array[] | null): string[] {
  if (updates == null) return [];
  const root = new UpdateLogTestRoot();
  const doc = new DocumentContainer(root);
  for (const entry of updates) doc.applyUpdate(entry);
  const found: string[] = [];
  if (root.blob) found.push("blob");
  if (root.one) found.push("one");
  if (root.two) found.push("two");
  found.sort();
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

function delta(doc: DocumentContainer<UpdateLogTestRoot>, key: "one" | "two" | "blob"): Uint8Array {
  let patch: Uint8Array = new Uint8Array([0, 0]);
  doc.on("update", (u) => {
    patch = u;
  });
  doc.root[key] = true;
  return patch;
}

describe("update log", () => {
  it("reads one update unchanged and merges several appended entries", () => {
    const head = new DocumentContainer(new UpdateLogTestRoot());
    head.root.one = true;
    const first = head.encodeStateAsUpdate();
    const second = delta(head, "two");
    head.destroy();
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
    const head = new DocumentContainer(new UpdateLogTestRoot());
    head.root.big = "x".repeat(80_000);
    head.root.blob = true;
    const bare = head.encodeStateAsUpdate();
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
    const head = new DocumentContainer(new UpdateLogTestRoot());
    head.root.one = true;
    const first = head.encodeStateAsUpdate();
    const second = delta(head, "two");
    head.destroy();
    const torn = concat([encodeLogEntry(first), encodeLogEntry(second), new Uint8Array([0, 0, 9, 9, 1])]);
    expect(keys(readUpdateLog(torn))).toEqual(["one", "two"]);
  });
});
