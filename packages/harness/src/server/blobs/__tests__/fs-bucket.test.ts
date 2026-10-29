/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { blobKeyOf, sha256OfBlobKey } from "../bucket.js";
import { FsBlobBucket } from "../fs-bucket.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "fs-bucket-"));
  roots.push(root);
  return root;
}

const utf8 = (text: string): Uint8Array => Buffer.from(text, "utf8");
const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const objectPath = (root: string, sha256: string): string => join(root, "blobs", "sha256", sha256.slice(0, 2), sha256);
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("FsBlobBucket", () => {
  it("round-trips a body under its content address", async () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const body = utf8("hello, bucket\n");
    const ref = bucket.putSync(body, "text/plain");
    const key = blobKeyOf(ref.sha256);
    expect({
      ref,
      key,
      sync: Buffer.from(bucket.getSync(key) ?? []).toString("utf8"),
      async: Buffer.from((await bucket.get(key)) ?? []).toString("utf8"),
      head: bucket.headSync(key),
      onDisk: statSync(objectPath(root, ref.sha256)).size,
    }).toEqual({
      ref: { sha256: sha256Of(body), bytes: 14, mime: "text/plain" },
      key: `sha256/${sha256Of(body)}`,
      sync: "hello, bucket\n",
      async: "hello, bucket\n",
      head: { bytes: 14, mime: null },
      onDisk: 14,
    });
  });

  it("stores the empty body", () => {
    const bucket = new FsBlobBucket(tempRoot());
    const ref = bucket.putSync(new Uint8Array(0), "text/plain");
    expect({ ref, got: [...(bucket.getSync(blobKeyOf(ref.sha256)) ?? [1])] }).toEqual({
      ref: { sha256: sha256Of(new Uint8Array(0)), bytes: 0, mime: "text/plain" },
      got: [],
    });
  });

  it("dedupes: a second put of the same bytes returns the same ref and writes nothing new", () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const body = utf8("the same body");
    const first = bucket.putSync(body, "text/plain");
    const before = statSync(objectPath(root, first.sha256));
    const second = bucket.putSync(Uint8Array.from(body), "text/plain");
    const after = statSync(objectPath(root, first.sha256));
    expect({
      same: second,
      inode: after.ino === before.ino,
      mtime: after.mtimeMs === before.mtimeMs,
      keys: bucket.listSync().keys,
    }).toEqual({ same: first, inode: true, mtime: true, keys: [blobKeyOf(first.sha256)] });
  });

  it("the reference carries the caller's media type; the object does not record one", () => {
    const bucket = new FsBlobBucket(tempRoot());
    const body = utf8("x");
    const asText = bucket.putSync(body, "text/plain");
    const asOther = bucket.putSync(body, "text/x-note");
    expect({
      asOther,
      same: asOther.sha256 === asText.sha256,
      head: bucket.headSync(blobKeyOf(asText.sha256)),
    }).toEqual({
      asOther: { sha256: asText.sha256, bytes: 1, mime: "text/x-note" },
      same: true,
      head: { bytes: 1, mime: null },
    });
  });

  it("the head of a missing key is null", async () => {
    const bucket = new FsBlobBucket(tempRoot());
    const key = blobKeyOf(sha256Of(utf8("never stored")));
    expect({ sync: bucket.headSync(key), async: await bucket.head(key) }).toEqual({ sync: null, async: null });
  });

  it("lists in key order, a page at a time", async () => {
    const bucket = new FsBlobBucket(tempRoot());
    const keys = Array.from({ length: 7 }, (_, index) =>
      blobKeyOf(bucket.putSync(utf8(`body ${index}`), "text/plain").sha256),
    ).sort();
    const pages: string[][] = [];
    let after: string | undefined;
    for (;;) {
      const page = await bucket.list({ limit: 3, ...(after === undefined ? {} : { after }) });
      pages.push([...page.keys]);
      if (page.next === null) break;
      after = page.next;
    }
    const everything = await bucket.list();
    const afterFirst = await bucket.list({ after: keys[0] });
    expect({
      sizes: pages.map((page) => page.length),
      flat: pages.flat(),
      all: everything.keys,
      afterFirst: afterFirst.keys,
      empty: new FsBlobBucket(tempRoot()).listSync(),
    }).toEqual({ sizes: [3, 3, 1], flat: keys, all: keys, afterFirst: keys.slice(1), empty: { keys: [], next: null } });
  });

  it("a page that ends exactly at the last key has no next", () => {
    const bucket = new FsBlobBucket(tempRoot());
    const keys = ["a", "b", "c", "d"].map((body) => blobKeyOf(bucket.putSync(utf8(body), "text/plain").sha256)).sort();
    const first = bucket.listSync({ limit: 2 });
    const second = bucket.listSync({ limit: 2, after: first.next ?? "" });
    expect({ first, second }).toEqual({
      first: { keys: keys.slice(0, 2), next: keys[1] },
      second: { keys: keys.slice(2), next: null },
    });
  });

  it("reads a limit under 1 as 1 and a limit that is not a number as the default", () => {
    const bucket = new FsBlobBucket(tempRoot());
    const keys = ["a", "b", "c"].map((body) => blobKeyOf(bucket.putSync(utf8(body), "text/plain").sha256)).sort();
    expect({
      zero: bucket.listSync({ limit: 0 }),
      negative: bucket.listSync({ limit: -5 }).keys.length,
      infinite: bucket.listSync({ limit: Number.POSITIVE_INFINITY }).keys,
      notANumber: bucket.listSync({ limit: Number.NaN }).keys,
    }).toEqual({ zero: { keys: [keys[0]], next: keys[0] }, negative: 1, infinite: keys, notANumber: keys });
  });

  it("a missing or corrupt file reads as null, and a put heals it", () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const body = utf8("an immutable fact, in two lines\nsecond line\n");
    const ref = bucket.putSync(body, "text/plain");
    const key = blobKeyOf(ref.sha256);
    const path = objectPath(root, ref.sha256);

    writeFileSync(path, utf8("an immutable fact, edited!!!!!!!!!!!!!!!!!!!!!!!!\n"));
    const edited = bucket.getSync(key);
    truncateSync(path, 5);
    const torn = bucket.getSync(key);
    const healed = bucket.putSync(body, "text/plain");
    const afterHeal = Buffer.from(bucket.getSync(key) ?? []).toString("utf8");
    rmSync(path);
    const missing = bucket.getSync(key);

    expect({ edited, torn, healed, afterHeal, missing }).toEqual({
      edited: null,
      torn: null,
      healed: ref,
      afterHeal: "an immutable fact, in two lines\nsecond line\n",
      missing: null,
    });
  });

  it("leaves nothing in tmp after a put", () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    bucket.putSync(utf8("one"), "text/plain");
    bucket.putSync(utf8("two"), "text/plain");
    bucket.putSync(utf8("one"), "text/plain");
    expect(readdirSync(join(root, "blobs", "tmp"))).toEqual([]);
  });

  it("leaves nothing in tmp after a put that fails, and rejects", async () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const body = utf8("blocked");
    const sha256 = sha256Of(body);
    // A directory sits where the object belongs, so the rename cannot land.
    mkdirSync(objectPath(root, sha256), { recursive: true });
    expect(() => bucket.putSync(body, "text/plain")).toThrow();
    await expect(bucket.put(body, "text/plain")).rejects.toThrow();
    expect(readdirSync(join(root, "blobs", "tmp"))).toEqual([]);
  });

  it("creates directories 0700 and objects 0600", () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const { sha256 } = bucket.putSync(utf8("private"), "text/plain");
    expect({
      blobs: modeOf(join(root, "blobs")),
      tmp: modeOf(join(root, "blobs", "tmp")),
      algorithm: modeOf(join(root, "blobs", "sha256")),
      fan: modeOf(join(root, "blobs", "sha256", sha256.slice(0, 2))),
      object: modeOf(objectPath(root, sha256)),
    }).toEqual({ blobs: 0o700, tmp: 0o700, algorithm: 0o700, fan: 0o700, object: 0o600 });
  });

  it("refuses keys that are not sha256/<64 lowercase hex>", async () => {
    const root = tempRoot();
    const bucket = new FsBlobBucket(root);
    const { sha256 } = bucket.putSync(utf8("real"), "text/plain");
    const bad = [
      "",
      sha256,
      `sha256/${sha256.toUpperCase()}`,
      `sha256/${sha256.slice(1)}`,
      `sha256/${sha256}0`,
      `sha256/../../${sha256}`,
      "sha256/../../../../etc/passwd",
      `sha512/${sha256}`,
      `/sha256/${sha256}`,
    ];
    expect(bad.map((key) => [bucket.getSync(key), bucket.headSync(key), sha256OfBlobKey(key)])).toEqual(
      bad.map(() => [null, null, null]),
    );
    for (const key of bad) {
      expect(() => bucket.deleteSync(key)).toThrow(RangeError);
      await expect(bucket.delete(key)).rejects.toThrow(RangeError);
    }
    expect(bucket.getSync(blobKeyOf(sha256))).not.toBeNull();
  });

  it("delete removes the object and is idempotent", async () => {
    const bucket = new FsBlobBucket(tempRoot());
    const { sha256 } = bucket.putSync(utf8("short lived"), "text/plain");
    const key = blobKeyOf(sha256);
    await bucket.delete(key);
    await bucket.delete(key);
    expect({ get: bucket.getSync(key), head: bucket.headSync(key), keys: bucket.listSync().keys }).toEqual({
      get: null,
      head: null,
      keys: [],
    });
  });

  it("keeps binary bodies byte for byte", () => {
    const bucket = new FsBlobBucket(tempRoot());
    const body = Uint8Array.from([0, 1, 2, 255, 254, 0, 128]);
    const { sha256 } = bucket.putSync(body, "application/octet-stream");
    expect([...(bucket.getSync(blobKeyOf(sha256)) ?? [])]).toEqual([...body]);
  });

  it("two buckets over one root see the same objects", () => {
    const root = tempRoot();
    const { sha256 } = new FsBlobBucket(root).putSync(utf8("shared"), "text/plain");
    expect(Buffer.from(new FsBlobBucket(root).getSync(blobKeyOf(sha256)) ?? []).toString("utf8")).toBe("shared");
  });
});
