import { AExact, AString } from "@here.build/arrival/reflect-internals";
import { describe, expect, it } from "vitest";

import { accessKey } from "../access-key.js";
import { assertUniqueIdentities, diffLists, type Identified, type ListDiff } from "../diff.js";

const item = (body: string) => new AString(body);
const id = (n: number) => new AExact(n);

const valued = (n: number, body: string): Identified => ({
  kind: "value",
  id: id(n),
  item: item(body),
});

const at = (index: number, body: string): Identified => ({
  kind: "position",
  index,
  item: item(body),
});

const bodies = (items: readonly { item: { valueOf(): string } }[]) => items.map((row) => row.item.valueOf());

function face(diff: ListDiff) {
  return {
    added: bodies(diff.added.map((value) => ({ item: value as AString }))),
    removed: bodies(diff.removed.map((value) => ({ item: value as AString }))),
    changed: diff.changed.map(([next, prev]) => [(next as AString).valueOf(), (prev as AString).valueOf()]),
  };
}

describe("diffLists", () => {
  it("classifies first snapshot, add/remove/change, reorder, identity swap, and position", () => {
    const first = [valued(1, "a"), valued(2, "b")];
    const grown = [valued(2, "B"), valued(3, "c")];
    const reordered = [valued(2, "b"), valued(1, "a")];
    const swappedId = [valued(10, "a")];
    expect({
      first: face(diffLists(undefined, first)),
      edit: face(diffLists(first, grown)),
      reorder: face(diffLists(first, reordered)),
      idSwap: face(diffLists([valued(1, "a")], swappedId)),
      positionSwap: face(diffLists([at(0, "a"), at(1, "b")], [at(0, "b"), at(1, "a")])),
      positionGrow: face(diffLists([at(0, "a")], [at(0, "a"), at(1, "b")])),
    }).toEqual({
      first: { added: [], removed: [], changed: [] },
      edit: { added: ["c"], removed: ["a"], changed: [["B", "b"]] },
      reorder: { added: [], removed: [], changed: [] },
      idSwap: { added: ["a"], removed: ["a"], changed: [] },
      positionSwap: {
        added: [],
        removed: [],
        changed: [
          ["b", "a"],
          ["a", "b"],
        ],
      },
      positionGrow: { added: ["b"], removed: [], changed: [] },
    });
    expect(() => assertUniqueIdentities([valued(1, "a"), valued(1, "b")])).toThrow(/duplicate identity/);
  });

  it("prefers keyOf over provenance and doors an empty key", () => {
    const stamped = new AExact(1).withProvenance(new Set([4, 2]));
    const bare = new AExact(1);
    expect({
      provenance: accessKey(stamped),
      host: accessKey(stamped, () => "origin+path"),
    }).toEqual({ provenance: "2,4", host: "origin+path" });
    expect(() => accessKey(bare)).toThrow(/path-stable access key/);
  });
});
