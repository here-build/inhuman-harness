/**
 * Compact zones. A successful CompactJob is the cutoff: the prefix becomes the card,
 * the squeeze band is stored tool lines, keep stays verbatim, and cells after
 * the job stay on the live tape. A failed job is not a cutoff.
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
import { describe, expect, it } from "vitest";

import { historyBehind, projectCompactRows, sliceCompactZones, Transcript } from "../index.js";

function wrapped(node: CompletionExpectation): CompletionJob {
  return new CompletionJob({ expectation: node });
}

function completion(promptText: string, responseText = ""): CompletionExpectation {
  const node = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`${promptText}`,
  });
  node.responseText = responseText;
  return node;
}

function tool(
  id: string,
  name: string,
  extra: { readonly outcome: string; readonly regenerateable?: boolean },
): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name,
    argsJson: "{}",
    outcomeJson: JSON.stringify({ ok: true, text: extra.outcome }),
    completed: true,
    ...(extra.regenerateable === true ? { regenerateable: true } : {}),
  });
}

function eat(rounds: number): Transcript {
  resetLocalIDs();
  const cells = [];
  for (let i = 0; i < rounds; i += 1) {
    const expectation = completion(`turn ${i}`, "ok");
    expectation.totalTokens = 100 * (i + 1);
    cells.push(expectation, tool(`t${i}`, "shell", { outcome: "ran" }));
  }
  return Transcript.fromCells(cells, 1000 * rounds);
}

describe("compact zones", () => {
  it("one round keeps all", () => {
    const zones = sliceCompactZones(eat(1), { userTurns: 1, rounds: 1 });
    expect({
      prefix: zones.prefix.rounds().length,
      squeeze: zones.squeeze.rounds().length,
      keep: zones.keep.rounds().length,
    }).toEqual({ prefix: 0, squeeze: 0, keep: 1 });
  });

  it("two rounds shrink the squeeze so one round stays in the prefix", () => {
    const zones = sliceCompactZones(eat(2), { userTurns: 1, rounds: 1 });
    expect({
      prefix: zones.prefix.rounds().length,
      squeeze: zones.squeeze.rounds().length,
      keep: zones.keep.rounds().map((round) => round.prompt),
    }).toEqual({ prefix: 1, squeeze: 0, keep: ["turn 1"] });
  });

  it("six rounds keep one, squeeze the one before it, and prefix the rest", () => {
    const zones = sliceCompactZones(eat(6), { userTurns: 1, rounds: 1 });
    expect({
      prefix: zones.prefix.rounds().map((round) => round.prompt),
      squeeze: zones.squeeze.rounds().map((round) => round.prompt),
      keep: zones.keep.rounds().map((round) => round.prompt),
    }).toEqual({
      prefix: ["turn 0", "turn 1", "turn 2", "turn 3"],
      squeeze: ["turn 4"],
      keep: ["turn 5"],
    });
  });

  it("squeeze rows drop regeneratable and empty stamps; keep cells stay the originals", () => {
    resetLocalIDs();
    const fold = completion("fold-user", "fold-asst");
    const foldTool = tool("fold_tool", "shell", { outcome: "FOLD_SECRET" });
    const squeeze = completion("sq-user", "sq-asst");
    const regen = tool("regen", "read_file", { outcome: "SECRET_READ", regenerateable: true });
    const stored = tool("stored", "echo", { outcome: "STORED" });
    const blank = tool("blank", "grep", { outcome: "" });
    const keep = completion("keep-user", "keep-asst");
    const keepTool = tool("keep_tool", "edit_file", { outcome: "KEEP_FULL" });
    const transcript = Transcript.fromCells([fold, foldTool, squeeze, regen, stored, blank, keep, keepTool]);
    const projected = projectCompactRows(transcript, { userTurns: 1, rounds: 1 });
    expect(projected.rows).toEqual([
      { kind: "user", text: "sq-user" },
      { kind: "assistant", text: "sq-asst" },
      { kind: "user", text: "[echo] STORED" },
      { kind: "keep", cell: keep },
      { kind: "keep", cell: keepTool },
    ]);
  });

  it("a cutoff projects the eat; a failure leaves it, and the notice is not history", () => {
    resetLocalIDs();
    const fold = completion("fold-user", "fold-asst");
    const foldTool = tool("fold_tool", "shell", { outcome: "FOLD_SECRET" });
    const squeeze = completion("sq-user", "sq-asst");
    const regen = tool("regen", "read_file", { outcome: "SECRET_READ", regenerateable: true });
    const stored = tool("stored", "echo", { outcome: "STORED" });
    const blank = tool("blank", "grep", { outcome: "" });
    const keep = completion("keep-user", "keep-asst");
    const keepTool = tool("keep_tool", "edit_file", { outcome: "KEEP_FULL" });
    keep.messages = [fold, foldTool, squeeze, regen, stored, blank];
    const cutoff = new CompactJob({ reason: "overflow", standIn: "CARD", completed: true, keepTurns: 1 });
    const folded = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      doneWork: [wrapped(fold), foldTool, wrapped(squeeze), regen, stored, blank, wrapped(keep), keepTool, cutoff],
      queue: [],
    });
    const prior = completion("prior", "old");
    const priorTool = tool("prior_tool", "shell", { outcome: "STILL" });
    const last = completion("last", "here");
    const lastTool = tool("last_tool", "shell", { outcome: "ALSO" });
    last.messages = [prior, priorTool];
    const failed = new CompactJob({
      reason: "overflow",
      failed: true,
      completed: true,
      notice: "couldn't compact — try again later",
    });
    const open = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      doneWork: [wrapped(prior), priorTool, wrapped(last), lastTool, failed],
      queue: [],
    });
    expect({
      cutoff: cutoff.cutoff,
      projected: historyBehind(folded),
      failed: failed.cutoff,
      open: historyBehind(open),
    }).toEqual({
      cutoff: true,
      projected: [cutoff, "sq-user", "sq-asst", "[echo] STORED", keep, keepTool],
      failed: false,
      open: [prior, priorTool, last, lastTool],
    });
  });
});
