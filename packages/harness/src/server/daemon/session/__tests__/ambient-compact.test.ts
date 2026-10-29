/**
 * Ambient compact hangs an isolated completion on the turn. The summary is
 * that completion's responseText — not a second copy on the cutoff job.
 * The caller is not required to wait; a later prefix wins.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { CompletionExpectation, CompletionJob, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import type { CompleteResult } from "@inhuman.tools/harness-provider-sdk";
import { beforeEach, expect, test } from "vitest";

import { keepFloors, sliceCompactEat, historyBehind, Transcript } from "@/context";

import { ambientCutoff, startAmbientCompact } from "../ambient-compact.js";

beforeEach(() => resetLocalIDs());

function round(text: string, used: number): CompletionExpectation {
  const node = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`${text}` });
  node.totalTokens = used;
  node.contextLimit = 100;
  node.responseText = text;
  return node;
}

function summaryOf(turn: SessionTurn): string {
  for (let index = turn.children.length - 1; index >= 0; index -= 1) {
    const child = turn.children[index];
    if (!(child instanceof CompletionJob) || child.expectation.completionMode !== "isolated") continue;
    return child.expectation.responseText.trim();
  }
  return "";
}

function twoRounds(): { readonly turn: SessionTurn; readonly cutoff: CompletionJob } {
  const older = round("older", 20);
  const newer = round("newer", 80);
  newer.messages = [older];
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    doneWork: [new CompletionJob({ expectation: older }), new CompletionJob({ expectation: newer })],
    queue: [],
  });
  const sliced = sliceCompactEat(Transcript.fromCells(historyBehind(turn)), keepFloors(null));
  const cutoff = ambientCutoff(sliced.keep);
  if (cutoff == null) throw new Error("expected a cutoff round");
  return { turn, cutoff };
}

test("settles onto the cutoff without the caller waiting first", async () => {
  const { turn, cutoff } = twoRounds();
  const sliced = sliceCompactEat(Transcript.fromCells(historyBehind(turn)), keepFloors(null));
  let release: (value: CompleteResult) => void = () => {};
  const gate = new Promise<CompleteResult>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const pending = startAmbientCompact({
    home: turn,
    cutoff,
    prefix: sliced.prefix,
    focus: "keep the cutoff",
    connectionId: "c1",
    model: "summarizer",
    inflight: new Map(),
    complete: (req) => {
      calls.push(req.model);
      return gate.then((result) => {
        req.round.succeed("settled", result.text, "null", { result: { text: result.text } });
        return result;
      });
    },
  });
  expect({ calls, queued: turn.queue.length }).toEqual({
    calls: ["summarizer"],
    queued: 0,
  });
  release({ text: "SNAPSHOT" });
  await pending;
  expect(summaryOf(turn)).toBe("SNAPSHOT");
  expect(cutoff.ambientCompactKey).not.toBe("");
  // Finding 12: the run is complete, keeps the result, and no longer holds a copy of the prefix.
  const ambient = turn.children.filter(
    (child): child is CompletionJob =>
      child instanceof CompletionJob && child.expectation.completionMode === "isolated",
  );
  expect(ambient.map((job) => job.completed)).toEqual([true]);
  const stored = ambient[0]!.expectation.promptMessages.map((message) => message.content).join("\n");
  expect(stored).not.toContain("older");
  expect(stored).toContain("keep the cutoff");
  expect(ambient[0]!.expectation.responseText).toBe("SNAPSHOT");
  const replay = startAmbientCompact({
    home: turn,
    cutoff,
    prefix: sliced.prefix,
    focus: "keep the cutoff",
    connectionId: "c1",
    model: "summarizer",
    inflight: new Map(),
    complete: () => {
      calls.push("replay");
      return Promise.resolve({ text: "NO" });
    },
  });
  await replay;
  expect(calls).toEqual(["summarizer"]);
});

test("a newer prefix wins; the late completion does not overwrite it", async () => {
  const { turn, cutoff } = twoRounds();
  const sliced = sliceCompactEat(Transcript.fromCells(historyBehind(turn)), keepFloors(null));
  const inflight = new Map<CompletionJob, string>();
  let releaseFirst: (value: CompleteResult) => void = () => {};
  const firstGate = new Promise<CompleteResult>((resolve) => {
    releaseFirst = resolve;
  });
  const first = startAmbientCompact({
    home: turn,
    cutoff,
    prefix: sliced.prefix,
    focus: "first",
    connectionId: "c1",
    model: "summarizer",
    inflight,
    complete: (req) =>
      firstGate.then((result) => {
        req.round.succeed("settled", result.text, "null", { result: { text: result.text } });
        return result;
      }),
  });
  const second = startAmbientCompact({
    home: turn,
    cutoff,
    prefix: sliced.prefix,
    focus: "second",
    connectionId: "c1",
    model: "summarizer",
    inflight,
    complete: async (req) => {
      req.round.succeed("settled", "SECOND", "null", { result: { text: "SECOND" } });
      return { text: "SECOND" };
    },
  });
  await second;
  releaseFirst({ text: "FIRST" });
  await first;
  expect(summaryOf(turn)).toBe("SECOND");
  expect(cutoff.ambientCompactKey).not.toBe("");
  // The superseded run completes too, and neither keeps the prefix text.
  const ambient = turn.children.filter(
    (child): child is CompletionJob =>
      child instanceof CompletionJob && child.expectation.completionMode === "isolated",
  );
  expect(ambient.map((job) => job.completed)).toEqual([true, true]);
  for (const job of ambient) {
    expect(job.expectation.promptMessages.map((message) => message.content).join("\n")).not.toContain("older");
  }
});
