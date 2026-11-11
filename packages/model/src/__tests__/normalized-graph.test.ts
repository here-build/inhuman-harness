import { describe, expect, it } from "vitest";

import { DocumentContainer, hydrateModel, Model, model, serializeModel, state } from "../index.js";

@model("test:normalized:entry")
class Entry extends Model {
  @state accessor text = "";
  @state.ref accessor tail: Entry | null = null;
  @state.list accessor history: Array<Entry | string> = [];
  @state.ref accessor owner: Root | null = null;
}

@model("test:normalized:root")
class Root extends Model {
  @state.childList accessor entries: Entry[] = [];
  @state.list accessor tape: Array<Entry | string> = [];
  @state.ref accessor self: Root | null = null;
  @state.ref accessor selected: Entry | null = null;
  @state.refList accessor references: Entry[] = [];
  @state.childRecord accessor records: Record<string, Entry> = {};
}

describe("normalized entity graph", () => {
  it("stores shared entities once and restores aliases and tail pointers", () => {
    const first = new Entry({ text: "first" });
    const second = new Entry({ text: "second", tail: first, history: ["note", first] });
    const root = new Root({ entries: [first, second], tape: [first, second, first] });
    const graph = serializeModel(root);
    expect(Object.keys(graph.nodes)).toHaveLength(3);
    expect(graph.nodes[root.uuid].childLists.entries).toEqual([first.uuid, second.uuid]);
    const json = JSON.stringify(graph);
    const restored = hydrateModel<Root>(JSON.parse(json));
    expect(restored.tape).toEqual([restored.entries[0], restored.entries[1], restored.entries[0]]);
    expect(restored.entries[1]?.tail).toBe(restored.entries[0]);
    expect(restored.entries[1]?.history).toEqual(["note", restored.entries[0]]);
  });

  it("emits O(delta) node row upserts and converges a replica via applyNodeRows", () => {
    const root = new Root();
    const source = new DocumentContainer(root);
    const initialDelta = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<Root>(initialDelta.upserts, {
      rootId: initialDelta.rootId,
      revision: initialDelta.revision,
    });

    const upsertCounts: number[] = [];
    source.onPatch(() => {
      const delta = source.takeNodeDelta();
      upsertCounts.push(delta.upserts.length);
      replica.applyNodeRows(delta);
    });

    let tail: Entry | null = null;
    for (let index = 0; index < 100; index++) {
      const entry: Entry = new Entry({ text: "x".repeat(100), tail, history: tail === null ? [] : [tail] });
      source.transact(() => {
        root.entries.push(entry);
        root.tape.push(entry);
      });
      tail = entry;
    }

    // Each step only serializes root + new entry (2 rows), never the whole 100-node graph!
    expect(Math.max(...upsertCounts)).toBe(2);
    if (tail === null) throw new Error("missing tail");

    const replicaLastBefore = replica.root.entries.at(-1);
    tail.text = "updated";
    // Object identity is preserved across incremental row updates
    expect(replica.root.entries.at(-1)).toBe(replicaLastBefore);
    expect(replica.root.entries).toHaveLength(100);
    expect(replica.root.entries.at(-1)?.text).toBe("updated");
    expect(replica.root.entries.at(-1)?.tail).toBe(replica.root.entries.at(-2));
    expect(replica.root.tape.at(-1)).toBe(replica.root.entries.at(-1));
    source.destroy();
    replica.destroy();
  });

  it("prunes detached subtrees from #registry and emits deleted node IDs", () => {
    const first = new Entry({ text: "first" });
    const second = new Entry({ text: "second" });
    const root = new Root({ entries: [first, second] });
    const source = new DocumentContainer(root);
    const initial = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<Root>(initial.upserts, {
      rootId: initial.rootId,
      revision: initial.revision,
    });
    expect(source.registry.size).toBe(3);
    expect(replica.registry.size).toBe(3);

    // Detach `first` completely
    root.entries.splice(0, 1);
    const removalDelta = source.takeNodeDelta();
    expect(removalDelta.deletes).toEqual([first.uuid]);
    expect(source.registry.has(first.uuid)).toBe(false);
    expect(source.registry.size).toBe(2);

    replica.applyNodeRows(removalDelta);
    expect(replica.registry.has(first.uuid)).toBe(false);
    expect(replica.registry.size).toBe(2);
    expect(replica.root.entries).toHaveLength(1);
    expect(replica.root.entries[0]?.text).toBe("second");

    // Re-attaching a previously detached row re-registers and re-upserts it cleanly
    root.entries.push(first);
    first.text = "returned and updated";
    const reattachDelta = source.takeNodeDelta();
    replica.applyNodeRows(reattachDelta);
    expect(replica.root.entries[1]).toMatchObject({ text: "returned and updated" });
    expect(replica.registry.size).toBe(3);

    source.destroy();
    replica.destroy();
  });

  it("replays replacement lists with model pointers", () => {
    const root = new Root();
    const source = new DocumentContainer(root);
    const initial = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<Root>(initial.upserts, {
      rootId: initial.rootId,
      revision: initial.revision,
    });
    source.onPatch(() => replica.applyNodeRows(source.takeNodeDelta()));
    const entry = new Entry({ text: "replacement" });
    root.tape = [entry, "literal"];
    entry.text = "updated";
    const restored = hydrateModel<Root>(replica.toSnapshot());
    expect(restored.tape[0]).toBeInstanceOf(Entry);
    expect(restored.tape[0]).toMatchObject({ text: "updated" });
    expect(restored.tape[1]).toBe("literal");
    source.destroy();
    replica.destroy();
  });

  it("keeps model-shaped literal objects in value lists", () => {
    @model("test:normalized:literal-list")
    class LiteralList extends Model {
      @state.list accessor values: unknown[] = [];
    }
    const root = new LiteralList({ values: [{ $model: "literal" }, { $value: "literal" }] });
    expect(hydrateModel<LiteralList>(serializeModel(root)).values).toEqual(root.values);
    const source = new DocumentContainer(root);
    const initial = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<LiteralList>(initial.upserts, {
      rootId: initial.rootId,
      revision: initial.revision,
    });
    source.onPatch(() => replica.applyNodeRows(source.takeNodeDelta()));
    root.values.push({ uuid: "literal-id", tag: "literal-tag" }, { $value: "literal" });
    expect(replica.root.values).toEqual(root.values);
    root.values = [{ uuid: "other-id", tag: "other-tag" }, { $model: "literal" }];
    expect(replica.root.values).toEqual(root.values);
    source.destroy();
    replica.destroy();
  });

  it("links list reference cycles after materializing the rows", () => {
    const first = new Entry();
    const second = new Entry({ history: [first] });
    first.history = [second];
    const restored = hydrateModel<Entry>(serializeModel(first));
    const next = restored.history[0];
    expect(next).toBeInstanceOf(Entry);
    if (!(next instanceof Entry)) throw new Error("missing next");
    expect(next.history[0]).toBe(restored);
  });

  it("keeps references to the retained root shell canonical", () => {
    const root = new Root();
    root.self = root;
    root.entries.push(new Entry({ owner: root }));
    const source = new DocumentContainer(root);
    const replica = new DocumentContainer(new Root());
    const shell = replica.root;
    replica.hydrateFromSnapshot(source.toSnapshot());
    expect(replica.root).toBe(shell);
    expect(replica.root.self).toBe(shell);
    expect(replica.root.entries[0]?.owner).toBe(shell);
    source.destroy();
    replica.destroy();
  });

  it("introduces referenced rows and replacement child records before later mutations", () => {
    const root = new Root();
    const source = new DocumentContainer(root);
    const initial = source.takeNodeDelta();
    const replica = DocumentContainer.fromNodeRows<Root>(initial.upserts, {
      rootId: initial.rootId,
      revision: initial.revision,
    });
    source.onPatch(() => replica.applyNodeRows(source.takeNodeDelta()));
    const selected = new Entry({ text: "selected" });
    root.selected = selected;
    root.references.push(selected, new Entry({ text: "reference" }));
    const child = new Entry({ text: "child" });
    root.records = { child };
    selected.text = "selected updated";
    child.text = "child updated";
    expect(replica.root.selected).toMatchObject({ text: "selected updated" });
    expect(replica.root.references[0]).toBe(replica.root.selected);
    expect(replica.root.records.child).toBeInstanceOf(Entry);
    expect(replica.root.records.child.text).toBe("child updated");
    source.destroy();
    replica.destroy();
  });

  it("syncs structured presence entries on ReactiveAwareness without binary codecs", () => {
    const source = new DocumentContainer(new Root(), { clientId: 101 });
    const replica = new DocumentContainer(new Root(), { clientId: 202 });
    source.awareness.setLocalStateField("seat", { active: true });
    replica.awareness.applyPresenceEntries(source.awareness.toPresenceEntries());
    expect(replica.awareness.getLane("seat", 101)).toEqual({ active: true });
    source.awareness.setLocalState(null);
    replica.awareness.applyPresenceEntries([[101, null]]);
    expect(replica.awareness.getLane("seat", 101)).toBeUndefined();
    source.destroy();
    replica.destroy();
  });
});
