import { expect, it } from "vitest";

import { blobMimeOf, isTextBytes, utf8TextOf } from "../media.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

it("reads valid UTF-8 as text and keeps a byte-order mark in it", () => {
  const withMark = Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from("héllo\n", "utf8")]);
  expect({
    plain: utf8TextOf(Buffer.from("line one\nline two\n", "utf8")),
    accented: utf8TextOf(Buffer.from("héllo 😀", "utf8")),
    empty: utf8TextOf(new Uint8Array(0)),
    mark: utf8TextOf(withMark)?.codePointAt(0),
    markLength: utf8TextOf(withMark)?.length,
  }).toEqual({ plain: "line one\nline two\n", accented: "héllo 😀", empty: "", mark: 0xfeff, markLength: 7 });
});

it("reads a view into a larger buffer by its own bytes", () => {
  const backing = Buffer.from("xxHELLOyy", "utf8");
  expect(utf8TextOf(backing.subarray(2, 7))).toBe("HELLO");
});

it("does not read NUL bytes or invalid sequences as text", () => {
  expect({
    nul: utf8TextOf(bytes(0x61, 0, 0x62)),
    lone: utf8TextOf(bytes(0x61, 0xff, 0x62)),
    truncated: utf8TextOf(bytes(0xe2, 0x82)),
    surrogate: isTextBytes(bytes(0xed, 0xa0, 0x80)),
  }).toEqual({ nul: null, lone: null, truncated: null, surrogate: false });
});

it("names a body text/plain when it is text and octet-stream otherwise", () => {
  expect({
    text: blobMimeOf(Buffer.from("ok", "utf8")),
    binary: blobMimeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0, 1, 2)),
  }).toEqual({ text: "text/plain", binary: "application/octet-stream" });
});
