import { prompt } from "@inhuman.tools/harness-commons";
import {
  type BlobPeek,
  FileMutateToolJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
  SystemToolJob,
  type ToolCallJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { mutateArgsHaveDiff } from "../identity.js";
import { mutateSuggestionReceipt, workCellFace } from "../work-text.js";

const SHA = "d".repeat(64);
const file = `${Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
const edited = file.replace("line-15", "line-15-edited");
const priorBlobJson = storedBlobJson({ sha256: SHA, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) });

/** The cache holds what the test gives it, and counts how often it was asked for a hash. */
function cache(
  texts: Record<string, string> = {},
): BlobPeek & { readonly peeked: string[]; readonly wanted: string[] } {
  const peeked: string[] = [];
  const wanted: string[] = [];
  return {
    peeked,
    wanted,
    peek: (sha256) => {
      peeked.push(sha256);
      return texts[sha256] ?? null;
    },
    want: (sha256) => {
      wanted.push(sha256);
    },
  };
}

const editArgs = JSON.stringify({ path: "a.ts", old_string: "line-15", new_string: "line-15-edited" });
const spanDiff = { kind: "diff", old: "line-15", new: "line-15-edited", path: "a.ts", lineStart: 16 } as const;
const wholeDiff = { kind: "diff", old: file, new: edited, path: "a.ts" } as const;

function edit(fields: { priorContent?: string; priorBlobJson?: string } = {}): FileMutateToolJob {
  return new FileMutateToolJob({
    toolCallId: "e",
    name: "edit_file",
    argsJson: editArgs,
    priorLineStart: 16,
    existed: true,
    outcomeJson: '{"ok":true}',
    completed: true,
    ...fields,
  });
}

function overwrite(): FileMutateToolJob {
  return new FileMutateToolJob({
    toolCallId: "w",
    name: "write_file",
    argsJson: JSON.stringify({ path: "a.ts", content: edited, overwriteExisting: true }),
    priorBlobJson,
    existed: true,
    outcomeJson: '{"ok":true,"text":"replaced a.ts"}',
    completed: true,
  });
}

describe("a prior held in a blob", () => {
  it("reads as the span, with the stamped line, until the cache holds the text; the cache is asked for it", () => {
    const empty = cache();
    expect(workCellFace(edit({ priorBlobJson }), "e", false, true, "", undefined, empty).receipt).toEqual(spanDiff);
    expect(empty.wanted).toEqual([SHA]);
    expect(mutateSuggestionReceipt(edit({ priorBlobJson }), empty)).toEqual(spanDiff);
  });

  it("reads as the whole file once the cache holds the text, and is not asked for again", () => {
    const held = cache({ [SHA]: file });
    expect(workCellFace(edit({ priorBlobJson }), "e", false, true, "", undefined, held).receipt).toEqual(wholeDiff);
    expect(mutateSuggestionReceipt(edit({ priorBlobJson }), held)).toEqual(wholeDiff);
    expect(held.wanted).toEqual([]);
  });

  it("paints an overwrite as the result text until the text lands, and as a diff after", () => {
    expect(workCellFace(overwrite(), "w", false, true, "", undefined, cache()).receipt).toEqual({
      kind: "text",
      text: "replaced a.ts",
    });
    expect(workCellFace(overwrite(), "w", false, true, "", undefined, cache({ [SHA]: file })).receipt).toEqual(
      wholeDiff,
    );
  });

  it("is the replica without a prior when no cache is passed, and asks for nothing", () => {
    expect(workCellFace(edit({ priorBlobJson }), "e", false, true).receipt).toEqual(spanDiff);
    expect(workCellFace(overwrite(), "w", false, true).receipt).toEqual({ kind: "text", text: "replaced a.ts" });
  });

  it("never touches the cache for an inline prior", () => {
    const spy = cache();
    expect(workCellFace(edit({ priorContent: file }), "e", false, true, "", undefined, spy).receipt).toEqual(wholeDiff);
    expect({ peeked: spy.peeked, wanted: spy.wanted }).toEqual({ peeked: [], wanted: [] });
  });

  it("is read off the job's fields, not its class", () => {
    const stub = {
      name: "edit_file",
      args: JSON.parse(editArgs) as Record<string, unknown>,
      priorLineStart: 16,
      prior: edit({ priorBlobJson }).prior,
    } as unknown as ToolCallJob;
    expect(mutateSuggestionReceipt(stub, cache())).toEqual(spanDiff);
    expect(mutateSuggestionReceipt(stub, cache({ [SHA]: file }))).toEqual(wholeDiff);
  });

  it("falls back to a whole-file read earlier in the turn while the text is on its way", () => {
    const plexus = SessionPlexus.create("blobs", "/work");
    try {
      const read = new SystemToolJob({
        toolCallId: "r",
        name: "read_file",
        argsJson: JSON.stringify({ path: "a.ts" }),
        outcomeJson: JSON.stringify({ ok: true, text: file }),
        completed: true,
      });
      const change = edit({ priorBlobJson });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`p`,
        doneWork: [read, change],
        queue: [],
      });
      turn.pushChild(read);
      turn.pushChild(change);
      plexus.root.head = turn;
      const empty = cache();
      expect(mutateSuggestionReceipt(change, empty)).toEqual(wholeDiff);
      expect(empty.wanted).toEqual([SHA]);
    } finally {
      plexus.destroy();
    }
  });
});

describe("mutateArgsHaveDiff", () => {
  it("counts a blob prior as stamped, and a corrupt reference as none", () => {
    expect(mutateArgsHaveDiff(overwrite())).toBe(true);
    const corrupt = new FileMutateToolJob({
      toolCallId: "c",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: edited }),
      priorBlobJson: "{not json",
      existed: true,
    });
    expect(mutateArgsHaveDiff(corrupt)).toBe(false);
  });
});
