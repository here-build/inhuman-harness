/**
 * The two creators of isolated completions keep their prompt out of the document. `promptMessageOf` is the one
 * door: inline within the limit, otherwise the head in `content` and the blob reference beside it. The
 * summarizer's prefix is the case that matters, 0.8 to 1 MB each time, so its test measures the document.
 */
import { createHash } from "node:crypto";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  BLOB_HEAD_CHARS,
  BLOB_INLINE_MAX_CHARS,
  CompletionExpectation,
  CompletionJob,
  parseStoredBlob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { bindBlobReader, type CompleteRequest, type CompleteResult } from "@inhuman.tools/harness-provider-sdk";
import { bindBlobWriter } from "@inhuman.tools/turn/tool-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { historyBehind, keepFloors, projectHistory, sliceCompactEat, Transcript } from "@/context";

import { ambientCutoff, startAmbientCompact } from "../ambient-compact.js";
import { promptMessageOf } from "../prompt-message-of.js";
import { runTextOnlyContinueIntern } from "../re-act-loop-intent-detected-trigger.js";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** An in-memory bucket behind both ports, as the kernel binds them to the directory bucket. */
function seatMemoryBucket(): Map<string, { readonly bytes: Uint8Array; readonly mime: string }> {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly mime: string }>();
  bindBlobWriter((bytes, mime) => {
    const sha256 = sha256Of(bytes);
    objects.set(sha256, { bytes: Uint8Array.from(bytes), mime });
    return { sha256, bytes: bytes.byteLength, mime };
  });
  bindBlobReader((sha256) => objects.get(sha256)?.bytes ?? null);
  return objects;
}

beforeEach(() => resetLocalIDs());
afterEach(() => {
  bindBlobWriter(null);
  bindBlobReader(null);
});

describe("promptMessageOf", () => {
  it("keeps a body within the inline limit on the message", () => {
    const objects = seatMemoryBucket();
    const atLimit = "a".repeat(BLOB_INLINE_MAX_CHARS);
    const message = promptMessageOf("user", atLimit);
    expect({
      role: message.role,
      content: message.content === atLimit,
      json: message.contentBlobJson,
      body: message.body.kind,
      puts: objects.size,
    }).toEqual({ role: "user", content: true, json: null, body: "inline", puts: 0 });
  });

  it("moves a larger body to the bucket: the head stays in content, the reference beside it", () => {
    const objects = seatMemoryBucket();
    const text = `${"line of the transcript prefix\n".repeat(1_000)}tail`;
    const message = promptMessageOf("user", text);
    const bytes = Buffer.from(text, "utf8");
    expect({
      content: message.content,
      blob: parseStoredBlob(message.contentBlobJson),
      body: message.body.kind,
      stored: objects.get(sha256Of(bytes))?.mime,
    }).toEqual({
      content: text.slice(0, BLOB_HEAD_CHARS),
      blob: {
        sha256: sha256Of(bytes),
        bytes: bytes.byteLength,
        mime: "text/plain",
        head: text.slice(0, BLOB_HEAD_CHARS),
      },
      body: "blob",
      stored: "text/plain",
    });
  });

  it("keeps the text inline when no bucket is seated, as before", () => {
    const text = "x".repeat(BLOB_INLINE_MAX_CHARS + 1);
    const message = promptMessageOf("system", text);
    expect({ content: message.content === text, json: message.contentBlobJson }).toEqual({
      content: true,
      json: null,
    });
  });
});

describe("the summarizer's prefix", () => {
  const BIG = 150_000;

  function round(text: string, used: number): CompletionExpectation {
    const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${text}` });
    node.totalTokens = used;
    node.contextLimit = 100;
    node.responseText = text;
    return node;
  }

  /** Two rounds of 150 000 characters each, homed on a session so the document is real. */
  function homedRounds() {
    const plexus = SessionPlexus.create("ambient-blobs", "");
    const older = round("older ".repeat(BIG / 6), 20);
    const newer = round("newer ".repeat(BIG / 6), 80);
    newer.messages = [older];
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hi`,
      doneWork: [new CompletionJob({ expectation: older }), new CompletionJob({ expectation: newer })],
      queue: [],
    });
    plexus.root.head = turn;
    const sliced = sliceCompactEat(Transcript.fromCells(historyBehind(turn)), keepFloors(null));
    const cutoff = ambientCutoff(sliced.keep);
    if (cutoff == null) throw new Error("expected a cutoff round");
    return { plexus, turn, cutoff, sliced };
  }

  it("never enters the document; the wire reads it back whole through the blob reader", async () => {
    const objects = seatMemoryBucket();
    const { plexus, turn, cutoff, sliced } = homedRounds();
    try {
      const before = Y.encodeStateAsUpdate(plexus.doc).byteLength;
      const storedText = (): string => {
        const first = [...objects.values()].at(0);
        return Buffer.from(first?.bytes ?? []).toString("utf8");
      };
      /** What the summarizer's request saw while it was live. */
      const live: Array<{ grew: number; user: string; head: string; wireWhole: boolean }> = [];
      await startAmbientCompact({
        home: turn,
        cutoff,
        prefix: sliced.prefix,
        focus: "keep the cutoff",
        connectionId: "c1",
        model: "summarizer",
        inflight: new Map(),
        complete: (req: CompleteRequest): Promise<CompleteResult> => {
          const user = req.round.promptMessages[1]!;
          const wire = [...projectHistory(req.round, { readBlob: (sha256) => objects.get(sha256)?.bytes ?? null })];
          live.push({
            grew: Y.encodeStateAsUpdate(plexus.doc).byteLength - before,
            user: user.body.kind,
            head: user.content,
            // The projection hands the model the whole prefix, not the head the document keeps.
            wireWhole: wire[1]?.content === storedText(),
          });
          req.round.succeed("settled", "SNAPSHOT", "null", { result: { text: "SNAPSHOT" } });
          return Promise.resolve({ text: "SNAPSHOT" });
        },
      });
      const text = storedText();
      expect({
        objects: objects.size,
        startsWithPrefix: text.startsWith("older older"),
        endsWithFocus: text.endsWith("Emphasize:\nkeep the cutoff"),
        bytes: text.length > 2 * BIG,
        live: live.length,
        seen: live[0],
      }).toEqual({
        objects: 1,
        startsWithPrefix: true,
        endsWithFocus: true,
        bytes: true,
        live: 1,
        seen: {
          grew: expect.any(Number),
          user: "blob",
          head: text.slice(0, BLOB_HEAD_CHARS),
          wireWhole: true,
        },
      });
      // The document grew by a head and a reference, not by 300 000 characters.
      expect(live[0]?.grew).toBeLessThan(10_000);
      // The settled run keeps its result and a one-line reference; the replaced message holds a head only.
      const after = Y.encodeStateAsUpdate(plexus.doc).byteLength;
      expect(after - before).toBeLessThan(10_000);
    } finally {
      plexus.destroy();
    }
  });

  it("stays inline when no bucket is seated: the document holds the text as it did", async () => {
    const { plexus, turn, cutoff, sliced } = homedRounds();
    try {
      const before = Y.encodeStateAsUpdate(plexus.doc).byteLength;
      let grew = 0;
      await startAmbientCompact({
        home: turn,
        cutoff,
        prefix: sliced.prefix,
        focus: "",
        connectionId: "c1",
        model: "summarizer",
        inflight: new Map(),
        complete: (req) => {
          grew = Y.encodeStateAsUpdate(plexus.doc).byteLength - before;
          req.round.succeed("settled", "S", "null", { result: { text: "S" } });
          return Promise.resolve({ text: "S" });
        },
      });
      expect(grew).toBeGreaterThan(2 * BIG);
    } finally {
      plexus.destroy();
    }
  });
});

describe("the continue intern", () => {
  it("builds its two messages through the same door: a clipped speech stays inline", async () => {
    const objects = seatMemoryBucket();
    const plexus = SessionPlexus.create("intern-blobs", "");
    try {
      const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hi`, queue: [] });
      plexus.root.head = turn;
      let messages: Array<[role: string, kind: string]> = [];
      await runTextOnlyContinueIntern({
        speech: "I will write the tests now. ".repeat(2_000),
        wire: { connection: "c1", model: "judge", key: "c1\njudge" },
        haltKeys: new Set(),
        home: turn,
        signal: new AbortController().signal,
        complete: (req) => {
          messages = req.round.promptMessages.map((message) => [message.role, message.body.kind]);
          return Promise.reject(new Error("stop here"));
        },
      });
      expect({ messages, puts: objects.size }).toEqual({
        messages: [
          ["system", "inline"],
          ["user", "inline"],
        ],
        puts: 0,
      });
    } finally {
      plexus.destroy();
    }
  });
});
