// Pins the frozen ContextRing contract: the per-rebuild-world-object ring of successful
// top-level `(define ...)` source, re-lowered into the current program's LoweredUnit context
// region.
//
// RED suite: context-ring.ts does not exist yet, by design. See src/__red__/README.md for
// the migration path once it lands.

import { describe, expect, it } from "vitest";

import { createContextRing } from "../../type-hints/context-ring.js";

/** ~500-char entry generator for the FIFO-eviction suite below. Module-scoped (not a closure
 *  inside the `it`) so it's constructed once, not re-allocated per test run. */
const entryOf = (i: number): string => `(define v${i} "${"x".repeat(480)}")`;

describe("§2 — plain scheme defines are stored verbatim, in insertion order", () => {
  it("push(name, source) then entries() returns the sources verbatim, in the order pushed", () => {
    const ring = createContextRing();
    // ContextRing.push(name, source) is a two-arg DOMAIN method, not Array#push — merging these
    // into one call (unicorn/prefer-single-call's fix) would change TWO defines into one call
    // with FOUR positional args, silently breaking the (name, source) pairing.
    ring.push("a", "(define a 1)");
    // eslint-disable-next-line unicorn/prefer-single-call
    ring.push("b", "(define b (+ a 1))");
    expect(ring.entries()).toEqual(["(define a 1)", "(define b (+ a 1))"]);
  });
});

describe("G13.1 — tool-valued defines degrade at insertion", () => {
  it("a define whose source references a `/`-qualified tool symbol as its head degrades to `declare const <name>: unknown`", () => {
    const ring = createContextRing();
    ring.push("x", '(define x (shop/list-orders :status "open"))');
    expect(ring.entries()).toEqual(["declare const x: unknown"]);
  });

  it("tool-symbol detection is ANYWHERE in the form, not only the head position (doc §2: 'a qualified head anywhere in the form')", () => {
    const ring = createContextRing();
    ring.push("y", "(define y (+ 1 (shop/get-price :id 5)))");
    expect(ring.entries()).toEqual(["declare const y: unknown"]);
  });

  it("a pure-scheme define with no tool symbol anywhere is NOT degraded", () => {
    const ring = createContextRing();
    ring.push("z", "(define z (+ 1 2))");
    expect(ring.entries()).toEqual(["(define z (+ 1 2))"]);
  });
});

describe("§2 — rebind replaces in place (last-wins)", () => {
  it("rebinding an existing name results in exactly one entry, with the LATEST content (position is unspecified by the doc — not asserted)", () => {
    const ring = createContextRing();
    // See the eslint-disable note above — three separate (name, source) pairs, never mergeable.
    ring.push("a", "(define a 1)");
    // eslint-disable-next-line unicorn/prefer-single-call
    ring.push("b", "(define b 2)");
    // eslint-disable-next-line unicorn/prefer-single-call
    ring.push("a", "(define a 2)");
    const entries = ring.entries();
    expect(entries).toHaveLength(2);
    expect(entries).toContain("(define a 2)");
    expect(entries).not.toContain("(define a 1)");
  });
});

describe("G13.3 — ~8k-char FIFO eviction", () => {
  it("pushing past the ~8k-char total cap evicts the OLDEST entries first; total stays bounded; the newest entry always survives", () => {
    const ring = createContextRing();
    // Each entry is ~500 chars; 20 of them (~10k total) forces eviction past the ~8k cap.
    for (let i = 0; i < 20; i++) {
      ring.push(`v${i}`, entryOf(i));
    }
    const entries = ring.entries();
    const total = entries.reduce((sum, e) => sum + e.length, 0);
    // "~8k" per the doc — allow headroom rather than pinning an exact byte count.
    expect(total).toBeLessThanOrEqual(8500);
    expect(entries).toContain(entryOf(19)); // newest always present
    expect(entries).not.toContain(entryOf(0)); // oldest evicted
  });
});

describe("knownToolNames — closes the slugless-binding blind spot", () => {
  // bind.ts: `qualifiedName = server.slug === "" ? tool.name : ...` — a slugless single-server
  // binding's qualified name is the tool's BARE name, verbatim. When that bare name has no
  // `/` either (a real tool literally named `price`), TOOL_SYMBOL alone cannot see it
  // (there is no `/` anywhere in the source). `createContextRing`'s optional roster parameter
  // closes this without changing the frozen `push`/`entries` contract.

  it("regression pin: with NO roster supplied, an underscore-free tool reference is NOT degraded (documents the blind spot as it was found)", () => {
    const ring = createContextRing();
    ring.push("p", '(define p (price :item "widget"))');
    expect(ring.entries()).toEqual(['(define p (price :item "widget"))']);
  });

  it("supplying the real roster DOES degrade an underscore-free tool-valued define", () => {
    const ring = createContextRing(["price"]);
    ring.push("p", '(define p (price :item "widget"))');
    expect(ring.entries()).toEqual(["declare const p: unknown"]);
  });

  it("a roster name must match as a whole token, not a substring of an unrelated identifier", () => {
    const ring = createContextRing(["click"]);
    ring.push("h", "(define h (double-click-handler 1))");
    expect(ring.entries()).toEqual(["(define h (double-click-handler 1))"]);
  });

  it("a roster name still matches anywhere in the form, not only the head position (mirrors TOOL_SYMBOL's own rule)", () => {
    const ring = createContextRing(["price"]);
    ring.push("y", '(define y (+ 1 (price :item "x")))');
    expect(ring.entries()).toEqual(["declare const y: unknown"]);
  });

  it("an empty roster behaves exactly like no roster at all", () => {
    const ring = createContextRing([]);
    ring.push("p", '(define p (price :item "widget"))');
    expect(ring.entries()).toEqual(['(define p (price :item "widget"))']);
  });

  it("a roster name containing a regex metacharacter is matched literally, never thrown as a malformed pattern", () => {
    const ring = createContextRing(["a.b"]);
    ring.push("x", "(define x (a.b 1))");
    expect(ring.entries()).toEqual(["declare const x: unknown"]);
    // The metacharacter must be treated LITERALLY (a real dot), not as regex "any char" —
    // "aXb" must NOT match "a.b"'s roster entry.
    const ring2 = createContextRing(["a.b"]);
    ring2.push("z", "(define z (aXb 1))");
    expect(ring2.entries()).toEqual(["(define z (aXb 1))"]);
  });

  it("the pre-existing TOOL_SYMBOL heuristic and the roster check OR together — either one is enough", () => {
    const ring = createContextRing(["price"]); // roster only knows "price"
    ring.push("s", '(define s (shop/search :q "x"))'); // NOT in roster, but `/`-shaped
    expect(ring.entries()).toEqual(["declare const s: unknown"]);
  });
});

describe("§2 — name extraction (open question)", () => {
  it("plain-variable define — push() takes `name` given directly by the caller", () => {
    const ring = createContextRing();
    ring.push("a", "(define a 1)");
    expect(ring.entries()).toEqual(["(define a 1)"]);
  });

  it.todo(
    "function-form define `(define (f x) ...)` — push(name, source) takes `name` PRE-EXTRACTED by the " +
      "caller (whatever code walks top-level defines and calls ring.push), not by ContextRing itself; " +
      "this test is therefore about a caller module outside ContextRing's contract. Open question: which " +
      "module owns that extraction, and does it correctly pull `f` (not the full `(f x)` head form)? Not " +
      "testable here until that module's contract exists.",
  );
});
