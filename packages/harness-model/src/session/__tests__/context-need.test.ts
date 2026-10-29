/**
 * ContextNeed parse and turn derivation. A SystemToolJob with this name is
 * not the need — admit must mint ContextNeedToolJob.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, expect, test } from "vitest";

import { CONTEXT_NEED_FOCUS_MAX_CHARS, contextNeedAdmitSchema } from "../../schemas/index.js";
import { CONTEXT_NEED_TOOL_NAME, type ContextNeed } from "../context-need.js";
import { CompactJob } from "../jobs/CompactJob.js";
import { ContextNeedToolJob } from "../jobs/ContextNeedToolJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";

beforeEach(() => resetLocalIDs());

function need(id: string, args: Record<string, unknown>): ContextNeedToolJob {
  return new ContextNeedToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: id,
    name: CONTEXT_NEED_TOOL_NAME,
    argsJson: JSON.stringify(args),
  });
}

function parseContextNeedArgs(argsJson: unknown): ContextNeed | null {
  const parsed = contextNeedAdmitSchema.safeParse(argsJson);
  return parsed.success ? parsed.data : null;
}

function turnOf(...chunks: SessionTurn["queue"]): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: chunks,
    queue: [],
  });
}

test("parseContextNeedArgs: operands, rejection, clamps", () => {
  const long = "f".repeat(CONTEXT_NEED_FOCUS_MAX_CHARS + 20);
  expect({
    tokens: parseContextNeedArgs(JSON.stringify({ min_remaining_tokens: 8000 })),
    settled: parseContextNeedArgs(JSON.stringify({ current_phase_settled: true })),
    both: parseContextNeedArgs(
      JSON.stringify({
        min_remaining_tokens: 100,
        current_phase_settled: true,
        preserve: { user_turns: 2, rounds: 8 },
        focus: "  keep the cutoff  ",
      }),
    ),
    focusClamp: parseContextNeedArgs(JSON.stringify({ min_remaining_tokens: 1, focus: long }))?.focus?.length,
    empty: parseContextNeedArgs("{}"),
    garbage: parseContextNeedArgs("not-json"),
    settledFalse: parseContextNeedArgs(JSON.stringify({ current_phase_settled: false })),
    preserveOnly: parseContextNeedArgs(JSON.stringify({ preserve: { user_turns: 2 } })),
    negative: parseContextNeedArgs(JSON.stringify({ min_remaining_tokens: -1 })),
    float: parseContextNeedArgs(JSON.stringify({ min_remaining_tokens: 1.5 })),
  }).toEqual({
    tokens: { min_remaining_tokens: 8000 },
    settled: { current_phase_settled: true },
    both: {
      min_remaining_tokens: 100,
      current_phase_settled: true,
      preserve: { user_turns: 2, rounds: 8 },
      focus: "keep the cutoff",
    },
    focusClamp: CONTEXT_NEED_FOCUS_MAX_CHARS,
    empty: null,
    garbage: null,
    settledFalse: null,
    preserveOnly: null,
    negative: null,
    float: null,
  });
});

test("SessionTurn.contextNeed: own, inherit, cutoff consume, last valid", () => {
  const first = need("n1", { min_remaining_tokens: 1000 });
  const second = need("n2", { min_remaining_tokens: 2000, focus: "later" });
  const invalid = need("bad", { current_phase_settled: false });
  const impostor = new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: "fake",
    name: CONTEXT_NEED_TOOL_NAME,
    argsJson: JSON.stringify({ min_remaining_tokens: 9999 }),
  });
  const unfolded = new CompactJob();
  const committed = new CompactJob({ completed: true, standIn: "summary" });
  const cutoff = new CompactJob({ reason: "overflow", standIn: "card", completed: true });
  const failed = new CompactJob({
    reason: "overflow",
    failed: true,
    completed: true,
    notice: "couldn't compact — try again later",
  });

  const own = turnOf(first);
  const lastWins = turnOf(first, invalid, second);
  const afterUnfolded = turnOf(first, unfolded);
  const spent = turnOf(first, committed);
  const afterCutoff = turnOf(first, committed, second);
  const spentJob = turnOf(first, cutoff);
  const failedKeeps = turnOf(first, failed);
  const child = new SessionTurn({
    turnTail: own,
    prompt: prompt.user`next`,
    doneWork: [],
    queue: [],
  });
  const childAfterCutoff = new SessionTurn({
    turnTail: spent,
    prompt: prompt.user`next`,
    doneWork: [],
    queue: [],
  });
  const namedWrong = turnOf(impostor);

  expect({
    own: own.contextNeed,
    lastWins: lastWins.contextNeed,
    unfolded: afterUnfolded.contextNeed,
    spent: spent.contextNeed,
    afterCutoff: afterCutoff.contextNeed,
    spentJob: spentJob.contextNeed,
    failedKeeps: failedKeeps.contextNeed,
    inherit: child.contextNeed,
    inheritSpent: childAfterCutoff.contextNeed,
    impostor: namedWrong.contextNeed,
  }).toEqual({
    own: { min_remaining_tokens: 1000 },
    lastWins: { min_remaining_tokens: 2000, focus: "later" },
    unfolded: { min_remaining_tokens: 1000 },
    spent: null,
    afterCutoff: { min_remaining_tokens: 2000, focus: "later" },
    spentJob: null,
    failedKeeps: { min_remaining_tokens: 1000 },
    inherit: { min_remaining_tokens: 1000 },
    inheritSpent: null,
    impostor: null,
  });
});
