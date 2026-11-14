import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  RegisteredToolsSet,
  SessionDocument,
  SessionSystemPrompt,
  SessionTurn,
  ToolSpec,
} from "@inhuman.tools/harness-model";
import { describe, expect, it, onTestFinished } from "vitest";

import {
  bindSessionCatalog,
  KernelToolCatalog,
  type CatalogEntry,
  type ToolRepresentation,
} from "../../tool-catalog/index.js";
import { selectCompletionTools } from "../index.js";

function packEntry(wireName: string, representation: ToolRepresentation = "symbol"): CatalogEntry {
  return {
    wireName,
    description: `${wireName} live`,
    parameters: { type: "object", properties: {} },
    class: "effect",
    representation,
    source: { kind: "pack", pluginName: "pack" },
  };
}

function mount(
  id: string,
  extra?: { frozen?: string; catalog?: KernelToolCatalog; inbound?: boolean; open?: readonly string[] },
): CompletionExpectation {
  const doc = SessionDocument.create(id);
  onTestFinished(() => doc.destroy());
  const completion = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`q`,
  });
  const job = new CompletionJob({ expectation: completion });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`q`,
    queue: [],
    ...(extra?.inbound === true ? { inbound: true, agentRequestId: "req-0" } : {}),
    ...(extra?.frozen === undefined
      ? {}
      : {
          toolsDefinition: new RegisteredToolsSet({
            entries: [
              new ToolSpec({
                name: extra.frozen,
                description: "frozen",
                argsJson: '{"type":"object"}',
              }),
            ],
          }),
        }),
  });
  turn.enqueue(job);
  turn.doneWork.push(turn.queue.shift()!);
  doc.root.head = turn;
  for (const callId of extra?.open ?? []) doc.root.agentCallbacks[callId] = "caller";
  if (extra?.catalog != null) bindSessionCatalog(doc.root, extra.catalog);
  return completion;
}

describe("selectCompletionTools", () => {
  it("uses frozen turn tools when present, not the live catalog", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([packEntry("live_only"), packEntry("write_file")]);
    const completion = mount("frozen-wins", { frozen: "frozen_only", catalog });
    expect(selectCompletionTools(completion, catalog).map((tool) => tool.name)).toEqual(["frozen_only"]);
  });

  it("falls back to the live catalog when the turn has no frozen set", () => {
    const catalog = new KernelToolCatalog();
    catalog.replacePack([packEntry("write_file", "both"), packEntry("shell", "both")]);
    const completion = mount("live-fallback", { catalog });
    expect(
      selectCompletionTools(completion, catalog)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["shell", "write_file"]);
  });

  it("isolated completions have no tools", () => {
    const completion = new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptText: prompt.user`q`,
    });
    const doc = SessionDocument.create("isolated-tools");
    onTestFinished(() => doc.destroy());
    doc.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`q`,
      queue: [new CompletionJob({ expectation: completion })],
    });
    expect(selectCompletionTools(completion)).toEqual([]);
  });

  describe("agent__respond", () => {
    const withRespond = (extra: Parameters<typeof mount>[1]) => {
      const catalog = new KernelToolCatalog();
      catalog.replacePack([packEntry("write_file", "both"), packEntry("agent__respond", "tool")]);
      const completion = mount(`respond-${Math.random()}`, { catalog, ...extra });
      return selectCompletionTools(completion, catalog).filter((tool) => tool.name === "agent__respond");
    };

    it("is one fixed tool whether zero, one or two calls are open, once the session has taken a call", () => {
      const none = withRespond({ inbound: true, open: [] });
      const one = withRespond({ inbound: true, open: ["a"] });
      const two = withRespond({ inbound: true, open: ["a", "b"] });
      expect(none).toHaveLength(1);
      expect(JSON.stringify(one)).toBe(JSON.stringify(none));
      expect(JSON.stringify(two)).toBe(JSON.stringify(none));
      expect(JSON.stringify(none)).not.toContain('"enum"');
      expect(JSON.stringify(none)).not.toMatch(/\ba\b.+\bb\b/);
    });

    it("is absent from a session that has never taken a call", () => {
      expect(withRespond({})).toEqual([]);
    });
  });
});
