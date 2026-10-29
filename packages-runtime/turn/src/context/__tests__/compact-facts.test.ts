/**
 * A CompactJob's cut is a fact of the job (F8), and its card is a typed cell
 * that later compactions can recognise (F10).
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { applyCompact } from "../../session/index.js";
import { stampCompactInputs } from "../compact-floors.js";
import { historyBehind, textOfCell, Transcript } from "../index.js";

beforeEach(() => resetLocalIDs());

/** `n` rounds where each completion carries the cells before it, as production does. */
function rounds(n: number): unknown[] {
  const tape: unknown[] = [];
  const seen: Array<CompletionExpectation | SystemToolJob> = [];
  for (let i = 0; i < n; i += 1) {
    const pew = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`turn ${i}` });
    pew.responseText = `answer ${i}`;
    pew.totalTokens = 1_000 * (i + 1);
    pew.contextLimit = 100_000;
    pew.messages = [...seen];
    const call = new SystemToolJob({
      toolCallId: `t${i}`,
      name: "shell",
      argsJson: "{}",
      outcomeJson: JSON.stringify({ ok: true, text: `out ${i}` }),
      completed: true,
    });
    seen.push(pew, call);
    tape.push(new CompletionJob({ expectation: pew }), call);
  }
  return tape;
}

function turnWith(tape: readonly unknown[]): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`q`,
    doneWork: tape as never,
    queue: [],
  });
}

function cutoff(configFloor: number | null, kv: Record<string, string> = {}): CompactJob {
  const job = new CompactJob({ reason: "overflow", standIn: "CARD", completed: true });
  if (configFloor != null) stampCompactInputs(job, configFloor, kv);
  return job;
}

describe("F8: the cut is computed from stamped inputs, never live settings", () => {
  it("changing the keep-turns dial or kv later does not move a stamped cutoff", () => {
    const job = cutoff(1);
    expect({ keepTurns: job.keepTurns, kvKeepTurns: job.kvKeepTurns }).toEqual({ keepTurns: 1, kvKeepTurns: 0 });
    const turn = turnWith([...rounds(6), job]);

    const atMint = historyBehind(turn, { configFloor: 1, kv: {} });
    expect(historyBehind(turn, { configFloor: 4, kv: {} })).toEqual(atMint);
    expect(historyBehind(turn, { configFloor: 1, kv: { "compact.keep-turns": "5" } })).toEqual(atMint);
    // No round is lost or doubled.
    const completions = atMint.filter((cell) => cell instanceof CompletionExpectation);
    expect(new Set(completions).size).toBe(completions.length);
    expect(completions.length).toBeGreaterThan(0);
  });

  it("stamps the kv reading too, and ignores later kv", () => {
    const wide = cutoff(1, { "compact.keep-turns": "3" });
    expect(wide.kvKeepTurns).toBe(3);
    const tape = rounds(6);
    const atMint = historyBehind(turnWith([...tape, wide]), { configFloor: 1, kv: { "compact.keep-turns": "3" } });
    expect(historyBehind(turnWith([...tape, wide]), { configFloor: 1, kv: {} })).toEqual(atMint);
    expect(historyBehind(turnWith([...tape, wide]), { configFloor: 1, kv: { "compact.keep-turns": "1" } })).toEqual(
      atMint,
    );
    // Keeps more rounds than the dial alone would.
    const narrow = historyBehind(turnWith([...tape, cutoff(1)]), { configFloor: 1, kv: {} });
    expect(atMint.length).toBeGreaterThan(narrow.length);
  });

  it("an unstamped job still follows the live read (hand-built jobs only)", () => {
    const turn = turnWith([...rounds(6), cutoff(null)]);
    const narrow = historyBehind(turn, { configFloor: 1, kv: {} });
    const wide = historyBehind(turn, { configFloor: 4, kv: {} });
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
});

describe("F10: the card is a typed cell", () => {
  it("projects the CompactJob itself, so the Transcript knows it is a prior card", () => {
    const job = cutoff(1);
    const eat = Transcript.fromCells(historyBehind(turnWith([...rounds(4), job])));
    expect(eat.cells[0]).toBe(job);
    expect(eat.checkInCells()).toEqual([job]);
    expect(textOfCell(job)).toBe("CARD");
  });

  it("transcript/compaction-results is no longer always empty for a strategy", async () => {
    const job = new CompactJob({ reason: "overflow", standIn: "PRIOR CARD TEXT", completed: true });
    stampCompactInputs(job, 1, {});
    const eat = Transcript.fromCells(historyBehind(turnWith([...rounds(4), job])));
    const result = await applyCompact(
      `(define (compact t full)
         (list (message/user (if (null? (transcript/compaction-results t)) "none" (chunk-text (car (transcript/compaction-results t)))))))`,
      eat,
      eat,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkIn.map((cell) => textOfCell(cell))).toEqual(["PRIOR CARD TEXT"]);
  });

  it("withoutCheckIns leaves the prior card out of the summarizer blob", () => {
    const job = cutoff(1);
    const eat = Transcript.fromCells(historyBehind(turnWith([...rounds(4), job])));
    expect(eat.cells).toContain(job);
    expect(eat.withoutCheckIns().cells).not.toContain(job);
  });
});
