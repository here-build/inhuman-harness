import { SessionOverview } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { agentSpans, groupBeats, modelSpans, stickyBeats, type TapeBeat } from "../tape-beats.js";
import { agentFace, type AgentCell } from "../tape-read.js";

function beat(id: string, title = false, thought = false, model = ""): TapeBeat {
  return {
    id,
    mark: title ? { title: id, description: "", items: [] } : null,
    model,
    connection: model === "" ? "" : "grok",
    cells: [],
    thoughts: thought ? [{ id: `${id}:thought`, text: id }] : [],
    agents: [],
    settles: [],
  };
}

describe("sticky side-note spans", () => {
  it("ends each span at the next entity in its own lane, not the next round", () => {
    const beats = [beat("one", true, true), beat("two"), beat("three", false, true), beat("four", true), beat("five")];
    const spans = stickyBeats(beats);
    expect(spans.map(({ row, titleEnd, thoughtsEnd }) => [row, titleEnd, thoughtsEnd])).toEqual([
      [1, 4, 3],
      [2, 4, 3],
      [3, 4, 6],
      [4, 6, 6],
      [5, 6, 6],
    ]);
    expect(spans.map(({ id }) => id)).toEqual(beats.map(({ id }) => id));
    expect(beats[0]).not.toHaveProperty("row");
  });

  it("supports empty tapes, adjacent anchors, and notes extending to the tape end", () => {
    expect(stickyBeats([])).toEqual([]);
    expect(stickyBeats([beat("one", true, true), beat("two", true, true)])).toMatchObject([
      { row: 1, titleEnd: 2, thoughtsEnd: 2 },
      { row: 2, titleEnd: 3, thoughtsEnd: 3 },
    ]);
  });

  it("preserves thought-only rounds and recomputes endpoints as new notes arrive", () => {
    const initial = groupBeats([
      { kind: "round", id: "one" },
      { kind: "speech", id: "thought", text: "", thought: "Long reasoning" },
      { kind: "round", id: "two" },
      { kind: "speech", id: "answer", text: "Answer", thought: "" },
    ]);
    expect(stickyBeats(initial)[0]).toMatchObject({ thoughtsEnd: 3, cells: [] });
    const appended = [...initial, beat("three", false, true)];
    expect(stickyBeats(appended)[0].thoughtsEnd).toBe(3);
    expect(stickyBeats(appended)[2].thoughtsEnd).toBe(4);
    expect(stickyBeats(initial)[0].thoughtsEnd).toBe(3);
  });

  it("spans consecutive rounds on one model, across the ask between them", () => {
    const spans = modelSpans([
      beat("ask"),
      beat("one", true, false, "grok-4.7"),
      beat("two", false, false, "grok-4.7"),
      beat("ask-again"),
      beat("three", false, false, "grok-4.7"),
      beat("four", false, false, "gpt-6.1-sol"),
      beat("five", false, false, "grok-4.7"),
    ]);
    expect(spans.map(({ modelSpan }) => (modelSpan == null ? null : [modelSpan.model, modelSpan.lastRow]))).toEqual([
      null,
      ["grok-4.7", 5],
      null,
      null,
      null,
      ["gpt-6.1-sol", 6],
      ["grok-4.7", 7],
    ]);
    // The model lane is its own: a span never ends a progress note's.
    expect(stickyBeats(spans).map(({ titleEnd }) => titleEnd)).toEqual([2, 8, 8, 8, 8, 8, 8]);
  });

  it("splits a span when the same model runs on another connection", () => {
    const spans = modelSpans([
      { ...beat("one", false, false, "gpt-6.1-sol"), connection: "chatgpt" },
      { ...beat("two", false, false, "gpt-6.1-sol"), connection: "openrouter" },
    ]);
    expect(spans.map(({ modelSpan }) => modelSpan?.connection)).toEqual(["chatgpt", "openrouter"]);
  });

  it("keeps each round's model on its beat", () => {
    expect(
      groupBeats([
        { kind: "user", id: "ask", text: "Hello" },
        { kind: "round", id: "one", model: "grok-4.7", connection: "grok" },
        { kind: "speech", id: "answer", text: "Hi", thought: "" },
      ]).map(({ id, model, connection }) => [id, model, connection]),
    ).toEqual([
      ["ask", "", ""],
      ["one", "grok-4.7", "grok"],
    ]);
  });
});

describe("agent spans", () => {
  const mark = (id: string, background: boolean, live: boolean) => ({ id, background, live });
  const at = (agents: ReturnType<typeof mark>[], settles: string[] = []) => ({ agents, settles });

  it("closes a call that waited in its own round, a sent one where its result is claimed, and holds the rest open", () => {
    const spans = agentSpans([
      at([mark("waited", false, false), mark("sent", true, false), mark("out", true, true)]),
      at([]),
      at([], ["sent"]),
      at([mark("still", false, true)]),
    ]);
    expect(spans.flatMap(({ agentSpans: made }) => made.map(({ id, lastRow }) => [id, lastRow]))).toEqual([
      ["waited", 1],
      ["sent", 3],
      ["out", null],
      ["still", null],
    ]);
  });

  it("keeps a finished background call open until a round claims its result", () => {
    expect(agentSpans([at([mark("done", true, false)])])[0].agentSpans).toEqual([{ id: "done", lastRow: null }]);
  });
});

describe("agent face", () => {
  const cell = (outcome: AgentCell["outcome"]): AgentCell => ({
    kind: "agent",
    id: "call",
    sessionId: "worker",
    spec: "explore",
    message: "Map the paint path",
    background: true,
    outcome,
  });

  it("takes the worker's title and status from its glance", () => {
    const glance = new SessionOverview({
      title: "Why paint is slow",
      model: "grok-4.7",
      status: "Reading vite.config.ts",
    });
    expect(agentFace(cell("live"), glance)).toEqual({
      name: "explore",
      model: "grok-4.7",
      task: "Why paint is slow",
      status: "Reading vite.config.ts",
      state: "live",
    });
  });

  it("falls back to the spawn message before the worker has a title", () => {
    expect(agentFace(cell("live"), null)).toMatchObject({ task: "Map the paint path", status: "" });
  });

  it("says what a live worker asks, and nothing once it is done", () => {
    const glance = new SessionOverview({ asking: true, unfinished: "ask", askLine: "run pnpm test" });
    expect(agentFace(cell("live"), glance)).toMatchObject({ state: "asking", status: "run pnpm test" });
    expect(agentFace(cell("ok"), glance)).toMatchObject({ state: "ok", status: "" });
    expect(agentFace(cell("cancelled"), glance)).toMatchObject({ state: "cancelled", status: "" });
  });
});
