/**
 * The vacuum moves the large text of a stored session into the bucket: a file's prior text, a done isolated
 * completion's stored line, and the messages of a done completion or of none. What a running completion or an agent
 * call owns stays, since a reader needs it whole, and so does a session round's stored line, which `context_recall`
 * and the compaction transcript read by value. Each entity is one update, and a second run finds nothing.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { rowPairId, sessionBlobsTable, sessionsTable } from "@inhuman.tools/harness-contract/schema";
import {
  AgentCallJob,
  BLOB_HEAD_CHARS,
  BLOB_INLINE_MAX_CHARS,
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  parseStoredBlob,
  PromptMessage,
  SessionDocument,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
} from "@inhuman.tools/harness-model";
import { HarnessDatabase } from "@inhuman.tools/scope-plane/sqlite";
import { describe, expect, it } from "vitest";

import { projectModelHistory } from "@/context";

import { vacuumDatabaseBlobs, vacuumSession, type BlobPut } from "../vacuum.js";

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const serializedBytes = (doc: SessionDocument): number => Buffer.byteLength(JSON.stringify(doc.toNodeRows()), "utf8");

/** An in-memory bucket: `put` as the daemon's writer, `read` as its reader. */
function memoryBucket() {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly mime: string }>();
  const puts: string[] = [];
  const put: BlobPut = (bytes, mime) => {
    const sha256 = sha256Of(bytes);
    objects.set(sha256, { bytes: Uint8Array.from(bytes), mime });
    puts.push(sha256);
    return { sha256, bytes: bytes.byteLength, mime };
  };
  const read = (sha256: string): Uint8Array | null => objects.get(sha256)?.bytes ?? null;
  return { objects, puts, put, read };
}

function body(label: string, chars: number): string {
  let text = "";
  for (let line = 1; text.length < chars; line += 1) text += `${label} line ${String(line).padStart(5, "0")}\n`;
  return text.slice(0, chars);
}

const TRANSCRIPT = body("transcript", 120_000);
const PRIOR = body("prior", 9_000);
const LINE = body("pasted", 20_000);
const ORPHAN = body("replaced", 30_000);
const AGENT_PROMPT = body("agent", 40_000);

function done(round: CompletionExpectation): CompletionExpectation {
  round.succeed("settled", "ok", "null", { result: { text: "ok" } });
  return round;
}

/** One session holding every seat, and the entities a test looks at. */
function stored() {
  const doc = SessionDocument.create("vacuum", "");
  const bigPrior = new FileMutateToolJob({
    toolCallId: "p1",
    name: "edit_file",
    argsJson: "{}",
    existed: true,
    priorContent: PRIOR,
  });
  const smallPrior = new FileMutateToolJob({
    toolCallId: "p2",
    name: "edit_file",
    argsJson: "{}",
    existed: true,
    priorContent: "short",
  });
  const moved = { sha256: "a".repeat(64), bytes: 9_000, mime: "text/plain", head: "kept" };
  const alreadyBlob = new FileMutateToolJob({
    toolCallId: "p3",
    name: "write_file",
    argsJson: "{}",
    existed: true,
    priorBlobJson: storedBlobJson(moved),
  });
  // The legacy summarizer: the prefix stored as `promptText` and again as the user message.
  const summarizer = done(
    new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptText: prompt.user`${TRANSCRIPT}`,
      promptMessages: [
        new PromptMessage({ role: "system", content: "Fold this prefix." }),
        new PromptMessage({ role: "user", content: TRANSCRIPT }),
      ],
    }),
  );
  // A session round whose user pasted a large line: it stays, since its readers take it by value.
  const pasted = done(new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${LINE}` }));
  // A round still running keeps its prompt whole.
  const running = new CompletionExpectation({
    connectionId: "c1",
    completionMode: "isolated",
    promptText: prompt.user`${TRANSCRIPT}`,
    promptMessages: [new PromptMessage({ role: "user", content: TRANSCRIPT })],
  });
  // A settled summarizer: its messages were replaced by one line, and the replaced child kept its text.
  const settled = done(
    new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptMessages: [new PromptMessage({ role: "user", content: ORPHAN })],
    }),
  );
  const agent = new AgentCallJob({
    toolCallId: "a1",
    name: "ask",
    argsJson: "{}",
    promptMessages: [new PromptMessage({ role: "user", content: AGENT_PROMPT })],
  });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`go`,
    queue: [],
    doneWork: [
      bigPrior,
      smallPrior,
      alreadyBlob,
      new CompletionJob({ expectation: summarizer }),
      new CompletionJob({ expectation: pasted }),
      new CompletionJob({ expectation: running }),
      new CompletionJob({ expectation: settled }),
      agent,
    ],
  });
  doc.root.head = turn;
  const orphanBefore = settled.promptMessages[0]!;
  settled.promptMessages = [new PromptMessage({ role: "user", content: "ambient compact of a prefix of 4 cells" })];
  return {
    doc,
    bigPrior,
    smallPrior,
    alreadyBlob,
    summarizer,
    pasted,
    running,
    settled,
    orphanBefore,
    agent,
    moved,
  };
}

describe("vacuumSession", () => {
  it("counts what would move on a dry run and changes nothing", () => {
    const { doc, bigPrior, summarizer, pasted, orphanBefore } = stored();
    try {
      const bucket = memoryBucket();
      let updates = 0;
      const stop = doc.onPatch(() => {
        updates += 1;
      });
      const before = serializedBytes(doc);
      const counts = vacuumSession(doc.root, bucket.put, { dryRun: true, read: bucket.read });
      stop();
      expect({
        counts,
        puts: bucket.puts.length,
        updates,
        grew: serializedBytes(doc) - before,
        prior: bigPrior.priorContent === PRIOR,
        promptText: summarizer.promptText === TRANSCRIPT,
        message: summarizer.promptMessages[1]?.content === TRANSCRIPT,
        pasted: pasted.promptText === LINE,
        orphan: orphanBefore.content === ORPHAN,
      }).toEqual({
        counts: {
          fileMutates: 1,
          promptMessages: 2,
          promptTexts: 1,
          bytesMoved: Buffer.byteLength(PRIOR) + 2 * Buffer.byteLength(TRANSCRIPT) + Buffer.byteLength(ORPHAN),
        },
        puts: 0,
        updates: 0,
        grew: 0,
        prior: true,
        promptText: true,
        message: true,
        pasted: true,
        orphan: true,
      });
    } finally {
      doc.destroy();
    }
  });

  it("moves each seat to a head and a reference, one update per entity", () => {
    const { doc, bigPrior, smallPrior, alreadyBlob, summarizer, pasted, orphanBefore, moved } = stored();
    try {
      const bucket = memoryBucket();
      let updates = 0;
      const stop = doc.onPatch(() => {
        updates += 1;
      });
      const counts = vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      stop();
      const sha = (text: string) => sha256Of(Buffer.from(text, "utf8"));
      const referenceOf = (json: string | null) => {
        const blob = parseStoredBlob(json);
        return blob === null
          ? null
          : { sha256: blob.sha256, bytes: blob.bytes, head: blob.head === blob.head.slice(0, BLOB_HEAD_CHARS) };
      };
      expect({
        counts,
        updates,
        priorContent: bigPrior.priorContent,
        prior: referenceOf(bigPrior.priorBlobJson),
        small: [smallPrior.priorContent, smallPrior.priorBlobJson],
        already: parseStoredBlob(alreadyBlob.priorBlobJson),
        summarizerLine: [summarizer.promptText, referenceOf(summarizer.promptTextBlobJson)],
        summarizerMessages: summarizer.promptMessages.map((message) => [
          message.role,
          message.content.length,
          referenceOf(message.contentBlobJson),
        ]),
        pasted: [pasted.promptText.length, referenceOf(pasted.promptTextBlobJson)?.sha256],
        orphan: [orphanBefore.content.length, referenceOf(orphanBefore.contentBlobJson)?.sha256],
        objects: [...bucket.objects.keys()].sort(),
      }).toEqual({
        counts: {
          fileMutates: 1,
          promptMessages: 2,
          promptTexts: 1,
          bytesMoved: Buffer.byteLength(PRIOR) + 2 * Buffer.byteLength(TRANSCRIPT) + Buffer.byteLength(ORPHAN),
        },
        // 1 prior + 1 prompt text + 2 messages: four entities, four updates. The pasted line is not one of them.
        updates: 4,
        priorContent: null,
        prior: { sha256: sha(PRIOR), bytes: 9_000, head: true },
        small: ["short", null],
        already: moved,
        summarizerLine: [
          TRANSCRIPT.slice(0, BLOB_HEAD_CHARS),
          { sha256: sha(TRANSCRIPT), bytes: TRANSCRIPT.length, head: true },
        ],
        summarizerMessages: [
          ["system", "Fold this prefix.".length, null],
          ["user", BLOB_HEAD_CHARS, { sha256: sha(TRANSCRIPT), bytes: TRANSCRIPT.length, head: true }],
        ],
        pasted: [LINE.length, undefined],
        orphan: [BLOB_HEAD_CHARS, sha(ORPHAN)],
        // The prefix stored twice is one object.
        objects: [sha(PRIOR), sha(TRANSCRIPT), sha(ORPHAN)].sort(),
      });
    } finally {
      doc.destroy();
    }
  });

  it("leaves a running completion and an agent call's prompt whole", () => {
    const { doc, running, agent } = stored();
    try {
      const bucket = memoryBucket();
      vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      expect({
        runningLine: running.promptText === TRANSCRIPT,
        runningMessage: running.promptMessages[0]?.content === TRANSCRIPT,
        runningReference: [running.promptTextBlobJson, running.promptMessages[0]?.contentBlobJson],
        agentPrompt: agent.promptMessages[0]?.content === AGENT_PROMPT,
        agentSpeech: agent.speech === AGENT_PROMPT,
      }).toEqual({
        runningLine: true,
        runningMessage: true,
        runningReference: [null, null],
        agentPrompt: true,
        agentSpeech: true,
      });
    } finally {
      doc.destroy();
    }
  });

  it("shrinks the document by about what it moved, and a second run finds nothing", () => {
    const { doc } = stored();
    try {
      const bucket = memoryBucket();
      const before = serializedBytes(doc);
      const first = vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      const after = serializedBytes(doc);
      const second = vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      // The running round, the agent call and the pasted line keep 300 000 characters.
      // The tree from root shrinks by priorContent (9 000) and 2x TRANSCRIPT (240 000).
      const reachableMoved = Buffer.byteLength(PRIOR) + 2 * Buffer.byteLength(TRANSCRIPT);
      expect({
        shrank: before - after > reachableMoved * 0.95,
        left: after < before - reachableMoved + 12_000,
        firstMoved: first.bytesMoved > 0,
        second,
        puts: bucket.puts.length,
      }).toEqual({
        shrank: true,
        left: true,
        firstMoved: true,
        second: { fileMutates: 0, promptMessages: 0, promptTexts: 0, bytesMoved: 0 },
        puts: 4,
      });
    } finally {
      doc.destroy();
    }
  });

  it("leaves a text within the inline limit, and moves one code unit more", () => {
    const doc = SessionDocument.create("vacuum-edge", "");
    try {
      const at = new FileMutateToolJob({
        toolCallId: "e1",
        name: "edit_file",
        argsJson: "{}",
        existed: true,
        priorContent: "a".repeat(BLOB_INLINE_MAX_CHARS),
      });
      const over = new FileMutateToolJob({
        toolCallId: "e2",
        name: "edit_file",
        argsJson: "{}",
        existed: true,
        priorContent: "a".repeat(BLOB_INLINE_MAX_CHARS + 1),
      });
      doc.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`go`,
        queue: [],
        doneWork: [at, over],
      });
      const bucket = memoryBucket();
      const counts = vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      expect({
        counts: counts.fileMutates,
        at: at.priorContent?.length,
        over: [over.priorContent, parseStoredBlob(over.priorBlobJson)?.bytes],
      }).toEqual({ counts: 1, at: BLOB_INLINE_MAX_CHARS, over: [null, BLOB_INLINE_MAX_CHARS + 1] });
    } finally {
      doc.destroy();
    }
  });

  it("the wire still reads a vacuumed summarizer whole", () => {
    const { doc, summarizer } = stored();
    try {
      const bucket = memoryBucket();
      vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read });
      const rows = [...projectModelHistory(summarizer, { readBlob: bucket.read })];
      const headOnly = [...projectModelHistory(summarizer)];
      expect({
        whole: rows.map((row) => (row.content === TRANSCRIPT ? "TRANSCRIPT" : row.content)),
        headOnly: headOnly.map((row) => String(row.content).length),
      }).toEqual({
        whole: ["Fold this prefix.", "TRANSCRIPT"],
        headOnly: ["Fold this prefix.".length, BLOB_HEAD_CHARS],
      });
    } finally {
      doc.destroy();
    }
  });

  describe("a bucket that fails", () => {
    it("stops on a refused put and leaves the entity it was moving, and the ones after it, in the document", () => {
      const { doc, bigPrior, summarizer } = stored();
      try {
        const bucket = memoryBucket();
        let calls = 0;
        const put: BlobPut = (bytes, mime) => {
          calls += 1;
          if (calls > 1) throw new Error("ENOSPC");
          return bucket.put(bytes, mime);
        };
        expect(() => vacuumSession(doc.root, put, { dryRun: false, read: bucket.read })).toThrow("ENOSPC");
        expect({
          movedFirst: bigPrior.priorContent === null && parseStoredBlob(bigPrior.priorBlobJson) !== null,
          stayedLine: summarizer.promptText === TRANSCRIPT,
          stayedMessage: summarizer.promptMessages[1]?.content === TRANSCRIPT,
        }).toEqual({ movedFirst: true, stayedLine: true, stayedMessage: true });
      } finally {
        doc.destroy();
      }
    });

    it("keeps the text when the blob does not read back whole", () => {
      const { doc, bigPrior } = stored();
      try {
        const bucket = memoryBucket();
        const lossy = (sha256: string): Uint8Array | null => bucket.read(sha256)?.subarray(0, 10) ?? null;
        expect(() => vacuumSession(doc.root, bucket.put, { dryRun: false, read: lossy })).toThrow(
          "did not read back whole",
        );
        expect({ prior: bigPrior.priorContent === PRIOR, reference: bigPrior.priorBlobJson }).toEqual({
          prior: true,
          reference: null,
        });
      } finally {
        doc.destroy();
      }
    });

    it("keeps the text when the blob is gone", () => {
      const { doc, bigPrior } = stored();
      try {
        const bucket = memoryBucket();
        expect(() => vacuumSession(doc.root, bucket.put, { dryRun: false, read: () => null })).toThrow(
          "did not read back whole",
        );
        expect(bigPrior.priorContent === PRIOR).toBe(true);
      } finally {
        doc.destroy();
      }
    });
  });

  it("moves nothing from an empty session, or from a root that is in no document", () => {
    const bucket = memoryBucket();
    const none = { fileMutates: 0, promptMessages: 0, promptTexts: 0, bytesMoved: 0 };
    const doc = SessionDocument.create("vacuum-empty", "");
    try {
      expect({
        empty: vacuumSession(doc.root, bucket.put, { dryRun: false, read: bucket.read }),
        docless: vacuumSession(new SessionRoot({ sessionId: "docless", path: "" }), bucket.put, { dryRun: false }),
        puts: bucket.puts.length,
      }).toEqual({ empty: none, docless: none, puts: 0 });
    } finally {
      doc.destroy();
    }
  });

  describe("vacuumDatabaseBlobs", () => {
    it("deletes unreferenced blob IDs from bucket without hydrating sessions", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "harness-vacuum-db-"));
      try {
        const db = new HarnessDatabase(join(tmpDir, "harness.db"));
        db.writeTransaction(["sessions", "session_blobs"], (tx) => {
          tx.insert(sessionsTable)
            .values({
              sessionId: "s1",
              createdAtMs: Date.now(),
              lastActiveAtMs: Date.now(),
              workspacePath: "/tmp",
            })
            .run();
          tx.insert(sessionBlobsTable)
            .values([
              {
                id: rowPairId("s1", "referenced-hash-1"),
                sessionId: "s1",
                blobId: "referenced-hash-1",
                createdAtMs: Date.now(),
              },
              {
                id: rowPairId("s1", "referenced-hash-2"),
                sessionId: "s1",
                blobId: "referenced-hash-2",
                createdAtMs: Date.now(),
              },
            ])
            .run();
        });

        const deleted: string[] = [];
        const bucket = {
          list: () => ["referenced-hash-1", "orphan-hash-1", "referenced-hash-2", "orphan-hash-2"],
          delete: (sha256: string) => {
            deleted.push(sha256);
          },
        };

        const count = vacuumDatabaseBlobs(db, bucket);
        expect(count).toBe(2);
        expect(deleted).toEqual(["orphan-hash-1", "orphan-hash-2"]);
        db.close();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
