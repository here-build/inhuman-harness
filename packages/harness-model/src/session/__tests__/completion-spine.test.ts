/**
 * Completion spine is the parent turn tape plus a cutoff's card.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import {
  cacheStatusLog,
  cacheStatusNote,
  CompletionExpectation,
  tapeCacheMiss,
} from "../expectations/CompletionExpectation.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { CompletionJob } from "../jobs/CompletionJob.js";
import { SessionPlexus } from "../SessionPlexus.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

function completion(promptText: string, responseText?: string): CompletionExpectation {
  const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${promptText}` });
  if (responseText !== undefined) node.responseText = responseText;
  return node;
}

function mount(turn: SessionTurn, ...cells: Array<CompletionExpectation | CompactJob>): void {
  for (const cell of cells) {
    const row = cell instanceof CompletionExpectation ? new CompletionJob({ expectation: cell }) : cell;
    turn.enqueue(row);
    turn.doneWork.push(turn.queue.shift()!);
  }
}

describe("CompletionExpectation.spine", () => {
  beforeEach(() => resetLocalIDs());

  it("walks prior completions on the tape and starts at a cutoff card", () => {
    const plexus = SessionPlexus.create("spine");
    try {
      const first = completion("first", "a");
      const priorTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`first`,
        queue: [],
      });
      mount(priorTurn, first);
      const tip = completion("second");
      const tipTurn = new SessionTurn({ turnTail: priorTurn, prompt: prompt.user`second`, queue: [] });
      mount(tipTurn, tip);
      plexus.root.head = tipTurn;

      const hidden = completion("hidden", "drop-me");
      const snap = completion("old", "snapshot");
      const compact = new CompactJob({ standIn: snap.responseText || "summary", completed: true });
      const cutoffTip = completion("new");
      const cutoffTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`new`,
        queue: [],
      });
      mount(cutoffTurn, hidden, compact, cutoffTip);
      plexus.root.head = cutoffTurn;
      expect({
        tape: tip.spine().map((node) => node.promptText),
        cutoff: cutoffTip.spine().map((node) => node.promptText),
      }).toEqual({
        tape: ["first", "second"],
        cutoff: ["new"],
      });
    } finally {
      plexus.destroy();
    }
  });

  it("expects a prompt-cache hit from a warm prior; mismatch note names miss only", () => {
    const plexus = SessionPlexus.create("spine-cache");
    try {
      const first = completion("first", "a");
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`first`,
        queue: [],
      });
      mount(turn, first);
      plexus.root.head = turn;
      const second = completion("second");
      mount(turn, second);
      const firstRound = first.expectPromptCacheHit();
      const coldSecond = second.expectPromptCacheHit();
      first.warmUntil = new Date(Date.now() + 60_000);
      const warmSecond = second.expectPromptCacheHit();
      first.warmUntil = new Date(Date.now() - 1);
      const expired = second.expectPromptCacheHit();

      const snap = completion("old", "snapshot");
      snap.warmUntil = new Date(Date.now() + 60_000);
      const compact = new CompactJob({ standIn: snap.responseText || "summary", completed: true });
      const afterCutoff = completion("new");
      const cutoffTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`new`,
        queue: [],
      });
      mount(cutoffTurn, snap, compact, afterCutoff);
      plexus.root.head = cutoffTurn;

      const node = completion("hi");
      const unset = cacheStatusNote(node);
      node.cacheHit = false;
      node.expectedCacheHit = false;
      const alignedMiss = cacheStatusNote(node);
      node.expectedCacheHit = true;
      const unexpectedMiss = cacheStatusNote(node);
      node.cacheHit = true;
      node.cachedTokens = 12;
      node.expectedCacheHit = false;
      const crumbHit = cacheStatusNote(node);
      node.cachedTokens = 256;
      const unexpectedHit = cacheStatusNote(node);
      node.expectedCacheHit = true;
      node.cachedTokens = 2688;
      const alignedHit = cacheStatusNote(node);
      const hitLog = cacheStatusLog(node);
      node.cacheHit = null;
      const unreported = cacheStatusLog(node);

      const missRows = [
        { cacheHit: false, cachedTokens: 0 },
        { cacheHit: false, cachedTokens: 128 },
        { cacheHit: true, cachedTokens: 0 },
        { cacheHit: true, cachedTokens: 128 },
      ].map((row) => {
        const miss = completion("hi");
        miss.expectedCacheHit = true;
        miss.cacheHit = row.cacheHit;
        miss.cachedTokens = row.cachedTokens;
        return { ...row, miss: tapeCacheMiss(miss), note: cacheStatusNote(miss) };
      });

      expect({
        expectHit: { firstRound, coldSecond, warmSecond, expired, afterCutoff: afterCutoff.expectPromptCacheHit() },
        note: { unset, alignedMiss, unexpectedMiss, crumbHit, unexpectedHit, alignedHit, hitLog, unreported },
        tapeMiss: missRows,
      }).toEqual({
        expectHit: { firstRound: false, coldSecond: false, warmSecond: true, expired: false, afterCutoff: false },
        note: {
          unset: "",
          alignedMiss: "",
          unexpectedMiss: "cache miss · expected hit · 0 cached",
          crumbHit: "",
          unexpectedHit: "cache hit · unexpected · 256 cached",
          alignedHit: "",
          hitLog: "cache hit · 2688 cached",
          unreported: "cache unreported",
        },
        tapeMiss: [
          { cacheHit: false, cachedTokens: 0, miss: true, note: "cache miss · expected hit · 0 cached" },
          { cacheHit: false, cachedTokens: 128, miss: true, note: "cache miss · expected hit · 128 cached" },
          { cacheHit: true, cachedTokens: 0, miss: true, note: "cache miss · expected hit · 0 cached" },
          { cacheHit: true, cachedTokens: 128, miss: true, note: "cache miss · expected hit · 128 cached" },
        ],
      });
    } finally {
      plexus.destroy();
    }
  });

  it("a successful CompactJob drops completions before the cutoff; a failure does not", () => {
    const plexus = SessionPlexus.create("spine-job");
    try {
      const buried = completion("buried", "old");
      const kept = completion("kept", "stay");
      const cutoff = new CompactJob({ reason: "overflow", standIn: "CARD", completed: true, keepTurns: 1 });
      const tip = completion("next");
      const cutoffTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`next`,
        queue: [],
      });
      mount(cutoffTurn, buried, kept, cutoff, tip);
      plexus.root.head = cutoffTurn;

      const failed = new CompactJob({
        reason: "overflow",
        failed: true,
        completed: true,
        notice: "couldn't compact — try again later",
      });
      const afterFail = completion("still");
      const open = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`still`,
        queue: [],
      });
      mount(open, buried, failed, afterFail);

      expect({
        cutoff: tip.spine().map((node) => node.promptText),
        failed: afterFail.spine().map((node) => node.promptText),
      }).toEqual({
        cutoff: ["next"],
        failed: ["buried", "still"],
      });
    } finally {
      plexus.destroy();
    }
  });
});
