import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import {
  BLOB_HEAD_CHARS,
  BLOB_INLINE_MAX_CHARS,
  blobHeadOf,
  exceedsInlineMax,
  parseStoredBlob,
  storedBlobJson,
  type StoredBlob,
} from "../blob-ref.js";
import { FileMutateToolJob } from "../jobs/SystemToolJob.js";

const SHA = "a".repeat(64);
const blob: StoredBlob = { sha256: SHA, bytes: 9000, mime: "text/plain", head: "const x = 1;" };

describe("blob references", () => {
  beforeEach(() => resetLocalIDs());

  it("round-trips through JSON and rejects what is not a reference", () => {
    expect(parseStoredBlob(storedBlobJson(blob))).toEqual(blob);
    expect(parseStoredBlob(null)).toBeNull();
    expect(parseStoredBlob("")).toBeNull();
    expect(parseStoredBlob("   ")).toBeNull();
    expect(parseStoredBlob("not json")).toBeNull();
    expect(parseStoredBlob(JSON.stringify({ ...blob, sha256: "ABC" }))).toBeNull();
    expect(parseStoredBlob(JSON.stringify({ ...blob, bytes: -1 }))).toBeNull();
    expect(parseStoredBlob(JSON.stringify({ sha256: SHA, bytes: 1, mime: "text/plain" }))).toBeNull();
  });

  it("keeps a body inline up to the threshold and externalizes above it", () => {
    expect(exceedsInlineMax("x".repeat(BLOB_INLINE_MAX_CHARS))).toBe(false);
    expect(exceedsInlineMax("x".repeat(BLOB_INLINE_MAX_CHARS + 1))).toBe(true);
    expect(exceedsInlineMax("x".repeat(10), 9)).toBe(true);
  });

  it("cuts the head at the limit without splitting a surrogate pair", () => {
    const short = "hello";
    expect(blobHeadOf(short)).toBe(short);
    const long = "x".repeat(BLOB_HEAD_CHARS + 40);
    expect(blobHeadOf(long)).toHaveLength(BLOB_HEAD_CHARS);
    const pairAtCut = `${"x".repeat(BLOB_HEAD_CHARS - 1)}😀` + `tail`;
    const head = blobHeadOf(pairAtCut);
    expect(head).toHaveLength(BLOB_HEAD_CHARS - 1);
    expect(head.endsWith("x")).toBe(true);
    expect(blobHeadOf("ab😀cd", 3)).toBe("ab");
  });
});

describe("FileMutateToolJob.prior", () => {
  beforeEach(() => resetLocalIDs());

  it("is null when nothing was captured", () => {
    const job = new FileMutateToolJob({ toolCallId: "c1", name: "write_file", argsJson: "{}" });
    expect(job.prior).toBeNull();
    expect(job.priorContent).toBeNull();
    expect(job.priorBlobJson).toBeNull();
  });

  it("reads the inline text first", () => {
    const job = new FileMutateToolJob({ toolCallId: "c2", name: "edit_file", argsJson: "{}", priorContent: "old" });
    expect(job.prior).toEqual({ kind: "inline", text: "old" });
  });

  it("reads the blob reference when the text was externalized", () => {
    const job = new FileMutateToolJob({
      toolCallId: "c3",
      name: "write_file",
      argsJson: "{}",
      existed: true,
      priorBlobJson: storedBlobJson(blob),
    });
    expect(job.priorContent).toBeNull();
    expect(job.prior).toEqual({ kind: "blob", blob });
  });

  it("treats a corrupt reference as no prior", () => {
    const job = new FileMutateToolJob({ toolCallId: "c4", name: "write_file", argsJson: "{}", priorBlobJson: "{" });
    expect(job.prior).toBeNull();
  });
});
