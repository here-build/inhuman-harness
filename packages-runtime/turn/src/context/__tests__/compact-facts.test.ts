/**
 * A CompactJob's cut is a fact of the job (F8), and its card is a typed cell
 * that later compactions can recognise (F10).
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  ContextNeedToolJob,
  ProgrammaticJob,
  CompactJob,
  CompletionExpectation,
  CompletionJob,
  SessionSystemPrompt,
  SessionTurn,
  SessionPlexus,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

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

it.each(["direct", "program", "wrapper"])(
  "compacts %s spawn history without source while retaining mixed receipts",
  async (shape) => {
    const brief = "PRIVATE-SPAWN-BRIEF all detailed instructions must stay on the worker";
    const child = new AgentCallJob({
      toolCallId: "spawn",
      name: "agent__ask",
      workerSessionId: "worker-1",
      argsJson: JSON.stringify({ message: brief, description: "Inspect the module." }),
      completed: true,
    });
    child.outcomeSnap = { ok: true, value: "worker receipt" };
    const read = new SystemToolJob({
      toolCallId: "read",
      name: "read_file",
      argsJson: '{"path":"src/module.ts"}',
      outcomeJson: '{"ok":true,"text":"non-agent receipt"}',
      completed: true,
    });
    const context = new ContextNeedToolJob({
      toolCallId: "context",
      argsJson: '{"reason":"SILENT_CONTEXT_REASON","needed":true}',
      outcomeJson: '{"ok":true,"text":"SILENT_CONTEXT_RECEIPT"}',
      completed: true,
    });
    const nested = new ProgrammaticJob({
      toolCallId: "nested",
      argsJson: JSON.stringify({ expr: `(agent/ask 'explore "${brief}")` }),
      children: [child, read, context],
      completed: true,
      outcomeJson: '{"ok":false,"text":"caught nested failure"}',
    });
    const program = new ProgrammaticJob({
      toolCallId: "program",
      argsJson: JSON.stringify({ expr: brief }),
      children: [nested],
      completed: true,
      outcomeJson: '{"ok":true,"text":"outer receipt"}',
    });
    const sibling = new ProgrammaticJob({
      toolCallId: "sibling",
      argsJson: JSON.stringify({ expr: brief }),
      completed: true,
      outcomeJson: '{"ok":true,"text":"first program receipt"}',
    });
    const wrapper = new SystemToolJob({
      toolCallId: "wrapper",
      name: "scheme_repl",
      argsJson: JSON.stringify({ expr: brief }),
      completed: true,
      outcomeJson: '{"ok":true,"text":"wrapper receipt"}',
    });
    wrapper.registerJob(sibling);
    wrapper.registerJob(program);
    const cell = shape === "direct" ? child : shape === "program" ? program : wrapper;
    const gauge = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`request` });
    gauge.totalTokens = 10000;
    const plexus = SessionPlexus.create(`compact-spawn-${shape}`, "");
    onTestFinished(() => plexus.destroy());
    plexus.root.head = turnWith([new CompletionJob({ expectation: gauge }), cell]);
    const transcript = Transcript.fromCells([gauge, cell]);
    const projected: Record<string, unknown> = {};
    for (const [name, expression] of [
      ["chunk-text", "(chunk-text (car (cdr (transcript/cells t))))"],
      ["summarizer", "(message/transcript-as-single-prompt t)"],
    ]) {
      const compacted = await applyCompact(
        `(define (compact t full) (list (message/user ${expression})))`,
        transcript,
        transcript,
      );
      const text = compacted.ok ? compacted.checkIn.map(textOfCell).join("\n") : compacted.reason;
      projected[name!] = {
        ok: compacted.ok,
        leaked: text.includes("PRIVATE-SPAWN-BRIEF"),
        description: text.includes("Inspect the module."),
        worker: text.includes("worker-1"),
        receipts: [
          "worker receipt",
          "non-agent receipt",
          "caught nested failure",
          "outer receipt",
          "first program receipt",
          "wrapper receipt",
        ].filter((receipt) => text.includes(receipt)),
        readPath: text.includes("src/module.ts"),
        context: text.includes("SILENT_CONTEXT"),
      };
    }
    const expected = {
      ok: true,
      leaked: false,
      description: true,
      worker: true,
      receipts:
        shape === "direct"
          ? ["worker receipt"]
          : shape === "program"
            ? ["worker receipt", "non-agent receipt", "caught nested failure", "outer receipt"]
            : [
                "worker receipt",
                "non-agent receipt",
                "caught nested failure",
                "outer receipt",
                "first program receipt",
                "wrapper receipt",
              ],
      readPath: shape !== "direct",
      context: false,
    };
    expect({ projected, stored: [program.expr, sibling.expr, child.speech] }).toEqual({
      projected: { "chunk-text": expected, summarizer: expected },
      stored: [brief, brief, brief],
    });
    child.outcomeSnap = { ok: true, value: "LARGE_WORKER_RECEIPT ".repeat(1000) };
    const bounded = await applyCompact(
      `(define (compact t full) (list (message/user (message/transcript-as-single-prompt t))))`,
      transcript,
      transcript,
    );
    const boundedText = bounded.ok ? bounded.checkIn.map(textOfCell).join("\n") : bounded.reason;
    expect({
      ok: bounded.ok,
      bounded: boundedText.length <= 5300,
      recall: boundedText.includes("context_recall"),
      description: boundedText.includes("Inspect the module."),
      worker: boundedText.includes("worker-1"),
      leaked: boundedText.includes("PRIVATE-SPAWN-BRIEF"),
    }).toEqual({ ok: true, bounded: true, recall: true, description: true, worker: true, leaked: false });
  },
);
