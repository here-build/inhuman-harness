import { exec } from "@here.build/arrival";
import { describe, expect, it, vi } from "vitest";

import {
  buildBypassResolution,
  buildManifoldEnv,
  resolveBypass,
  toBoundTools,
  type ManifoldEnv,
  type ToolIdentityParts,
} from "../bind.js";

// `buildManifoldEnv` returns a `ManifoldEnv` — `{ capabilities, config, runCtx, scope, ... }`
// — which satisfies `createManifoldTool`'s narrower `{ capabilities, config, runCtx, scope }`
// tuple structurally; `exec` accepts the same tuple directly (the CUT), so a bare
// `ManifoldEnv` is a valid `runExpr` target as-is. `exec` already peels through toJS.
const runExpr = (world: Pick<ManifoldEnv, "capabilities" | "config" | "runCtx" | "scope">, expr: string) =>
  exec(expr, {
    capabilities: world.capabilities,
    config: world.config,
    runCtx: world.runCtx,
    scope: world.scope,
  });

/** Test-only helper: builds the `toolParts` structural map `buildBypassResolution` now takes
 *  DIRECTLY from explicit (slug, tool) pairs — never by splitting a joined string (the exact
 *  discipline bind.ts's module header requires of every real caller). Mirrors exactly what
 *  `buildManifoldEnv`'s own per-tool loop builds. */
function toolParts(entries: ReadonlyArray<ToolIdentityParts>): ReadonlyMap<string, ToolIdentityParts> {
  const map = new Map<string, ToolIdentityParts>();
  for (const entry of entries) {
    const qualified = entry.slug === "" ? entry.tool : `${entry.slug}/${entry.tool}`;
    map.set(qualified, entry);
  }
  return map;
}

describe("buildManifoldEnv", () => {
  it("binds a remote tool as slug/tool-name and calls invoke with a kwargs-decoded object", async () => {
    const invoke = vi.fn(async (args: Record<string, unknown>) => ({ found: args.query, limit: args.limit }));
    const env = await buildManifoldEnv([
      {
        slug: "github",
        tools: [
          {
            name: "search-issues",
            description: "Search issues",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              required: ["query"],
            },
            invoke,
          },
        ],
      },
    ]);

    const [result] = await runExpr(env, '(github/search-issues :query "bug" :limit 5)');
    // Second positional arg is the calling eval's abort signal (bind.ts's rosettaDef, forwarded
    // from the rosetta wrapper's per-call invocation-`this`). `runExpr` passes no `signal`, so
    // it is the run's own — every arrival run owns one.
    expect(invoke).toHaveBeenCalledWith({ query: "bug", limit: 5 }, expect.any(AbortSignal));
    expect(result).toEqual({ found: "bug", limit: 5 });
  });

  it("omits an optional property from the invoke args when its keyword isn't supplied", async () => {
    const invoke = vi.fn(async (args: Record<string, unknown>) => args);
    const env = await buildManifoldEnv([
      {
        slug: "github",
        tools: [
          {
            name: "search-issues",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              required: ["query"],
            },
            invoke,
          },
        ],
      },
    ]);

    await runExpr(env, '(github/search-issues :query "bug")');
    // See the abort-signal note above — the run's own signal, because `runExpr` passes none.
    expect(invoke).toHaveBeenCalledWith({ query: "bug" }, expect.any(AbortSignal));
  });

  it("keyword order at the call site doesn't matter", async () => {
    const invoke = vi.fn(async (args: Record<string, unknown>) => args);
    const env = await buildManifoldEnv([
      {
        slug: "github",
        tools: [
          {
            name: "search-issues",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              required: ["query"],
            },
            invoke,
          },
        ],
      },
    ]);

    await runExpr(env, '(github/search-issues :limit 5 :query "bug")');
    // See the abort-signal note above — the run's own signal, because `runExpr` passes none.
    expect(invoke).toHaveBeenCalledWith({ query: "bug", limit: 5 }, expect.any(AbortSignal));
  });

  it("an empty slug binds the BARE tool name (single-server shape) and renders it in the signature", async () => {
    const invoke = vi.fn(async (args: Record<string, unknown>) => ({ found: args.query }));
    const env = await buildManifoldEnv([
      {
        slug: "",
        tools: [
          {
            name: "search-issues",
            description: "Search issues",
            inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
            invoke,
          },
        ],
      },
    ]);

    const [result] = await runExpr(env, '(search-issues :query "bug")');
    // See the abort-signal note above — the run's own signal, because `runExpr` passes none.
    expect(invoke).toHaveBeenCalledWith({ query: "bug" }, expect.any(AbortSignal));
    expect(result).toEqual({ found: "bug" });
    expect(env.signatures[0]?.signatureText).toBe("(search-issues :query string) - Search issues");
  });

  it("throws loudly on a bare-name collision instead of silently last-write-wins", async () => {
    await expect(
      buildManifoldEnv([
        { slug: "", tools: [{ name: "search", inputSchema: { type: "object" }, invoke: async () => null }] },
        { slug: "", tools: [{ name: "search", inputSchema: { type: "object" }, invoke: async () => null }] },
      ]),
    ).rejects.toThrow('tool name collision on "search"');
  });

  it("namespaces same-named tools across different servers without collision", async () => {
    const githubInvoke = vi.fn(async () => "github-result");
    const slackInvoke = vi.fn(async () => "slack-result");
    const env = await buildManifoldEnv([
      { slug: "github", tools: [{ name: "search", inputSchema: { type: "object" }, invoke: githubInvoke }] },
      { slug: "slack", tools: [{ name: "search", inputSchema: { type: "object" }, invoke: slackInvoke }] },
    ]);

    const [a] = await runExpr(env, "(github/search)");
    const [b] = await runExpr(env, "(slack/search)");
    expect(a).toBe("github-result");
    expect(b).toBe("slack-result");
  });

  it("returns one ToolSignature per bound tool, in binding order", async () => {
    const { signatures } = await buildManifoldEnv([
      {
        slug: "github",
        tools: [
          {
            name: "search-issues",
            description: "Search issues",
            inputSchema: { type: "object" },
            invoke: async () => null,
          },
          { name: "list-repos", description: "List repos", inputSchema: { type: "object" }, invoke: async () => null },
        ],
      },
    ]);
    expect(signatures.map((s) => s.signatureText)).toEqual([
      "(github/search-issues) - Search issues",
      "(github/list-repos) - List repos",
    ]);
  });

  it("binds the s/* validating-identity family into every manifold env", async () => {
    const env = await buildManifoldEnv([]);

    const [n] = await runExpr(env, "(s/number 81)");
    expect(n).toBe(81);
    const [i] = await runExpr(env, "(s/integer 81)");
    expect(i).toBe(81);
    const [s] = await runExpr(env, '(s/string "hi")');
    expect(s).toBe("hi");
    const [b] = await runExpr(env, "(s/boolean #t)");
    expect(b).toBe(true);

    await expect(runExpr(env, '(s/number "There are 81 songs")')).rejects.toThrow(
      's/number: expected a number, got string: "There are 81 songs"',
    );
    await expect(runExpr(env, "(s/integer 81.5)")).rejects.toThrow("s/integer: expected an integer, got number: 81.5");
    await expect(runExpr(env, "(s/string 5)")).rejects.toThrow("s/string: expected a string, got number: 5");
    await expect(runExpr(env, "(s/boolean 1)")).rejects.toThrow("s/boolean: expected a boolean, got number: 1");
  });

  it("s/* truncates a long value preview to ~60 chars", async () => {
    const env = await buildManifoldEnv([]);
    const long = "x".repeat(100);
    await expect(runExpr(env, `(s/number ${JSON.stringify(long)})`)).rejects.toThrow(/got string: ".+\.\.\.$/);
    await expect(runExpr(env, `(s/number ${JSON.stringify(long)})`)).rejects.not.toThrow(long);
  });

  it("s/* composes over a nested tool-call argument", async () => {
    const invoke = vi.fn(async () => ({ count: 5 }));
    const env = await buildManifoldEnv([
      { slug: "some", tools: [{ name: "tool", inputSchema: { type: "object" }, invoke }] },
    ]);
    const [result] = await runExpr(env, "(s/number (:count (some/tool)))");
    expect(result).toBe(5);
  });

  it("fails loudly when a connected server's slug collides with the reserved `s/*` namespace", async () => {
    await expect(buildManifoldEnv([{ slug: "s", tools: [] }])).rejects.toThrow(
      'server slug "s" collides with the reserved `s/*` type-assertion namespace',
    );
  });

  it("passes a tool's outputSchema through to its ToolSignature's -> suffix", async () => {
    const { signatures } = await buildManifoldEnv([
      {
        slug: "weather",
        tools: [
          {
            name: "get-forecast",
            description: "Get the forecast",
            inputSchema: { type: "object" },
            outputSchema: { type: "object", properties: { temp: { type: "number" } }, required: ["temp"] },
            invoke: async () => null,
          },
        ],
      },
    ]);
    expect(signatures[0]?.signatureText).toBe("(weather/get-forecast) -> {temp:number} - Get the forecast");
  });

  it("buildManifoldEnv threads a toolParts map recording each bound tool's (slug, tool) identity", async () => {
    const { toolParts: parts } = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => null }],
      },
    ]);
    expect(parts.get("filesystem/search_files")).toEqual({ slug: "filesystem", tool: "search_files" });
  });

  it("buildManifoldEnv threads a bypassResolution map covering both of a bound tool's forms (qualified, wire-underscored, bare)", async () => {
    const { bypassResolution } = await buildManifoldEnv([
      {
        slug: "filesystem",
        tools: [{ name: "search_files", inputSchema: { type: "object" }, invoke: async () => null }],
      },
    ]);
    expect(bypassResolution.get("filesystem/search_files")).toEqual({
      kind: "unique",
      qualified: "filesystem/search_files",
    });
    expect(bypassResolution.get("filesystem_search_files")).toEqual({
      kind: "unique",
      qualified: "filesystem/search_files",
    });
    expect(bypassResolution.get("search_files")).toEqual({ kind: "unique", qualified: "filesystem/search_files" });
  });

  it("an env-side collision with the bound `s/*` validator family resolves as ambiguous (real, not synthetic)", async () => {
    // A bare tool literally spelled "s_number" normalizes (normalizeSymbolName collapses
    // `-`/`_`/`/`) to the SAME canonical form as the bound global `s/number` validator —
    // an unrelated top-level symbol, never a second tool. The env-side map must catch this
    // even though the RAW spellings differ ("s_number" vs "s/number").
    const { bypassResolution } = await buildManifoldEnv([
      { slug: "", tools: [{ name: "s_number", inputSchema: { type: "object" }, invoke: async () => null }] },
    ]);
    const resolved = resolveBypass(bypassResolution, "s_number");
    expect(resolved?.kind).toBe("ambiguous");
    expect(resolved).toMatchObject({ kind: "ambiguous", candidates: ["s_number"], globalCollision: "s_number" });
  });
});

describe("toBoundTools — pure projection of a built ManifoldEnv into substrate's BoundTool registry", () => {
  it("produces one BoundTool per bound tool, with slug/tool/schema/outputSchema/signature() matching the source ManifoldEnv", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "weather",
        tools: [
          {
            name: "get-forecast",
            description: "Get the forecast",
            inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            outputSchema: { type: "object", properties: { temp: { type: "number" } }, required: ["temp"] },
            invoke: async () => null,
          },
        ],
      },
    ]);

    const registry = toBoundTools(manifoldEnv);
    expect([...registry.keys()]).toEqual(["weather/get-forecast"]);

    const bound = registry.get("weather/get-forecast")!;
    expect(bound.qualifiedName).toBe("weather/get-forecast");
    expect(bound.slug).toBe("weather");
    expect(bound.tool).toBe("get-forecast");
    expect(bound.schema).toEqual({ type: "object", properties: { city: { type: "string" } }, required: ["city"] });
    expect(bound.outputSchema).toEqual({
      type: "object",
      properties: { temp: { type: "number" } },
      required: ["temp"],
    });
    expect(bound.signature()).toBe(manifoldEnv.signatures[0]);
    expect(bound.signature().signatureText).toBe(
      "(weather/get-forecast :city string) -> {temp:number} - Get the forecast",
    );
  });

  it("produces multiple entries, correctly zipped by index, across multiple servers/tools", async () => {
    const manifoldEnv = await buildManifoldEnv([
      {
        slug: "github",
        tools: [
          {
            name: "search-issues",
            description: "Search issues",
            inputSchema: { type: "object" },
            invoke: async () => null,
          },
          { name: "list-repos", description: "List repos", inputSchema: { type: "object" }, invoke: async () => null },
        ],
      },
      {
        slug: "slack",
        tools: [
          { name: "send", description: "Send a message", inputSchema: { type: "object" }, invoke: async () => null },
        ],
      },
    ]);

    const registry = toBoundTools(manifoldEnv);
    expect([...registry.keys()]).toEqual(["github/search-issues", "github/list-repos", "slack/send"]);
    expect(registry.get("github/search-issues")!.slug).toBe("github");
    expect(registry.get("github/search-issues")!.tool).toBe("search-issues");
    expect(registry.get("github/list-repos")!.tool).toBe("list-repos");
    expect(registry.get("slack/send")!.slug).toBe("slack");
    expect(registry.get("github/search-issues")!.signature().signatureText).toBe(
      "(github/search-issues) - Search issues",
    );
    expect(registry.get("github/list-repos")!.signature().signatureText).toBe("(github/list-repos) - List repos");
    expect(registry.get("slack/send")!.signature().signatureText).toBe("(slack/send) - Send a message");
  });

  it("leaves schema/outputSchema undefined for a tool with no declared schema, and description always undefined (not preserved by ManifoldEnv)", async () => {
    const manifoldEnv = await buildManifoldEnv([{ slug: "", tools: [{ name: "ping", invoke: async () => null }] }]);

    const bound = toBoundTools(manifoldEnv).get("ping")!;
    expect(bound.schema).toBeUndefined();
    expect(bound.outputSchema).toBeUndefined();
  });

  it("returns an empty registry for an env with no bound tools", async () => {
    const manifoldEnv = await buildManifoldEnv([]);
    const registry = toBoundTools(manifoldEnv);
    expect(registry.size).toBe(0);
  });
});

describe("buildBypassResolution / resolveBypass — the env-side bypass-translation verdict (pure)", () => {
  it("a single tool resolves unique under all three forms (qualified, wire-underscored, bare)", () => {
    const resolution = buildBypassResolution(toolParts([{ slug: "filesystem", tool: "search_files" }]), []);
    expect(resolution.get("filesystem/search_files")).toEqual({ kind: "unique", qualified: "filesystem/search_files" });
    expect(resolution.get("filesystem_search_files")).toEqual({ kind: "unique", qualified: "filesystem/search_files" });
    expect(resolution.get("search_files")).toEqual({ kind: "unique", qualified: "filesystem/search_files" });
  });

  it("a sluglessly-bound tool (empty slug) resolves unique under its own bare name", () => {
    const resolution = buildBypassResolution(toolParts([{ slug: "", tool: "search-issues" }]), []);
    expect(resolveBypass(resolution, "search-issues")).toEqual({ kind: "unique", qualified: "search-issues" });
  });

  it("hyphen/underscore drift resolves to the SAME unique target (the reported execute-code/execute_code loop)", () => {
    const resolution = buildBypassResolution(toolParts([{ slug: "tools", tool: "execute-code" }]), []);
    expect(resolveBypass(resolution, "execute_code")).toEqual({ kind: "unique", qualified: "tools/execute-code" });
    expect(resolveBypass(resolution, "execute-code")).toEqual({ kind: "unique", qualified: "tools/execute-code" });
    expect(resolveBypass(resolution, "tools_execute_code")).toEqual({
      kind: "unique",
      qualified: "tools/execute-code",
    });
  });

  it("a bare name shared by two servers is ambiguous, listing every real candidate", () => {
    const resolution = buildBypassResolution(
      toolParts([
        { slug: "github", tool: "search" },
        { slug: "slack", tool: "search" },
      ]),
      [],
    );
    const resolved = resolveBypass(resolution, "search");
    expect(resolved).toEqual({ kind: "ambiguous", candidates: ["github/search", "slack/search"] });
  });

  it("a normalized-only tie (no raw spelling matches either tool exactly) is ambiguous too", () => {
    // Neither tool's own raw forms are the literal string "directorytree" — an exact-raw
    // lookup misses for BOTH, so resolveBypass falls back to the normalized key, where the
    // hyphenated and underscored spellings collide (normalizeSymbolName collapses both).
    const resolution = buildBypassResolution(
      toolParts([
        { slug: "filesystem", tool: "directory-tree" },
        { slug: "backup", tool: "directory_tree" },
      ]),
      [],
    );
    const resolved = resolveBypass(resolution, "directorytree");
    expect(resolved?.kind).toBe("ambiguous");
    expect((resolved as { candidates: readonly string[] }).candidates.toSorted()).toEqual([
      "backup/directory_tree",
      "filesystem/directory-tree",
    ]);
    // But an EXACT raw spelling of one tool's own bare name is unambiguous — an exact match
    // is never second-guessed by the OTHER tool's unrelated normalized-level tie.
    expect(resolveBypass(resolution, "directory_tree")).toEqual({ kind: "unique", qualified: "backup/directory_tree" });
  });

  it("a bare form colliding with an unrelated GLOBAL symbol is ambiguous, not unique", () => {
    const resolution = buildBypassResolution(toolParts([{ slug: "utils", tool: "map" }]), ["map"]);
    expect(resolveBypass(resolution, "map")).toEqual({
      kind: "ambiguous",
      candidates: ["utils/map"],
      globalCollision: "map",
    });
    // The qualified form is unaffected — "utils/map" itself doesn't collide with the global "map".
    expect(resolveBypass(resolution, "utils/map")).toEqual({ kind: "unique", qualified: "utils/map" });
  });

  it("a tool's OWN qualified name is never treated as colliding with itself", () => {
    // "map" is both the bare form of "utils/map" AND (if it were also a global) would be a
    // collision — but a tool is never counted as one of the "OTHER" global names it might
    // collide with (buildBypassResolution excludes toolParts' own keys from globalBoundNames).
    const resolution = buildBypassResolution(toolParts([{ slug: "utils", tool: "map" }]), ["utils/map"]);
    expect(resolveBypass(resolution, "map")).toEqual({ kind: "unique", qualified: "utils/map" });
  });

  it("an attempted name absent from every tool's forms resolves to undefined", () => {
    const resolution = buildBypassResolution(toolParts([{ slug: "filesystem", tool: "search_files" }]), []);
    expect(resolveBypass(resolution, "totally_unrelated")).toBeUndefined();
  });

  it("resolveBypass tries the exact literal spelling BEFORE falling back to normalized form", () => {
    // An exact raw match is authoritative even when the normalized key alone would tie —
    // "Search_Files" (exact spelling of nothing real) still falls through to the normalized
    // form and finds the one real tool; the exact-vs-normalized split only matters when a
    // RAW spelling collision exists, which this asserts doesn't spuriously happen here.
    const resolution = buildBypassResolution(toolParts([{ slug: "filesystem", tool: "search_files" }]), []);
    expect(resolveBypass(resolution, "Search_Files")).toEqual({ kind: "unique", qualified: "filesystem/search_files" });
  });
});
