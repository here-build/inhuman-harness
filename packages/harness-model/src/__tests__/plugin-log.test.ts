import { DocumentContainer, hydrateModel, serializeModel } from "@inhuman.tools/model";
import { describe, expect, it } from "vitest";

import { PluginAction, SessionRoot, SessionSystemPrompt, SessionTurn } from "../index.js";

describe("plugin log tails", () => {
  it("stores each action once across turn checkpoints and branches from a rewind", () => {
    const root = new SessionRoot({ sessionId: "plugin-tails" });
    let tail: SessionTurn | SessionSystemPrompt = new SessionSystemPrompt();
    const actions: Array<{ n: number; text: string }> = [];
    const turns: SessionTurn[] = [];
    for (let n = 0; n < 30; n++) {
      actions.push({ n, text: "x".repeat(1000) });
      root.writePluginLog("test:state", JSON.stringify(actions));
      const turn: SessionTurn = new SessionTurn({ turnTail: tail, queue: [] });
      turn.recordPluginState(root.pluginHeads);
      turns.push(turn);
      tail = turn;
    }
    root.head = turns.at(-1) ?? null;
    const doc = new DocumentContainer(root);
    expect(doc.getAllOfType(PluginAction)).toHaveLength(30);
    expect(Buffer.byteLength(JSON.stringify(doc.toNodeRows()), "utf8")).toBeLessThan(100_000);
    const restored = hydrateModel<SessionRoot>(serializeModel(root));
    expect(restored.pluginState).toEqual(root.pluginState);
    const first = turns[0];
    if (first === undefined || first.pluginState === null) throw new Error("missing checkpoint");
    root.pluginState = { ...first.pluginState };
    root.writePluginLog("test:state", JSON.stringify([actions[0], { n: 100, text: "branch" }]));
    expect(root.pluginHeads[0]?.tail).toBe(first.pluginHeads[0]);
    expect(JSON.parse(first.pluginState["test:state"])).toHaveLength(1);
    expect(JSON.parse(root.pluginState["test:state"])).toHaveLength(2);
    doc.destroy();
  });

  it("replays appended actions into a replica and records an empty log", () => {
    const root = new SessionRoot({ sessionId: "plugin-replica" });
    const source = new DocumentContainer(root);
    const initial = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<SessionRoot>(initial.upserts, {
      rootId: initial.rootId,
      revision: initial.revision,
    });
    source.onPatch(() => {
      const delta = source.takeNodeDelta();
      replica.applyNodeRows(delta);
    });
    root.writePluginLog("test:state", '[{"n":1}]');
    root.writePluginLog("test:state", '[{"n":1},{"n":2}]');
    expect(replica.root.pluginState).toEqual(root.pluginState);
    root.pluginState = { "test:state": "[]" };
    expect(replica.root.pluginState).toEqual({ "test:state": "[]" });
    source.destroy();
    replica.destroy();
  });
});
