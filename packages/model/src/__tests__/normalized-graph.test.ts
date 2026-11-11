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

  it("sends only new rows in patches and preserves later mutations after replay", () => {
    const root = new Root();
    const source = new DocumentContainer(root);
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    const sizes: number[] = [];
    source.on("update", (update) => {
      sizes.push(update.length);
      replica.applyUpdate(update);
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
    expect(Math.max(...sizes)).toBeLessThan(2500);
    if (tail === null) throw new Error("missing tail");
    tail.text = "updated";
    const restored = hydrateModel<Root>(replica.toSnapshot());
    expect(restored.entries).toHaveLength(100);
    expect(restored.entries.at(-1)?.text).toBe("updated");
    expect(restored.entries.at(-1)?.tail).toBe(restored.entries.at(-2));
    expect(restored.tape.at(-1)).toBe(restored.entries.at(-1));
    source.destroy();
    replica.destroy();
  });

  it("replays replacement lists with model pointers", () => {
    const root = new Root();
    const source = new DocumentContainer(root);
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    source.on("update", (update) => replica.applyUpdate(update));
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
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    source.on("update", (update) => replica.applyUpdate(update));
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

  it("reannounces detached rows after a reconnect snapshot omitted them", () => {
    const entry = new Entry({ text: "returned" });
    const root = new Root({ entries: [entry] });
    const source = new DocumentContainer(root);
    root.entries.splice(0, 1);
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    source.on("update", (update) => replica.applyUpdate(update));
    root.entries.push(entry);
    entry.text = "returned and updated";
    expect(replica.root.entries[0]).toMatchObject({ text: "returned and updated" });
    source.destroy();
    replica.destroy();
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
    const replica = DocumentContainer.fromSnapshot(source.toSnapshot());
    source.on("update", (update) => replica.applyUpdate(update));
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
});
