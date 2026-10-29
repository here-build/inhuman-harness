/**
 * The shipped default compaction program (`compact.scm` + `compact.prompt`)
 * loads through the kernel's loader and runs against a fixture. The model is a
 * stub that records the prompt it was given and answers with a fixed snapshot.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
import { reaction } from "mobx";
import { beforeEach, expect, test } from "vitest";

import { MessageChunk, textOfCell, Transcript } from "@/context";
import { applyCompact } from "@/session";

import { loadCompactProgram } from "../compact.js";

beforeEach(() => resetLocalIDs());

const BIG_OUTPUT = `${"line of a long grep result\n".repeat(220)}END-OF-BIG-OUTPUT`;

function round(
  userText: string,
  answer: string,
  output: string,
  used: number,
): { pew: CompletionExpectation; tool: SystemToolJob } {
  const pew = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${userText}` });
  pew.responseText = answer;
  pew.totalTokens = used;
  pew.contextLimit = 200_000;
  const tool = new SystemToolJob({
    toolCallId: `t-${used}`,
    name: "shell",
    argsJson: JSON.stringify({ command: "grep -rn needle src" }),
    outcomeJson: JSON.stringify({ ok: true, text: output }),
    completed: true,
  });
  return { pew, tool };
}

function fixture(): Transcript {
  const a = round("Fix the login redirect bug in src/auth.ts", "Looking at it.", BIG_OUTPUT, 6_000);
  const b = round("Never touch the billing module", "Understood; patched src/auth.ts.", "ok", 9_000);
  return Transcript.fromCells([a.pew, a.tool, b.pew, b.tool], 200_000);
}

/** Answers each summarizer round with `answer`, recording the prompt it saw. */
function stubModel(turn: SessionTurn, answer: string, seen: string[]): () => void {
  return reaction(
    () => [...turn.children],
    (children) => {
      for (const child of children) {
        if (!(child instanceof CompletionJob) || child.expectation.isDone) continue;
        seen.push(child.expectation.userPrompt);
        child.expectation.succeed("settled", "", "null", { result: { text: answer } });
      }
    },
  );
}

function summarizerTurn(): SessionTurn {
  return new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [] });
}

test("the kernel default resolves to the shipped program, with its prompt, and is not the failsafe", () => {
  const loaded = loadCompactProgram("@inhuman.tools/harness/compact.scm", "/unused");
  expect(loaded.failsafe).toBeUndefined();
  expect(loaded.source).toContain('(require "compact.prompt")');
  expect(loaded.source).not.toContain("(car xs)");
  expect(loaded.sourcePath).not.toBeNull();
  expect(existsSync(join(dirname(loaded.sourcePath!), "compact.prompt"))).toBe(true);
  // No configured path at all also lands on the shipped program.
  expect(loadCompactProgram(undefined, undefined).failsafe).toBeUndefined();
  expect(loadCompactProgram("", "/unused").sourcePath).toBe(loaded.sourcePath);
});

test("a lost configured path falls back to the shipped program, not to keep-first", () => {
  const loaded = loadCompactProgram("./does-not-exist.scm", "/definitely/not/here");
  expect(loaded.failsafe).toBeUndefined();
  expect(loaded.source).toContain('(require "compact.prompt")');
});

test("runs against a fixture: full untrimmed prompt, wrapped card back", async () => {
  const program = loadCompactProgram("@inhuman.tools/harness/compact.scm", "/unused");
  const eat = fixture();
  const turn = summarizerTurn();
  const seen: string[] = [];
  const stop = stubModel(turn, "## Goals & Requests\n- Fix the login redirect bug in src/auth.ts", seen);
  try {
    const result = await applyCompact(program.source, eat, eat, {
      sourcePath: program.sourcePath,
      job: turn,
      connectionId: "c1",
      completionModel: "summarizer-model",
      reason: "overflow",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const card = result.checkIn.map((cell) => textOfCell(cell)).join("\n");
    expect(card).toContain("[CONTEXT SNAPSHOT — REFERENCE ONLY]");
    expect(card).toContain("## Goals & Requests");
    expect(card).toContain("--- END OF CONTEXT SNAPSHOT ---");
    expect(result.checkIn.every((cell) => cell instanceof MessageChunk && cell.checkIn)).toBe(true);
  } finally {
    stop();
  }
  expect(seen).toHaveLength(1);
  const asked = seen[0]!;
  // What the card must preserve is asked for by name.
  for (const section of [
    "Goals & Requests",
    "Constraints & Preferences",
    "Key Decisions & Ruled-Out",
    "Errors & Fixes",
    "Files Touched",
    "Key Findings",
    "Next Steps",
  ]) {
    expect(asked).toContain(section);
  }
  // The summarizer reads the whole prefix, untrimmed.
  expect(asked).toContain("Fix the login redirect bug in src/auth.ts");
  expect(asked).toContain("Never touch the billing module");
  expect(asked).toContain("END-OF-BIG-OUTPUT");
  expect(asked.match(/line of a long grep result/g)).toHaveLength(220);
  expect(asked).not.toContain("CURRENT SNAPSHOT");
});

test("threads the prior card as input state, not as transcript", async () => {
  const program = loadCompactProgram("@inhuman.tools/harness/compact.scm", "/unused");
  const prior = new CompactJob({
    reason: "overflow",
    completed: true,
    standIn: "[CONTEXT SNAPSHOT — REFERENCE ONLY] PRIOR-GOAL-MARKER",
  });
  const a = round("Second task: add a retry", "On it.", "ok", 12_000);
  const b = round("And log the attempts", "Done.", "ok", 14_000);
  const eat = Transcript.fromCells([prior, a.pew, a.tool, b.pew, b.tool], 200_000);
  expect(eat.checkInCells()).toEqual([prior]);
  const turn = summarizerTurn();
  const seen: string[] = [];
  const stop = stubModel(turn, "folded", seen);
  try {
    const result = await applyCompact(program.source, eat, eat, {
      sourcePath: program.sourcePath,
      job: turn,
      connectionId: "c1",
      completionModel: "summarizer-model",
      forced: true,
    });
    expect(result.ok).toBe(true);
  } finally {
    stop();
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("CURRENT SNAPSHOT");
  // Once, as the current snapshot; not again inside the conversation.
  expect(seen[0]!.match(/PRIOR-GOAL-MARKER/g)).toHaveLength(1);
  expect(seen[0]).toContain("Second task: add a retry");
});
