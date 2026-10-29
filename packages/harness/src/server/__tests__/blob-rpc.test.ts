/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/**
 * blob/get over the session plane: one blob by content hash. A `text/*` body comes back as text, anything else as
 * base64, and a hash the bucket does not hold is invalid params. The kernel seats the bucket under its own root.
 */
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseStoredBlob } from "@inhuman.tools/harness-model";
import { externalizePrior } from "@inhuman.tools/turn/tool-runtime";
import { describe, expect, it, onTestFinished } from "vitest";

import { FsBlobBucket } from "../blobs/fs-bucket.js";
import { RpcInvalidParams } from "../contract.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

async function open() {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-blob-k-"))));
  await kernel.ready;
  const path = await realpath(await mkdtemp(join(tmpdir(), "harness-blob-p-")));
  const project = new ProjectDaemon(kernel, path);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { session, kernel };
}

const PRIOR = "export const answer = 42; // a line of prior text\n".repeat(400);

/** Stamps a prior the way admit does, through the writer port the kernel bound, and returns the hash it names. */
function stamp(text: string): string {
  const stamped = externalizePrior(text);
  const blob = parseStoredBlob("priorBlobJson" in stamped ? stamped.priorBlobJson : null);
  if (blob === null) throw new Error("the prior stayed inline");
  return blob.sha256;
}

describe("blob/get", () => {
  it("returns a prior stamped through the kernel's writer as text", async () => {
    const { session, kernel } = await open();
    const sha256 = stamp(PRIOR);
    const reply = await session.handleRequest("blob/get", { sha256 });
    expect({ reply, onDisk: existsSync(join(kernel.root, "blobs", "sha256", sha256.slice(0, 2), sha256)) }).toEqual({
      reply: { sha256, bytes: Buffer.byteLength(PRIOR, "utf8"), mime: "text/plain", text: PRIOR, bytesBase64: null },
      onDisk: true,
    });
  });

  it("keeps a byte-order mark and multi-byte text exactly", async () => {
    const { session } = await open();
    const text = `\uFEFF${"héllo wörld 😀\n".repeat(700)}`;
    const sha256 = stamp(text);
    const reply = (await session.handleRequest("blob/get", { sha256 })) as { text: string | null };
    expect(reply.text === text).toBe(true);
  });

  it("returns a body that is not text as base64", async () => {
    const { session, kernel } = await open();
    const body = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254]);
    const { sha256 } = new FsBlobBucket(kernel.root).putSync(body, "image/png");
    expect(await session.handleRequest("blob/get", { sha256 })).toEqual({
      sha256,
      bytes: 9,
      mime: "application/octet-stream",
      text: null,
      bytesBase64: Buffer.from(body).toString("base64"),
    });
  });

  it("an unknown hash is invalid params", async () => {
    const { session } = await open();
    const rejected = await session
      .handleRequest("blob/get", { sha256: "0".repeat(64) })
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(RpcInvalidParams);
    expect((rejected as Error).message).toBe("unknown blob");
  });

  it("a blob whose file was edited on disk is unknown, not another fact", async () => {
    const { session, kernel } = await open();
    const sha256 = stamp(PRIOR);
    writeFileSync(join(kernel.root, "blobs", "sha256", sha256.slice(0, 2), sha256), "tampered");
    await expect(session.handleRequest("blob/get", { sha256 })).rejects.toBeInstanceOf(RpcInvalidParams);
  });

  it("a malformed hash is refused before the bucket is asked", async () => {
    const { session } = await open();
    for (const sha256 of ["", "nope", "../../etc/passwd", "A".repeat(64), "a".repeat(63)]) {
      await expect(session.handleRequest("blob/get", { sha256 })).rejects.toBeInstanceOf(RpcInvalidParams);
    }
    await expect(session.handleRequest("blob/get", {})).rejects.toBeInstanceOf(RpcInvalidParams);
  });
});
