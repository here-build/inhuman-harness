/* eslint-disable security/detect-non-literal-fs-filename -- temp dirs */
/**
 * A file's prior text stays on the job while small and leaves the document as a blob reference once it passes
 * the inline limit. The port, and the two sites that stamp it: admit (`ToolCallHandler`) and the licensed body
 * (`executeSystemTool`'s `onPriorContent`).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BLOB_HEAD_CHARS,
  BLOB_INLINE_MAX_CHARS,
  FileMutateToolJob,
  parseStoredBlob,
  SessionPlexus,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { bindSessionCatalog, KernelToolCatalog, type CatalogEntry } from "../../tool-catalog/index.js";
import {
  bindBlobWriter,
  executeSystemTool,
  externalizePrior,
  externalizeText,
  ToolCallHandler,
  writeBlob,
  type BlobWriter,
} from "../index.js";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Distinct lines, so a span's line number is known: line 40 is `LINE_40`. */
function fileText(chars: number): string {
  let text = "";
  for (let line = 1; text.length < chars; line += 1) {
    text += `line ${String(line).padStart(4, "0")}: the quick brown fox\n`;
  }
  return text.slice(0, chars);
}

const LINE_40 = "line 0040: the quick brown fox";
const BIG = fileText(9_000);
const SMALL = fileText(100);

/** An in-memory bucket behind the writer port; `puts` counts every call, not every new object. */
function memoryBucket(): {
  readonly writer: BlobWriter;
  readonly stored: Map<string, { readonly bytes: Uint8Array; readonly mime: string }>;
  readonly puts: string[];
} {
  const stored = new Map<string, { readonly bytes: Uint8Array; readonly mime: string }>();
  const puts: string[] = [];
  const writer: BlobWriter = (bytes, mime) => {
    const sha256 = sha256Of(bytes);
    stored.set(sha256, { bytes: Uint8Array.from(bytes), mime });
    puts.push(sha256);
    return { sha256, bytes: bytes.byteLength, mime };
  };
  return { writer, stored, puts };
}

beforeEach(() => resetLocalIDs());
afterEach(() => bindBlobWriter(null));

describe("externalizePrior", () => {
  it("keeps every text inline while no writer is bound", () => {
    expect(externalizePrior(BIG)).toEqual({ priorContent: BIG });
  });

  it("puts a text over the inline limit and returns its reference with the head", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const stamp = externalizePrior(BIG);
    expect(stamp).toEqual({ priorBlobJson: expect.any(String) });
    const blob = parseStoredBlob("priorBlobJson" in stamp ? stamp.priorBlobJson : null);
    const bytes = Buffer.from(BIG, "utf8");
    expect(blob).toEqual({
      sha256: sha256Of(bytes),
      bytes: 9_000,
      mime: "text/plain",
      head: BIG.slice(0, BLOB_HEAD_CHARS),
    });
    expect({
      objects: [...bucket.stored.keys()],
      body: Buffer.from(bucket.stored.get(sha256Of(bytes))?.bytes ?? []).toString("utf8") === BIG,
      mime: bucket.stored.get(sha256Of(bytes))?.mime,
    }).toEqual({ objects: [sha256Of(bytes)], body: true, mime: "text/plain" });
  });

  it("keeps a text at the limit inline and moves one code unit more", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const atLimit = "a".repeat(BLOB_INLINE_MAX_CHARS);
    const over = "a".repeat(BLOB_INLINE_MAX_CHARS + 1);
    expect({
      atLimit: externalizePrior(atLimit),
      over: "priorBlobJson" in externalizePrior(over),
      puts: bucket.puts.length,
    }).toEqual({ atLimit: { priorContent: atLimit }, over: true, puts: 1 });
  });

  it("counts UTF-8 bytes, and the head never splits a surrogate pair", () => {
    bindBlobWriter(memoryBucket().writer);
    const wide = "é".repeat(9_000);
    const astral = `${"a".repeat(BLOB_HEAD_CHARS - 1)}😀${"b".repeat(9_000)}`;
    const wideBlob = parseStoredBlob(blobJsonOf(externalizePrior(wide)));
    const astralBlob = parseStoredBlob(blobJsonOf(externalizePrior(astral)));
    expect({
      wide: [wideBlob?.bytes, wideBlob?.head.length],
      astral: [astralBlob?.bytes, astralBlob?.head],
    }).toEqual({
      wide: [18_000, BLOB_HEAD_CHARS],
      astral: [Buffer.byteLength(astral, "utf8"), "a".repeat(BLOB_HEAD_CHARS - 1)],
    });
  });

  it("falls back to inline when the bucket refuses the write", () => {
    bindBlobWriter(() => {
      throw new Error("ENOSPC");
    });
    expect(externalizePrior(BIG)).toEqual({ priorContent: BIG });
  });

  it("is inline again once the writer is unbound", () => {
    bindBlobWriter(memoryBucket().writer);
    bindBlobWriter(null);
    expect(externalizePrior(BIG)).toEqual({ priorContent: BIG });
  });
});

function blobJsonOf(stamp: ReturnType<typeof externalizePrior>): string | null {
  return "priorBlobJson" in stamp ? stamp.priorBlobJson : null;
}

describe("externalizeText", () => {
  it("keeps every text inline while no writer is bound", () => {
    expect(externalizeText(BIG)).toEqual({ kind: "inline", text: BIG });
  });

  it("puts a text over the inline limit and returns the head beside the reference", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const stamp = externalizeText(BIG);
    const bytes = Buffer.from(BIG, "utf8");
    expect(stamp).toEqual({
      kind: "blob",
      head: BIG.slice(0, BLOB_HEAD_CHARS),
      blobJson: expect.any(String),
    });
    expect({
      blob: parseStoredBlob(stamp.kind === "blob" ? stamp.blobJson : null),
      objects: [...bucket.stored.keys()],
      mime: bucket.stored.get(sha256Of(bytes))?.mime,
    }).toEqual({
      blob: { sha256: sha256Of(bytes), bytes: 9_000, mime: "text/plain", head: BIG.slice(0, BLOB_HEAD_CHARS) },
      objects: [sha256Of(bytes)],
      mime: "text/plain",
    });
  });

  it("takes the media type the caller names", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const stamp = externalizeText(BIG, "text/markdown");
    expect({
      blob: parseStoredBlob(stamp.kind === "blob" ? stamp.blobJson : null)?.mime,
      stored: [...bucket.stored.values()].map((object) => object.mime),
    }).toEqual({ blob: "text/markdown", stored: ["text/markdown"] });
  });

  it("keeps a text at the limit inline and moves one code unit more", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const atLimit = "a".repeat(BLOB_INLINE_MAX_CHARS);
    expect({
      atLimit: externalizeText(atLimit),
      over: externalizeText("a".repeat(BLOB_INLINE_MAX_CHARS + 1)).kind,
      puts: bucket.puts.length,
    }).toEqual({ atLimit: { kind: "inline", text: atLimit }, over: "blob", puts: 1 });
  });

  it("two equal texts name one object", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const first = externalizeText(BIG);
    const second = externalizeText(BIG);
    expect({ same: first, objects: bucket.stored.size }).toEqual({ same: second, objects: 1 });
  });

  it("falls back to inline when the bucket refuses the write", () => {
    bindBlobWriter(() => {
      throw new Error("ENOSPC");
    });
    expect(externalizeText(BIG)).toEqual({ kind: "inline", text: BIG });
  });

  it("externalizePrior is this stamp in the shape a file-mutate job takes", () => {
    bindBlobWriter(memoryBucket().writer);
    const text = externalizeText(BIG);
    const prior = externalizePrior(BIG);
    expect({ prior: blobJsonOf(prior), blobJson: text.kind === "blob" ? text.blobJson : null }).toEqual({
      prior: expect.any(String),
      blobJson: blobJsonOf(prior),
    });
  });
});

describe("writeBlob", () => {
  it("throws while no writer is bound, so a caller with no inline fallback stops", () => {
    expect(() => writeBlob(new Uint8Array([1, 2, 3]), "application/octet-stream")).toThrow("no blob writer is bound");
  });

  it("puts through the bound writer and returns its reference", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const body = new Uint8Array([1, 2, 3]);
    expect({ ref: writeBlob(body, "application/octet-stream"), objects: [...bucket.stored.keys()] }).toEqual({
      ref: { sha256: sha256Of(body), bytes: 3, mime: "application/octet-stream" },
      objects: [sha256Of(body)],
    });
  });

  it("lets a refused put through", () => {
    bindBlobWriter(() => {
      throw new Error("ENOSPC");
    });
    expect(() => writeBlob(new Uint8Array([1]), "text/plain")).toThrow("ENOSPC");
  });
});

function invocation(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function packEntry(wireName: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    wireName,
    description: wireName,
    parameters: { type: "object", properties: {} },
    class: extra.class ?? "write",
    source: { kind: "pack", pluginName: "toolkit" },
    execute: extra.execute,
  };
}

describe("admit stamps the prior text", () => {
  let root = "";
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "prior-blob-")));
    writeFileSync(path.join(root, "big.txt"), BIG);
    writeFileSync(path.join(root, "small.txt"), SMALL);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function admit(name: string, args: Record<string, unknown>): FileMutateToolJob {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([packEntry("write_file"), packEntry("edit_file")]);
    const session = new SessionRoot({ sessionId: "s-prior", path: root });
    const job = new ToolCallHandler({ catalog }).admit(invocation(name, args), catalog, { session });
    if (!(job instanceof FileMutateToolJob)) throw new Error(`admit minted ${job.constructor.name}`);
    return job;
  }

  it("edit_file: a 9 000-character prior ends as a reference, and the line still comes from the full text", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const job = admit("edit_file", { path: "big.txt", old_string: LINE_40, new_string: "x" });
    const bytes = Buffer.from(BIG, "utf8");
    expect({
      priorContent: job.priorContent,
      blob: parseStoredBlob(job.priorBlobJson),
      prior: job.prior?.kind,
      line: job.priorLineStart,
      existed: job.existed,
      puts: bucket.puts,
    }).toEqual({
      priorContent: null,
      blob: { sha256: sha256Of(bytes), bytes: 9_000, mime: "text/plain", head: BIG.slice(0, BLOB_HEAD_CHARS) },
      prior: "blob",
      line: 40,
      existed: true,
      puts: [sha256Of(bytes)],
    });
  });

  it("edit_file: a 100-character prior stays inline and nothing is put", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const job = admit("edit_file", { path: "small.txt", old_string: "line 0002", new_string: "x" });
    expect({
      priorContent: job.priorContent,
      priorBlobJson: job.priorBlobJson,
      prior: job.prior,
      line: job.priorLineStart,
      puts: bucket.puts.length,
    }).toEqual({
      priorContent: SMALL,
      priorBlobJson: null,
      prior: { kind: "inline", text: SMALL },
      line: 2,
      puts: 0,
    });
  });

  it("write_file with the overwrite flag: the prior is a reference", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const job = admit("write_file", { path: "big.txt", content: "new", overwriteExisting: true });
    expect({
      completed: job.completed,
      priorContent: job.priorContent,
      blob: parseStoredBlob(job.priorBlobJson)?.bytes,
      puts: bucket.puts.length,
    }).toEqual({ completed: false, priorContent: null, blob: 9_000, puts: 1 });
  });

  it("write_file refused at the door still carries its prior as a reference, put once", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const job = admit("write_file", { path: "big.txt", content: "new" });
    expect({
      completed: job.completed,
      refused: JSON.parse(job.receiptJson ?? "null"),
      priorContent: job.priorContent,
      blob: parseStoredBlob(job.priorBlobJson)?.head,
      puts: bucket.puts.length,
    }).toEqual({
      completed: true,
      refused: { ok: false, text: expect.stringContaining("overwriteExisting") },
      priorContent: null,
      blob: BIG.slice(0, BLOB_HEAD_CHARS),
      puts: 1,
    });
  });

  it("a missing file has no prior in either field", () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const job = admit("write_file", { path: "fresh.txt", content: "new" });
    expect({
      existed: job.existed,
      priorContent: job.priorContent,
      priorBlobJson: job.priorBlobJson,
      prior: job.prior,
      puts: bucket.puts.length,
    }).toEqual({ existed: false, priorContent: null, priorBlobJson: null, prior: null, puts: 0 });
  });

  it("without a bound writer the whole prior stays inline, as before", () => {
    const job = admit("edit_file", { path: "big.txt", old_string: LINE_40, new_string: "x" });
    expect({
      priorContent: job.priorContent === BIG,
      priorBlobJson: job.priorBlobJson,
      line: job.priorLineStart,
    }).toEqual({
      priorContent: true,
      priorBlobJson: null,
      line: 40,
    });
  });
});

describe("the licensed body stamps the prior text", () => {
  /**
   * Runs `edit_file` whose body reports `prior` through `onPriorContent`, as the toolkit's does. The job comes
   * back inside an object: a job is thenable, and returning it from an async function would await it.
   */
  async function run(
    prior: string | null,
    seed: { readonly priorContent?: string; readonly priorBlobJson?: string } = {},
  ): Promise<{ readonly job: FileMutateToolJob }> {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      packEntry("edit_file", {
        execute: async (_raw, ctx) => {
          ctx.onPriorContent?.(prior);
          return { ok: true, text: "edited" };
        },
      }),
    ]);
    const plexus = SessionPlexus.create("exec-prior-blob", "/tmp/exec-prior-blob");
    onTestFinished(() => plexus.destroy());
    bindSessionCatalog(plexus.root, catalog);
    const job = new FileMutateToolJob({
      toolCallId: "p1",
      name: "edit_file",
      argsJson: JSON.stringify({ path: "big.txt", old_string: LINE_40, new_string: "x" }),
      ...seed,
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [job],
      queue: [],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    await executeSystemTool(job, new AbortController().signal);
    return { job };
  }

  it("a 9 000-character prior ends as a reference, and the line still comes from the full text", async () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const { job } = await run(BIG);
    const bytes = Buffer.from(BIG, "utf8");
    expect({
      priorContent: job.priorContent,
      blob: parseStoredBlob(job.priorBlobJson),
      line: job.priorLineStart,
      outcome: JSON.parse(job.receiptJson ?? "null"),
      puts: bucket.puts,
    }).toEqual({
      priorContent: null,
      blob: { sha256: sha256Of(bytes), bytes: 9_000, mime: "text/plain", head: BIG.slice(0, BLOB_HEAD_CHARS) },
      line: 40,
      outcome: { ok: true, text: "edited" },
      puts: [sha256Of(bytes)],
    });
  });

  it("a 100-character prior stays inline", async () => {
    const bucket = memoryBucket();
    bindBlobWriter(bucket.writer);
    const { job } = await run(SMALL);
    expect({ priorContent: job.priorContent, priorBlobJson: job.priorBlobJson, puts: bucket.puts.length }).toEqual({
      priorContent: SMALL,
      priorBlobJson: null,
      puts: 0,
    });
  });

  it("a prior that shrank under the limit since admit clears the stale reference", async () => {
    bindBlobWriter(memoryBucket().writer);
    const { job } = await run(SMALL, {
      priorBlobJson: JSON.stringify({ sha256: "a".repeat(64), bytes: 9_000, mime: "text/plain", head: "h" }),
    });
    expect({ priorContent: job.priorContent, priorBlobJson: job.priorBlobJson }).toEqual({
      priorContent: SMALL,
      priorBlobJson: null,
    });
  });

  it("a prior that grew past the limit since admit clears the stale inline text", async () => {
    bindBlobWriter(memoryBucket().writer);
    const { job } = await run(BIG, { priorContent: SMALL });
    expect({ priorContent: job.priorContent, blob: parseStoredBlob(job.priorBlobJson)?.bytes }).toEqual({
      priorContent: null,
      blob: 9_000,
    });
  });

  it("no prior (missing or binary file) clears both fields", async () => {
    bindBlobWriter(memoryBucket().writer);
    const { job } = await run(null, { priorContent: SMALL });
    expect({ priorContent: job.priorContent, priorBlobJson: job.priorBlobJson, prior: job.prior }).toEqual({
      priorContent: null,
      priorBlobJson: null,
      prior: null,
    });
  });

  it("without a bound writer the whole prior stays inline, as before", async () => {
    const { job } = await run(BIG);
    expect({
      priorContent: job.priorContent === BIG,
      priorBlobJson: job.priorBlobJson,
      line: job.priorLineStart,
    }).toEqual({
      priorContent: true,
      priorBlobJson: null,
      line: 40,
    });
  });
});
