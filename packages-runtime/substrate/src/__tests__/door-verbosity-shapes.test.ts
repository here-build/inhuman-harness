// DoorSession verbosity gate — PER-SHAPE, not per-code (regression pin).
//
// The gate teaches a lesson VERBOSE on its first per-session occurrence, terse after (Rule 4).
// The key was `door.code` alone; but three codes are each emitted by SEVERAL DISTINCT lesson
// shapes (different trigger, different text, different teaching):
//   • envelope/unbound-in-expr  — explicit resolution / tie / server-menu / fuzzy / quote-literal
//   • envelope/scope-confusion  — cascade / cross-scope / repeated-local
//   • envelope/bare-tool-call   — plain (bare/tie) / global-collision (ambiguousBypassDoor)
// Keying on the code alone let the FIRST shape to fire consume the single verbose slot for EVERY
// other shape under that code — so a model's genuine FIRST encounter with, say, the server-menu
// lesson rendered TERSE merely because an unrelated explicit-resolution lesson had fired earlier,
// silently skipping teaching the model had never actually seen. FIXED by gating on
// `door.verbosityKey ?? door.code`: each distinct shape carries its own stable per-shape key, so
// distinct lessons no longer starve each other, while a code with a single shape (and a genuine
// REPEAT of the same shape) keeps the plain per-code collapse byte-for-byte. `code` stays the
// telemetry/routing key throughout — only the verbosity gradient got finer.

import { describe, expect, it } from "vitest";

import type { BoundTool } from "../bound-tool.js";
import { ambiguousBypassDoor, bareToolCallDoor, DoorSession, scopeConfusionDoor, unboundInExprDoor } from "../doors.js";

/** The manifold's own naming — every direct door-builder call in this file threads it (mirrors
 *  server.ts's own `TOOL_NAMING` fixture; doors.ts no longer imports names.ts directly). */
const TOOL_NAMING = { toolName: "scheme-repl-with-all-mcp-tools", argName: "repl-input-scheme-program" };

/** Same test-only helper every doors/bind test uses: build a minimal `BoundTool` registry from
 *  explicit (slug, tool) pairs (never re-split a joined string — bind.ts's discipline).
 *  `signature()` is a stub (these tests never inspect it). */
function toolParts(entries: ReadonlyArray<{ slug: string; tool: string }>): ReadonlyMap<string, BoundTool> {
  const map = new Map<string, BoundTool>();
  for (const entry of entries) {
    const qualified = entry.slug === "" ? entry.tool : `${entry.slug}/${entry.tool}`;
    map.set(qualified, {
      qualifiedName: qualified,
      slug: entry.slug,
      tool: entry.tool,
      signature: () => ({ params: [], signatureText: qualified }),
    });
  }
  return map;
}

const CATALOG_PARTS = toolParts([
  { slug: "filesystem", tool: "search_files" },
  { slug: "filesystem", tool: "directory_tree" },
  { slug: "memory", tool: "search_nodes" },
  { slug: "memory", tool: "create_entities" },
]);
const CATALOG = [...CATALOG_PARTS.keys()];

describe("DoorSession per-SHAPE verbosity gate (distinct shapes under one code don't starve each other)", () => {
  it("envelope/unbound-in-expr: explicit-resolution and server-menu each teach VERBOSE on their OWN first occurrence", () => {
    const lines: string[] = [];
    const session = new DoorSession((l) => lines.push(l));

    const explicit = unboundInExprDoor("searchNodes", CATALOG, CATALOG_PARTS, TOOL_NAMING)!; // shape A — the explicit-tool fact
    const serverMenu = unboundInExprDoor("memory_nope", CATALOG, CATALOG_PARTS, TOOL_NAMING)!; // shape B — a real server, wrong tool (tier 2)

    // Same telemetry/routing CODE, but DISTINCT shape keys.
    expect(explicit.code).toBe("envelope/unbound-in-expr");
    expect(serverMenu.code).toBe("envelope/unbound-in-expr");
    expect(explicit.verbosityKey).toBe("envelope/unbound-in-expr#explicit");
    expect(serverMenu.verbosityKey).toBe("envelope/unbound-in-expr#server-menu");

    // Shape A fires first → VERBOSE (carries the "keep the full server/tool-name form" teaching).
    expect(session.enrichInline(explicit, "searchNodes")).toContain(
      "Tool symbols keep their full server/tool-name form",
    );

    // Shape B is an UNRELATED lesson → VERBOSE on ITS first occurrence. (Before the fix this
    // rendered terse — "its tools:" — because the shared code was already `seen`.) The verbose
    // fact says "its tools are:"; the terse one-liner says "its tools:".
    expect(session.enrichInline(serverMenu, "memory_nope")).toBe(
      "\n  server `memory` has no tool `nope` — its tools are: search_nodes, create_entities.",
    );

    // A genuine REPEAT of shape A now collapses to terse — the per-shape gate still de-dupes.
    expect(session.enrichInline(explicit, "searchNodes")).toBe(`\n  ${explicit.terse}`);

    // Telemetry logs the CODE (routing key), never the finer verbosityKey — unchanged by the fix.
    expect(lines.map((l) => (JSON.parse(l) as { door: string }).door)).toEqual([
      "envelope/unbound-in-expr",
      "envelope/unbound-in-expr",
      "envelope/unbound-in-expr",
    ]);
  });

  it("envelope/scope-confusion: cascade, cross-scope, and repeated-local each teach VERBOSE on their OWN first occurrence", () => {
    const session = new DoorSession(() => {});

    const cascade = scopeConfusionDoor({
      name: "aval",
      topLevelDefineStatementNumber: 2,
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [],
      currentCallIndex: 0,
    })!;
    const crossScope = scopeConfusionDoor({
      name: "zed",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [0],
      currentCallIndex: 1,
    })!;
    const repeatedLocal = scopeConfusionDoor({
      name: "dub",
      firstErrorStatementNumber: 1,
      localBindingCallIndexes: [0, 1],
      currentCallIndex: 2,
    })!;

    // One code, three DISTINCT shape keys.
    expect([cascade.code, crossScope.code, repeatedLocal.code]).toEqual([
      "envelope/scope-confusion",
      "envelope/scope-confusion",
      "envelope/scope-confusion",
    ]);
    expect(new Set([cascade.verbosityKey, crossScope.verbosityKey, repeatedLocal.verbosityKey]).size).toBe(3);

    // Each of the three teaches its FULL verbose fact on its own first firing — none suppressed by
    // a sibling shape under the same code having already fired earlier this session.
    expect(session.enrichInline(cascade, "aval")).toContain("every statement after the first error is skipped");
    expect(session.enrichInline(crossScope, "zed")).toContain("a local binding doesn't survive its form");
    expect(session.enrichInline(repeatedLocal, "dub")).toContain("it doesn't persist across statements");

    // A genuine REPEAT of the first shape collapses to terse.
    expect(session.enrichInline(cascade, "aval")).toBe(`\n  ${cascade.terse}`);
  });

  it("envelope/bare-tool-call: the global-collision bypass lesson teaches VERBOSE even after a plain bare-tool-call door fired", () => {
    const session = new DoorSession(() => {});

    // Shape A — a plain cross-server tie: no verbosityKey, so it falls back to the code as its key.
    const plainTie = ambiguousBypassDoor(
      "search_files",
      { path: "/a" },
      ["backup/search_files", "filesystem/search_files"],
      TOOL_NAMING,
    );
    // Shape B — a single candidate whose canonical spelling ALSO names a global symbol: a DISTINCT
    // lesson (why an exact-looking match still wasn't auto-applied), with its own shape key.
    const collision = ambiguousBypassDoor("map", { fn: "double" }, ["utils/map"], TOOL_NAMING, "map");

    expect(plainTie.code).toBe("envelope/bare-tool-call");
    expect(collision.code).toBe("envelope/bare-tool-call");
    expect(plainTie.verbosityKey).toBeUndefined(); // single canonical shape → gated by code
    expect(collision.verbosityKey).toBe("envelope/bare-tool-call#global-collision");

    // Shape A fires first → VERBOSE (the full Error/Why/script contract).
    expect(session.render(plainTie, "search_files")).toContain("Why:");

    // Shape B is a DISTINCT lesson → VERBOSE (full Why, carrying the collision-specific teaching)
    // on its OWN first occurrence, even though a bare-tool-call door already fired this session.
    const rendered = session.render(collision, "map");
    expect(rendered).toContain("Why:");
    expect(rendered).toContain('"map" is ALSO a bound top-level symbol');

    // A genuine REPEAT of shape A collapses to terse — its code key is already spent.
    expect(session.render(plainTie, "search_files")).not.toContain("Why:");
  });

  it("bareToolCallDoor (single-shape code) is unaffected — a repeat still collapses to terse under the code fallback", () => {
    const session = new DoorSession(() => {});
    const door = bareToolCallDoor("t_a", { x: 1 }, ["t/a"], TOOL_NAMING);
    expect(door.verbosityKey).toBeUndefined(); // no shape key → gated by door.code, exactly as before
    const first = session.render(door, "t_a");
    const second = session.render(door, "t_a");
    expect(first).toContain("Why:");
    expect(second).not.toContain("Why:");
    expect(second).toBe(`Error: ${door.terse}`);
  });
});

describe("unbound data-literal hint does not steal Scheme earmuffs", () => {
  it("*features* is an identifier; a starred phrase is still a placeholder", () => {
    expect(unboundInExprDoor("*features*", CATALOG, CATALOG_PARTS, TOOL_NAMING)).toBeUndefined();
    expect(unboundInExprDoor("*starred phrase*", CATALOG, CATALOG_PARTS, TOOL_NAMING)?.fact).toContain(
      'write it as the string "*starred phrase*"',
    );
  });
});
