import { describe, expect, it, beforeEach } from "vitest";

import { ensureBuiltins, listDialects } from "../dialects/registry.js";
import { compileMarkers, createScanner, createMarkerScanner } from "../scan.js";
import { resetRegistryForTests } from "./reset-registry.js";

describe("scan.ts — Aho-Corasick marker scanner", () => {
  describe("empty input", () => {
    it("reports no match and zero hold on an empty feed", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      const state = scanner.feed("");
      expect(state).toEqual({ match: null, holdLength: 0 });
      expect(scanner.length).toBe(0);
    });

    it("reports no match and zero hold when nothing has been fed at all", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      expect(scanner.length).toBe(0);
    });
  });

  describe("marker split across every possible boundary position", () => {
    const marker = "<tool_call>";

    for (let k = 1; k < marker.length; k++) {
      it(`splits at position ${k} (${JSON.stringify(marker.slice(0, k))} | ${JSON.stringify(marker.slice(k))})`, () => {
        const scanner = createMarkerScanner([marker]);
        const first = scanner.feed(marker.slice(0, k));
        expect(first.match).toBeNull();
        expect(first.holdLength).toBe(k);

        const second = scanner.feed(marker.slice(k));
        expect(second.match).toEqual({ marker, start: 0, end: marker.length });
        expect(second.holdLength).toBe(0);
      });
    }

    it("still finds the marker when split characters arrive one at a time", () => {
      const scanner = createMarkerScanner([marker]);
      let last = { match: null as ReturnType<typeof scanner.feed>["match"], holdLength: 0 };
      for (const ch of marker) {
        last = scanner.feed(ch);
      }
      expect(last.match).toEqual({ marker, start: 0, end: marker.length });
    });

    it("keeps correct absolute offsets when preceded by unrelated text, split mid-marker", () => {
      const scanner = createMarkerScanner([marker]);
      const prefix = "hello world, here is a call: ";
      const first = scanner.feed(prefix + marker.slice(0, 4));
      expect(first.match).toBeNull();
      expect(first.holdLength).toBe(4);

      const second = scanner.feed(marker.slice(4));
      expect(second.match).toEqual({
        marker,
        start: prefix.length,
        end: prefix.length + marker.length,
      });
    });
  });

  describe("a marker prefix that never completes", () => {
    it("holds while the tail is a growing prefix, then drops to zero once broken", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      const held = scanner.feed("<tool_c");
      expect(held).toEqual({ match: null, holdLength: 7 });

      const broken = scanner.feed("XYZ");
      expect(broken).toEqual({ match: null, holdLength: 0 });
    });

    it("never reports a match for a permanently incomplete marker", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      scanner.feed("some text <tool_cal");
      const state = scanner.feed(" but not really");
      expect(state.match).toBeNull();
    });
  });

  describe("overlapping markers where one is a prefix of another", () => {
    it("resolves to the marker that completes first (shorter, same start) when a shorter marker is itself registered", () => {
      // "ab" is a genuine registered marker, and is also a prefix of "abc".
      const scanner = createMarkerScanner(["ab", "abc"]);
      const state = scanner.feed("abc");
      expect(state.match).toEqual({ marker: "ab", start: 0, end: 2 });
    });

    it("prefers the longer/exact marker over a shorter one reachable only via the failure chain", () => {
      // "ab" and "b": feeding exactly "ab" must resolve to "ab" (the longer,
      // exactly-matched marker), not fall back to the shorter "b" match that
      // is also reachable (as a suffix) via the automaton's failure links.
      const scanner = createMarkerScanner(["ab", "b"]);
      const state = scanner.feed("ab");
      expect(state.match).toEqual({ marker: "ab", start: 0, end: 2 });
    });

    it("still finds the shorter marker on its own when the longer one never appears", () => {
      const scanner = createMarkerScanner(["ab", "abc"]);
      const state = scanner.feed("xxabyy");
      expect(state.match).toEqual({ marker: "ab", start: 2, end: 4 });
    });

    it("finds the longer marker when the shorter one is a genuine prefix but not independently registered", () => {
      const scanner = createMarkerScanner(["<tool_call>", "<tool_call_x>"]);
      const state = scanner.feed("<tool_call_x>");
      expect(state.match).toEqual({
        marker: "<tool_call_x>",
        start: 0,
        end: 13,
      });
    });
  });

  describe("multiple markers matching at different offsets", () => {
    it("earliest (leftmost, non-overlapping) match wins", () => {
      const scanner = createMarkerScanner(["FOO", "BAR"]);
      const state = scanner.feed("xxxBARyyyFOOzzz");
      expect(state.match).toEqual({ marker: "BAR", start: 3, end: 6 });
    });

    it("wins even when the earliest marker is longer than a later-occurring one", () => {
      const scanner = createMarkerScanner(["LONGMARKER", "X"]);
      const state = scanner.feed("..LONGMARKER....X..");
      expect(state.match).toEqual({ marker: "LONGMARKER", start: 2, end: 12 });
    });
  });

  describe("case variation", () => {
    it("matches regardless of input casing, reporting the marker's original casing", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      const state = scanner.feed("<TOOL_CALL>");
      expect(state.match).toEqual({ marker: "<tool_call>", start: 0, end: 11 });
    });

    it("matches mixed casing split across chunks", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      scanner.feed("<TooL_c");
      const state = scanner.feed("ALL>");
      expect(state.match).toEqual({ marker: "<tool_call>", start: 0, end: 11 });
    });
  });

  describe("sticky match / length bookkeeping", () => {
    it("freezes match+holdLength once found but keeps accumulating length", () => {
      const scanner = createMarkerScanner(["<tool_call>"]);
      const first = scanner.feed("<tool_call>");
      expect(first.match).not.toBeNull();
      expect(scanner.length).toBe(11);

      const second = scanner.feed("more text that must not be scanned");
      expect(second).toEqual(first);
      expect(scanner.length).toBe(11 + "more text that must not be scanned".length);
    });

    it("reset() restores initial state so the automaton can be reused", () => {
      const automaton = compileMarkers(["<tool_call>"]);
      const scanner = createScanner(automaton);
      scanner.feed("<tool_call>");
      expect(scanner.length).toBe(11);

      scanner.reset();
      expect(scanner.length).toBe(0);
      const state = scanner.feed("plain text, no marker here");
      expect(state.match).toBeNull();
    });
  });

  describe("real marker union used in production", () => {
    beforeEach(() => {
      resetRegistryForTests();
      ensureBuiltins();
    });

    function realMarkerUnion(): string[] {
      const union = new Set<string>();
      for (const d of listDialects()) {
        for (const m of d.openMarkers ?? d.markers) union.add(m);
        for (const m of d.closeMarkers ?? []) union.add(m);
      }
      return [...union];
    }

    it("builds a real automaton from the registered dialects without throwing", () => {
      const markers = realMarkerUnion();
      expect(markers.length).toBeGreaterThan(0);
      expect(() => compileMarkers(markers)).not.toThrow();
    });

    it("finds a longcat hyphen-variant open marker embedded in surrounding text", () => {
      const scanner = createMarkerScanner(realMarkerUnion());
      const prefix = "Sure, let me look that up.\n";
      const state = scanner.feed(`${prefix}<longcat-tool-call>{}`);
      expect(state.match).toEqual({
        marker: "<longcat-tool-call>",
        start: prefix.length,
        end: prefix.length + "<longcat-tool-call>".length,
      });
    });

    it("finds a qwen bare-function open marker split across chunks", () => {
      const scanner = createMarkerScanner(realMarkerUnion());
      const held = scanner.feed("Let's call <function");
      expect(held.match).toBeNull();
      expect(held.holdLength).toBeGreaterThan(0);

      const state = scanner.feed("=get_weather>");
      expect(state.match).toEqual({
        marker: "<function=",
        start: "Let's call ".length,
        end: "Let's call ".length + "<function=".length,
      });
    });

    it("does not false-positive hold on plain prose containing no marker prefix", () => {
      const scanner = createMarkerScanner(realMarkerUnion());
      const state = scanner.feed("This is just ordinary prose with no markers whatsoever.");
      expect(state.match).toBeNull();
      expect(state.holdLength).toBe(0);
    });
  });

  describe("input validation", () => {
    it("rejects an empty-string marker", () => {
      expect(() => compileMarkers(["<tool_call>", ""])).toThrow();
    });
  });
});
