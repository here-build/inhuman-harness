import { describe, expect, it } from "vitest";

import { applyJsonPatch, diffJson } from "../workflow-feed.js";

/** Seeded, so a failing case replays. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["a", "b", "kind", "a/b", "~", "~1", "", "0", "-", "toString"];

function json(next: () => number, depth: number): unknown {
  const pick = next();
  if (depth <= 0 || pick < 0.4) {
    const leaf = Math.floor(next() * 6);
    return [null, true, Math.floor(next() * 4), "s", "a/b~", {}][leaf];
  }
  const size = Math.floor(next() * 4);
  if (pick < 0.7) return Array.from({ length: size }, () => json(next, depth - 1));
  return Object.fromEntries(
    Array.from({ length: size }, () => [KEYS[Math.floor(next() * KEYS.length)], json(next, depth - 1)]),
  );
}

/** Mostly the same document, a little changed: what a growing graph looks like between ticks. */
function mutate(next: () => number, doc: unknown): unknown {
  if (next() < 0.15) return json(next, 3);
  if (Array.isArray(doc)) {
    const out = doc.map((item) => mutate(next, item));
    if (next() < 0.3) out.push(json(next, 2));
    if (next() < 0.2) out.pop();
    return out;
  }
  if (typeof doc === "object" && doc !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(doc)) if (next() > 0.1) out[key] = mutate(next, value);
    if (next() < 0.3) out[KEYS[Math.floor(next() * KEYS.length)] as string] = json(next, 2);
    return out;
  }
  return doc;
}

describe("workflow feed json patch", () => {
  it("applying the diff of a to b gives b, over varied json", () => {
    const next = rng(7);
    for (let at = 0; at < 600; at += 1) {
      const a = json(next, 4);
      const b = at % 2 === 0 ? json(next, 4) : mutate(next, a);
      const patched = applyJsonPatch(a, diffJson(a, b));
      expect(patched, JSON.stringify({ a, b })).toEqual(b);
    }
  });

  it("an unchanged document diffs to nothing, and the original is never mutated", () => {
    const next = rng(11);
    for (let at = 0; at < 100; at += 1) {
      const a = json(next, 4);
      const frozen = JSON.stringify(a);
      expect(diffJson(a, JSON.parse(frozen))).toEqual([]);
      applyJsonPatch(a, diffJson(a, mutate(next, a)));
      expect(JSON.stringify(a)).toBe(frozen);
    }
  });

  it("a growing array adds at the end; a shrinking one removes from it", () => {
    expect(diffJson({ xs: [1, 2] }, { xs: [1, 2, 3, 4] })).toEqual([
      { op: "add", path: "/xs/2", value: 3 },
      { op: "add", path: "/xs/3", value: 4 },
    ]);
    expect(diffJson([1, 2, 3, 4], [1, 2])).toEqual([
      { op: "remove", path: "/3" },
      { op: "remove", path: "/2" },
    ]);
  });

  it("a change deep in a record replaces only that leaf", () => {
    const a = { roots: [{ kind: "leaf", state: "running", meta: { verb: "agent/call" } }], edges: [] };
    const b = { roots: [{ kind: "leaf", state: "resolved", meta: { verb: "agent/call" } }], edges: [] };
    expect(diffJson(a, b)).toEqual([{ op: "replace", path: "/roots/0/state", value: "resolved" }]);
  });

  it("escapes ~ and / in keys", () => {
    const ops = diffJson({}, { "a/b": 1, "~": 2 });
    expect(ops.map((op) => op.path)).toEqual(["/a~1b", "/~0"]);
    expect(applyJsonPatch({}, ops)).toEqual({ "a/b": 1, "~": 2 });
  });

  it("shares the subtrees a patch does not touch", () => {
    const keep = { big: [1, 2, 3] };
    const a = { keep, grow: [1] };
    const b = applyJsonPatch(a, [{ op: "add", path: "/grow/-", value: 2 }]) as typeof a;
    expect(b.keep).toBe(keep);
    expect(b.grow).toEqual([1, 2]);
    expect(a.grow).toEqual([1]);
  });

  it("replaces the root", () => {
    expect(diffJson(1, { a: 1 })).toEqual([{ op: "replace", path: "", value: { a: 1 } }]);
    expect(applyJsonPatch(1, [{ op: "replace", path: "", value: { a: 1 } }])).toEqual({ a: 1 });
  });
});
