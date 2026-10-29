import { Plexus } from "@here.build/plexus";
import {
  type BlobPeek,
  FileMutateToolJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { autorun } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { bindBlobCache } from "../blob-cache.js";
import { turnBeats } from "../tape-live.js";
import { tapeCells, type TapeCell, turnsOldestFirst } from "../tape-read.js";
import { fileFact, toolReceipt } from "../tool-receipt.js";

const SHA = "a".repeat(64);
const file = `${Array.from({ length: 40 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
const edited = file.replace("line-20", "line-20-edited");
const priorBlobJson = storedBlobJson({ sha256: SHA, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) });

/** What the cache holds: nothing until the test lands the text. */
function blobsHolding(texts: Record<string, string> = {}): BlobPeek & { readonly wanted: string[] } {
  const wanted: string[] = [];
  return {
    wanted,
    peek: (sha256) => texts[sha256] ?? null,
    want: (sha256) => {
      wanted.push(sha256);
    },
  };
}

function editJob(fields: { completed?: boolean; outcomeJson?: string | null } = {}) {
  return new FileMutateToolJob({
    name: "edit_file",
    argsJson: JSON.stringify({ path: "a.ts", old_string: "line-20", new_string: "line-20-edited" }),
    priorBlobJson,
    priorLineStart: 21,
    existed: true,
    outcomeJson: '{"ok":true}',
    completed: true,
    ...fields,
  });
}

function overwriteJob() {
  return new FileMutateToolJob({
    name: "write_file",
    argsJson: JSON.stringify({ path: "a.ts", content: "replacement\n", overwriteExisting: true }),
    priorBlobJson,
    existed: true,
    outcomeJson: '{"ok":true,"text":"replaced a.ts"}',
    completed: true,
  });
}

describe("a file mutation whose prior text is in a blob", () => {
  it("paints an edit without the file until the text lands, and asks for it", () => {
    const empty = blobsHolding();
    expect(toolReceipt(editJob(), [], "", empty)).toEqual({
      kind: "diff",
      oldText: "line-20",
      newText: "line-20-edited",
      path: "a.ts",
      lineStart: 21,
    });
    expect(empty.wanted).toEqual([SHA]);

    const held = blobsHolding({ [SHA]: file });
    expect(toolReceipt(editJob(), [], "", held)).toEqual({
      kind: "diff",
      oldText: file,
      newText: edited,
      path: "a.ts",
    });
    expect(held.wanted).toEqual([]);
  });

  it("paints an overwrite as no diff until the text lands, then against the old file", () => {
    const empty = blobsHolding();
    expect(toolReceipt(overwriteJob(), [], "", empty)).toEqual({ kind: "text", text: "replaced a.ts" });
    expect(empty.wanted).toEqual([SHA]);

    expect(toolReceipt(overwriteJob(), [], "", blobsHolding({ [SHA]: file }))).toEqual({
      kind: "diff",
      oldText: file,
      newText: "replacement\n",
      path: "a.ts",
    });
  });

  it("with no cache at all paints what a replica without the prior paints, and asks for nothing", () => {
    expect(toolReceipt(editJob(), [])).toMatchObject({ kind: "diff", oldText: "line-20", lineStart: 21 });
    expect(toolReceipt(overwriteJob(), [])).toEqual({ kind: "text", text: "replaced a.ts" });
  });

  it("falls back to an earlier whole-file read while the text is on its way, and still asks for it", () => {
    const read = new SystemToolJob({
      name: "read_file",
      argsJson: JSON.stringify({ path: "a.ts" }),
      outcomeJson: JSON.stringify({ ok: true, text: file }),
      completed: true,
    });
    const empty = blobsHolding();
    expect(toolReceipt(editJob(), [read], "", empty)).toEqual({
      kind: "diff",
      oldText: file,
      newText: edited,
      path: "a.ts",
    });
    expect(empty.wanted).toEqual([SHA]);
  });

  it("keeps the fact's prior a string: the text once held, null before, and fetches only for an applied one", () => {
    const empty = blobsHolding();
    expect(fileFact(editJob(), empty)).toMatchObject({ status: "applied", prior: null });
    expect(empty.wanted).toEqual([SHA]);

    expect(fileFact(editJob(), blobsHolding({ [SHA]: file }))).toMatchObject({ status: "applied", prior: file });

    const idle = blobsHolding();
    expect(fileFact(editJob({ completed: false, outcomeJson: null }), idle)).toMatchObject({
      status: "pending",
      prior: null,
    });
    expect(fileFact(editJob({ outcomeJson: '{"ok":false}' }), idle)).toMatchObject({ status: "failed", prior: null });
    expect(idle.wanted).toEqual([]);
  });

  it("an inline prior never touches the cache", () => {
    const inline = new FileMutateToolJob({
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "line-20", new_string: "line-20-edited" }),
      priorContent: file,
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    const spy = blobsHolding();
    expect(toolReceipt(inline, [], "", spy)).toMatchObject({ kind: "diff", oldText: file, newText: edited });
    expect(fileFact(inline, spy)).toMatchObject({ prior: file });
    expect(spy.wanted).toEqual([]);
  });
});

function root(job: FileMutateToolJob): SessionRoot {
  const session = new SessionRoot({ sessionId: "blobs", path: "/work" });
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], doneWork: [job] });
  turn.pushChild(job);
  session.head = turn;
  return session;
}

const diffOf = (cells: readonly TapeCell[]) => cells.find((cell) => cell.kind === "tool");

describe("the tape over a blob prior", () => {
  it("shows the whole-file diff once the cache holds the text, the span before", () => {
    const session = root(editJob());
    const plexus = Plexus.bootstrap(session);
    try {
      expect(diffOf(tapeCells(session, blobsHolding()))).toMatchObject({
        body: { kind: "diff", oldText: "line-20", newText: "line-20-edited", lineStart: 21 },
      });
      expect(diffOf(tapeCells(session, blobsHolding({ [SHA]: file })))).toMatchObject({
        body: { kind: "diff", oldText: file, newText: edited },
      });
    } finally {
      plexus.destroy();
    }
  });
});

describe("the tape recomputes when the seated cache lands a blob", () => {
  let release: (() => void) | null = null;
  afterEach(() => {
    release?.();
    release = null;
  });

  it("through the module seat, with no cache passed down", async () => {
    const session = root(editJob());
    const plexus = Plexus.bootstrap(session);
    let answer: (value: unknown) => void = () => undefined;
    const calls: unknown[] = [];
    release = bindBlobCache(
      (method, params) =>
        new Promise((resolve) => {
          calls.push({ method, params });
          answer = resolve;
        }),
    );
    const seen: unknown[] = [];
    const stop = autorun(() => {
      const cell = diffOf(tapeCells(session));
      seen.push(cell?.kind === "tool" ? cell.body : null);
    });
    try {
      expect(calls).toEqual([{ method: "blob/get", params: { sha256: SHA } }]);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ kind: "diff", oldText: "line-20" });

      answer({ sha256: SHA, bytes: file.length, mime: "text/plain", text: file, bytesBase64: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toHaveLength(2);
      expect(seen[1]).toMatchObject({ kind: "diff", oldText: file, newText: edited });
    } finally {
      stop();
      plexus.destroy();
    }
  });

  it("through turnBeats, which is what the page reads", async () => {
    const session = root(editJob());
    const plexus = Plexus.bootstrap(session);
    let answer: (value: unknown) => void = () => undefined;
    release = bindBlobCache(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const [turn] = turnsOldestFirst(session);
    const seen: string[] = [];
    const stop = autorun(() => {
      seen.push(JSON.stringify(turnBeats(turn!, "/work")));
    });
    try {
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("line-20-edited");
      expect(seen[0]).not.toContain("line-19");

      answer({ sha256: SHA, bytes: file.length, mime: "text/plain", text: file, bytesBase64: null });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(seen).toHaveLength(2);
      expect(seen[1]).toContain("line-19");
    } finally {
      stop();
      plexus.destroy();
    }
  });
});
