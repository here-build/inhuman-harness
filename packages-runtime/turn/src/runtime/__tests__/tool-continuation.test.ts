import invariant from "tiny-invariant";
import { prompt, type ToolContinuation } from "@inhuman.tools/harness-commons";
import {
  admitSteer,
  CompletionExpectation,
  CompletionJob,
  decideRound,
  METADATA_SAME_ROUND_NOTE,
  ReACTChunk,
  responseCall,
  SystemToolJob,
} from "@inhuman.tools/harness-model/session";
import { expect, it } from "vitest";

import { turnFixture } from "./fixtures/turn-iterator.js";
import { catalogOf } from "../../tool-catalog/bindings.js";
import { boundaryNote } from "../round-boundary.js";

function policies(f: ReturnType<typeof turnFixture>, tools: Readonly<Record<string, ToolContinuation>>) {
  const catalog = catalogOf(f.session);
  invariant(catalog != null, "missing fixture catalog");
  catalog.replacePack([
    ...catalog.catalogEntries(),
    ...Object.entries(tools).map(([wireName, continuation]) => ({
      wireName,
      description: wireName,
      parameters: {},
      class: "effect",
      source: { kind: "pack", pluginName: "test" } as const,
      continuation,
    })),
  ]);
  return catalog;
}

it.each([
  { kind: "observation", speech: "Done", rounds: 2 },
  { kind: "auxiliary", speech: "", rounds: 2 },
  { kind: "auxiliary", speech: "Done", rounds: 1 },
  { kind: "none", speech: "", rounds: 1 },
] as const)("$kind with speech '$speech' produces $rounds rounds", async ({ kind, speech, rounds }) => {
  const f = turnFixture(
    (completion) => {
      completion.responseText = speech;
      completion.responseCalls.push(responseCall("custom", "custom", "{}"));
    },
    (completion) => {
      completion.responseText = "Finished";
    },
  );
  policies(f, { custom: { kind } });
  await f.run();
  expect(f.completions()).toHaveLength(rounds);
});

it("combines auxiliary requests once, deduplicates notes, and retains the admitted policy across catalog changes", async () => {
  const f = turnFixture(
    (completion) => {
      completion.responseCalls.push(
        responseCall("a", "first", "{}"),
        responseCall("b", "second", "{}"),
        responseCall("c", "third", "{}"),
      );
    },
    (completion) => {
      completion.responseText = "Finished";
    },
  );
  const catalog = policies(f, {
    first: { kind: "auxiliary", note: "Resume the task." },
    second: { kind: "auxiliary", note: "Resume the task." },
    third: { kind: "auxiliary", note: "Keep the answer visible." },
  });
  const resolve = f.resolvers.work.getMockImplementation();
  invariant(resolve != null, "missing resolver");
  f.resolvers.work.mockImplementation(async (job, signal) => {
    catalog.replacePack([]);
    return resolve(job, signal);
  });
  await f.run();
  expect(f.completions()).toHaveLength(2);
  expect(f.completions()[1]?.expectation.systemNote).toBe("Resume the task.\n\nKeep the answer visible.");
  const boundary = f.turn.doneWork.find((cell) => cell instanceof ReACTChunk);
  expect(boundary?.decision?.causes).toEqual([
    {
      kind: "auxiliary-repair",
      sources: f.resolvers.work.mock.calls.map(([job]) => job.uuid),
    },
  ]);
});

it("observation work authorizes one round without auxiliary repair notes, and none does not veto it", async () => {
  const f = turnFixture(
    (completion) => {
      completion.responseCalls.push(
        responseCall("a", "observe", "{}"),
        responseCall("b", "bookkeep", "{}"),
        responseCall("c", "silent", "{}"),
      );
    },
    (completion) => {
      completion.responseText = "Finished";
    },
  );
  policies(f, {
    observe: { kind: "observation" },
    bookkeep: { kind: "auxiliary", note: "Should not appear" },
    silent: { kind: "none" },
  });
  await f.run();
  expect(f.completions()).toHaveLength(2);
  expect(f.completions()[1]?.expectation.systemNote).toBe("");
});

it("none does not veto new user input", async () => {
  const f = turnFixture(
    (completion) => {
      completion.responseText = "Finished";
      completion.responseCalls.push(responseCall("s", "silent", "{}"));
      admitSteer(f.session, prompt.user`one more thing`, f.turn.uuid);
    },
    (completion) => {
      completion.responseText = "Handled";
    },
  );
  policies(f, { silent: { kind: "none" } });
  await f.run();
  expect(f.completions()).toHaveLength(2);
});

it.each([true, false])("repeated auxiliary success=%s cannot reset the repair budget", async (ok) => {
  const f = turnFixture(
    ...Array.from({ length: 10 }, () => (completion: CompletionExpectation) => {
      completion.responseCalls.push(responseCall("a", "custom", "{}"));
    }),
  );
  policies(f, { custom: { kind: "auxiliary", note: "Resume" } });
  f.resolvers.work.mockImplementation(async (job) => {
    job.outcomeSnap = { ok };
    job.markComplete();
    return "settled";
  });
  await f.run();
  expect(f.completions()).toHaveLength(5);
  expect(f.turn.doneWork.findLast((cell) => cell instanceof ReACTChunk)?.decision?.reason).toBe("trigger-budget");
});

it("omits exhausted auxiliary notes and recovers legacy completion-sourced auxiliary notes", () => {
  const f = turnFixture();
  const source = new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "mock" }) });
  const job = new SystemToolJob({ name: "update_metadata", triggersReactLoop: false, toolCallId: "a" });
  const boundary = new ReACTChunk({ source });
  source.responseWork.push(job);
  f.turn.doneWork.push(source, job, boundary);
  boundary.decision = decideRound([
    { cause: { kind: "auxiliary-repair", sources: [job.uuid] }, budget: { used: 4, limit: 4 } },
    { cause: { kind: "input", sources: ["input"] } },
  ]);
  expect(boundaryNote(f.turn, boundary, f.host).note).toBe("");
  boundary.decision = decideRound([{ cause: { kind: "auxiliary-repair", sources: [source.uuid] } }]);
  expect(boundaryNote(f.turn, boundary, f.host).note).toBe(METADATA_SAME_ROUND_NOTE);
});
