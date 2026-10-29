/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseStoredBlob } from "@inhuman.tools/harness-model";
import { readBlob } from "@inhuman.tools/harness-provider-sdk";
import { externalizePrior } from "@inhuman.tools/turn/tool-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BlobBucketSync } from "../bucket.js";
import { FsBlobBucket } from "../fs-bucket.js";
import { bindBlobBucket, bindBlobStore, readBlobSync } from "../store.js";

const roots: string[] = [];

afterEach(() => {
  bindBlobBucket(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "blob-store-"));
  roots.push(root);
  return root;
}

const BIG = "a line of prior text\n".repeat(500);

/** The hash the document would name for this prior text, put through the bound writer port. */
function stampedSha256(text: string): string {
  const stamp = externalizePrior(text);
  const blob = parseStoredBlob("priorBlobJson" in stamp ? stamp.priorBlobJson : null);
  if (blob === null) throw new Error("the prior stayed inline");
  return blob.sha256;
}

describe("blob store", () => {
  it("reads nothing until a bucket is seated", () => {
    expect({
      sync: readBlobSync("0".repeat(64)),
      port: readBlob("0".repeat(64)),
      stamp: externalizePrior(BIG),
    }).toEqual({ sync: null, port: null, stamp: { priorContent: BIG } });
  });

  it("binds the writer and the reader to one bucket under the kernel root", () => {
    const root = tempRoot();
    bindBlobStore(root);
    const sha256 = stampedSha256(BIG);
    const bytes = Buffer.from(BIG, "utf8");
    expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect({
      file: statSync(join(root, "blobs", "sha256", sha256.slice(0, 2), sha256)).size,
      port: Buffer.from(readBlob(sha256) ?? []).toString("utf8") === BIG,
      sync: Buffer.from(readBlobSync(sha256)?.bytes ?? []).toString("utf8") === BIG,
      mime: readBlobSync(sha256)?.mime,
    }).toEqual({ file: bytes.byteLength, port: true, sync: true, mime: "text/plain" });
  });

  it("leaves a small prior inline and writes nothing", () => {
    const root = tempRoot();
    bindBlobStore(root);
    expect({ stamp: externalizePrior("short"), bucket: existsSync(join(root, "blobs")) }).toEqual({
      stamp: { priorContent: "short" },
      bucket: false,
    });
  });

  it("an unknown hash is null through both doors", () => {
    bindBlobStore(tempRoot());
    expect({ sync: readBlobSync("f".repeat(64)), port: readBlob("f".repeat(64)) }).toEqual({ sync: null, port: null });
  });

  it("a malformed hash is null through both doors, not an error", () => {
    bindBlobStore(tempRoot());
    const bad = ["", "../../etc/passwd", "F".repeat(64), "f".repeat(63)];
    expect(bad.map((sha) => [readBlobSync(sha), readBlob(sha)])).toEqual(bad.map(() => [null, null]));
  });

  it("a later bind moves both doors to the new root", () => {
    bindBlobStore(tempRoot());
    const sha256 = stampedSha256(BIG);
    bindBlobStore(tempRoot());
    expect({ sync: readBlobSync(sha256), port: readBlob(sha256) }).toEqual({ sync: null, port: null });
    expect({ again: stampedSha256(BIG), found: readBlobSync(sha256) !== null }).toEqual({ again: sha256, found: true });
  });

  it("names a body by what the bucket recorded, and sniffs only when it recorded nothing", () => {
    const bodies = new Map<string, { bytes: Uint8Array; mime: string | null }>();
    const bucket: BlobBucketSync = {
      putSync: (bytes, mime) => {
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        bodies.set(`sha256/${sha256}`, { bytes, mime: null });
        return { sha256, bytes: bytes.byteLength, mime };
      },
      getSync: (key) => bodies.get(key)?.bytes ?? null,
      headSync: (key) => {
        const body = bodies.get(key);
        return body === undefined ? null : { bytes: body.bytes.byteLength, mime: body.mime };
      },
    };
    bindBlobBucket(bucket);
    const sha256 = stampedSha256(BIG);
    const unrecorded = readBlobSync(sha256)?.mime;
    const body = bodies.get(`sha256/${sha256}`);
    if (body !== undefined) body.mime = "text/x-diff";
    expect({ unrecorded, recorded: readBlobSync(sha256)?.mime }).toEqual({
      unrecorded: "text/plain",
      recorded: "text/x-diff",
    });
  });

  it("a binary body is named octet-stream", () => {
    const root = tempRoot();
    bindBlobStore(root);
    const { sha256 } = new FsBlobBucket(root).putSync(
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]),
      "image/png",
    );
    expect(readBlobSync(sha256)?.mime).toBe("application/octet-stream");
  });

  it("a bucket that refuses the put leaves the prior inline and says so", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    bindBlobBucket({
      putSync: () => {
        throw new Error("ENOSPC: no space left on device");
      },
      getSync: () => null,
      headSync: () => null,
    });
    const stamp = externalizePrior(BIG);
    const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect({
      inline: "priorContent" in stamp && stamp.priorContent === BIG,
      logged: logged.includes("blob bucket refused a put"),
    }).toEqual({
      inline: true,
      logged: true,
    });
  });
});
