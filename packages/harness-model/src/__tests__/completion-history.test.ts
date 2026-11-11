import { DocumentContainer, hydrateModel, serializeModel, type SerializedDocumentNode } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { CompletionExpectation, CompletionJob, SessionRoot, SessionSystemPrompt, SessionTurn } from "../index.js";

describe("completion history tails", () => {
  it("reads legacy embedded history and writes tail pointers", () => {
    const first: SerializedDocumentNode = {
      uuid: "legacy-first",
      tag: "harness:expectation:completion",
      columns: {},
      state: { connectionId: "test", messages: ["old"] },
      refs: {},
      refLists: {},
      children: {},
      childLists: {},
    };
    const second: SerializedDocumentNode = {
      ...first,
      uuid: "legacy-second",
      state: { connectionId: "test", messages: ["old", first, "new"] },
    };
    const restored = hydrateModel<CompletionExpectation>(second);
    expect(restored.historyTail?.uuid).toBe(first.uuid);
    expect(restored.messageCells.map((cell) => (typeof cell === "string" ? cell : cell.uuid))).toEqual([
      first.uuid,
      "new",
    ]);
    const normalized = serializeModel(restored);
    expect(Object.keys(normalized.nodes)).toHaveLength(2);
    expect(normalized.nodes[restored.uuid].state).not.toHaveProperty("messages");
    expect(normalized.nodes[restored.uuid].refs.historyTail).toBe(first.uuid);
  });

  it("stores only a predecessor pointer and the new cells while retaining cumulative history", () => {
    const first = new CompletionExpectation({ connectionId: "test", messages: ["first"] });
    const second = new CompletionExpectation({ connectionId: "test", messages: [...first.messages, first, "second"] });
    const third = new CompletionExpectation({ connectionId: "test", messages: [...second.messages, second, "third"] });
    expect(third.historyTail).toBe(second);
    expect(third.messageCells).toEqual([second, "third"]);
    expect(third.messages).toEqual(["first", first, "second", second, "third"]);
    const restored = hydrateModel<CompletionExpectation>(serializeModel(third));
    expect(restored.historyTail?.historyTail).not.toBeNull();
    expect(restored.messages.map((cell) => (typeof cell === "string" ? cell : cell.uuid))).toEqual(
      third.messages.map((cell) => (typeof cell === "string" ? cell : cell.uuid)),
    );
  });

  it("persists a long session with linear snapshot size and bounded round patches", () => {
    const root = new SessionRoot({ sessionId: "normalized-history" });
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [] });
    root.head = turn;
    const source = new DocumentContainer(root);
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    const sizes: number[] = [];
    source.on("update", (update) => {
      sizes.push(update.length);
      replica.applyUpdate(update);
    });
    let previous: CompletionExpectation | null = null;
    for (let index = 0; index < 100; index++) {
      const round: CompletionExpectation = new CompletionExpectation({
        connectionId: "test",
        messages: previous === null ? ["start"] : [...previous.messages, previous, `note ${index}`],
      });
      source.transact(() => turn.enqueue(new CompletionJob({ expectation: round })));
      previous = round;
    }
    const encoded = source.encodeStateAsUpdate();
    expect(encoded.length).toBeLessThan(1_000_000);
    expect(Math.max(...sizes)).toBeLessThan(20_000);
    const restored = hydrateModel<SessionRoot>(replica.toSnapshot());
    const last = restored.head?.queue.at(-1);
    expect(last).toBeInstanceOf(CompletionJob);
    if (!(last instanceof CompletionJob)) throw new Error("missing completion");
    expect(last.expectation.messages).toHaveLength(199);
    expect(last.expectation.historyTail?.uuid).toBe(previous?.historyTail?.uuid);
    source.destroy();
    replica.destroy();
  });

  it("starts a new tail when compaction replaces the prefix", () => {
    const first = new CompletionExpectation({ connectionId: "test", messages: ["old"] });
    const next = new CompletionExpectation({ connectionId: "test", messages: ["summary", first, "new"] });
    expect(next.historyTail).toBeNull();
    expect(next.messages).toEqual(["summary", first, "new"]);
  });
});
