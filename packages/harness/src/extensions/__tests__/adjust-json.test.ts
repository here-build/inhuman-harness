import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { adjustJson } from "../adjust-json.js";

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "harness-adjust-json-"));
}

function fileWith(text: string): string {
  const path = join(tempDir(), "config.json");
  writeFileSync(path, text);
  return path;
}

it("rewrites the file with a two-space indent and a final newline, and returns what it wrote", () => {
  const path = fileWith('{"a":1}');
  const next = adjustJson(path, (raw) => ({ ...(raw as object), b: [2] }));
  expect({ next, text: readFileSync(path, "utf8") }).toEqual({
    next: { a: 1, b: [2] },
    text: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n',
  });
});

it("hands the transformer undefined for a missing, empty, or unparsable file", () => {
  const seen: unknown[] = [];
  const record = (raw: unknown): null => {
    seen.push(raw);
    return null;
  };
  adjustJson(fileWith(""), record);
  adjustJson(fileWith("{nope"), record);
  adjustJson(join(tempDir(), "absent.json"), record);
  expect(seen).toEqual([undefined, undefined, undefined]);
});

it("reads through a byte-order mark instead of treating the file as empty", () => {
  const seen: unknown[] = [];
  adjustJson(fileWith(`${BYTE_ORDER_MARK}{"kept":true}`), (raw) => {
    seen.push(raw);
    return raw;
  });
  expect(seen).toEqual([{ kept: true }]);
});

it("leaves the file untouched when the transformer throws", () => {
  const path = fileWith('{"a":1}');
  expect(() =>
    adjustJson(path, () => {
      throw new Error("refused");
    }),
  ).toThrow("refused");
  expect(readFileSync(path, "utf8")).toBe('{"a":1}');
});
