import { Plexus } from "@here.build/plexus";
import {
  CompletionExpectation,
  CompletionJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { pluginProgress } from "../../../../harness-transcript/src/plugin-progress.js";
import { sessionBeats } from "../../../../harness-transcript/src/session-beats.js";

const snapshot = (actions: object[], owner = "tasks:state") => ({ [owner]: JSON.stringify(actions) });
const create = (id: string, subject = id) => ({ type: "create", "task-id": id, subject, program: "saved exam" });
const action = (type: string, id: string, extra = {}) => ({ type, "task-id": id, ...extra });

describe("committed plugin progress", () => {
  it("shows real task transitions including failed validation and active task demotion", () => {
    const actions = [create("a", "First task"), create("b", "Second task"), action("start", "a")];
    const before = snapshot(actions);
    const items = pluginProgress(
      before,
      snapshot([
        ...actions,
        action("start", "b"),
        action("limbo", "b"),
        action("verdict", "b", { ok: false }),
        action("start", "b"),
        action("verdict", "b", { ok: true }),
        action("drop", "a", { reason: "not needed" }),
      ]),
    );
    expect(items.map(({ label, detail }) => [label, detail])).toEqual([
      ["First task", "pending"],
      ["Second task", "active"],
      ["Second task", "limbo"],
      ["Second task", "pending"],
      ["Second task", "active"],
      ["Second task", "completed"],
      ["First task", "dropped · not needed"],
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("does not emit reducer no-ops or malformed/replaced logs", () => {
    const actions = [create("a"), action("start", "a")];
    expect(
      pluginProgress(
        snapshot(actions),
        snapshot([...actions, create("a"), action("start", "a"), action("start", "missing")]),
      ),
    ).toEqual([]);
    expect(pluginProgress(snapshot(actions), snapshot([]))).toEqual([]);
    expect(pluginProgress(snapshot(actions), snapshot([create("b")]))).toEqual([]);
    expect(pluginProgress({}, { "tasks:state": "not json" })).toEqual([]);
    expect(pluginProgress({}, { "tasks:state": "[null]" })).toEqual([]);
    expect(pluginProgress({}, { "tasks:state": "{}" })).toEqual([]);
  });

  it("distinguishes exhausted, blocked and cleared goals from completion", () => {
    const items = pluginProgress(
      {},
      snapshot(
        [
          { type: "set", text: "Ship", loops: 1 },
          { type: "tick" },
          { type: "block" },
          { type: "clear" },
          { type: "clear" },
        ],
        "inhuman-plugin-goal:state",
      ),
    );
    expect(items.map((item) => item.detail)).toEqual([
      "active · 1 loops left · Ship",
      "exhausted · 0 loops left · Ship",
      "blocked · 0 loops left · Ship",
      "cleared",
    ]);
    expect(items.some((item) => /completed|done/.test(item.detail))).toBe(false);
  });

  it("keeps historical subjects, uses live head state, and removes rewound transitions", () => {
    const before = [create("a", "Sidebar task"), action("start", "a")];
    const expectation = new CompletionExpectation({ connectionId: "test" });
    expectation.responseText = "Working";
    const speech = new CompletionJob({ expectation });
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [speech],
      reducerExited: true,
    });
    older.pushChild(speech);
    older.pluginState = snapshot(before);
    const head = new SessionTurn({ turnTail: older, queue: [], doneWork: [] });
    const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
    root.head = head;
    root.pluginState = snapshot([...before, action("verdict", "a", { ok: true })]);
    const doc = Plexus.bootstrap(root);
    try {
      const items = () => sessionBeats(root).flatMap((beat) => beat.mark?.items ?? []);
      expect(items().map((item) => [item.label, item.detail])).toEqual([
        ["Sidebar task", "pending"],
        ["Sidebar task", "active"],
        ["Sidebar task", "completed"],
      ]);
      expect(sessionBeats(root).at(-1)?.turn).toBe(head);
      root.head = older;
      root.pluginState = snapshot(before);
      expect(items().map((item) => item.detail)).toEqual(["pending", "active"]);
    } finally {
      doc.destroy();
    }
  });
});
