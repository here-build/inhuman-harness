import { afterEach, expect, it } from "vitest";

import { bindBlobReader, readBlob } from "../blobs.js";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);

afterEach(() => bindBlobReader(null));

it("reads nothing until a host binds its bucket", () => {
  expect(readBlob(SHA)).toBeNull();
});

it("routes a read to the bound reader and stops after it is unbound", () => {
  const seen: string[] = [];
  bindBlobReader((sha256) => {
    seen.push(sha256);
    return sha256 === SHA ? new Uint8Array([1, 2, 3]) : null;
  });
  expect({ hit: [...(readBlob(SHA) ?? [])], miss: readBlob(OTHER), seen }).toEqual({
    hit: [1, 2, 3],
    miss: null,
    seen: [SHA, OTHER],
  });
  bindBlobReader(null);
  expect(readBlob(SHA)).toBeNull();
});

it("a second bind replaces the first", () => {
  bindBlobReader(() => new Uint8Array([1]));
  bindBlobReader(() => new Uint8Array([2]));
  expect([...(readBlob(SHA) ?? [])]).toEqual([2]);
});
