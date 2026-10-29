/**
 * Fixture harness — loads JSON cases under fixtures/** and asserts
 * normalizeMessage / createStreamSession against sources (vitest alias → src/).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import { normalizeMessage, ensureBuiltins, type NormalizeOptions, type ToolCall, type MessageInput } from "../index.js";
import { resetRegistryForTests } from "./reset-registry.js";
import { collectEvents } from "./stream-harness.js";

const fixturesRoot = fileURLToPath(new URL("fixtures", import.meta.url));

export type FixtureExpect = {
  tool_calls: Array<{ name: string; arguments: unknown }>;
  content?: string | null;
  /**
   * Substrings the content must contain / must not contain. Use when the exact
   * content is incidental and only the presence of prose (or the absence of
   * leaked markup) is the point. `content` still asserts equality; the two
   * compose.
   */
  contentContains?: string[];
  contentExcludes?: string[];
  finish_reason?: string | null;
  meta?: {
    dropped?: Array<{ name?: string; reason: string }>;
    partial?: number[];
    estimated?: boolean;
  };
};

export type FixtureCase = {
  id: string;
  input: MessageInput;
  opts?: NormalizeOptions;
  expect: FixtureExpect;
  /** If set, run createStreamSession over these chunks instead of batch. */
  chunks?: string[];
};

export function listFixtureFiles(dir = fixturesRoot): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".json") && name !== "categories.json") out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export function loadFixture(path: string): FixtureCase {
  const raw = readFileSync(path, "utf8");
  const data = JSON.parse(raw) as FixtureCase;
  if (!data.id) {
    data.id = relative(fixturesRoot, path).replace(/\.json$/, "");
  }
  return data;
}

export function loadAllFixtures(): Array<{ path: string; case: FixtureCase }> {
  return listFixtureFiles().map((path) => ({ path, case: loadFixture(path) }));
}

/** categories.json lists dirs that must each contain ≥1 fixture (audit-010 C3). */
export function assertFixtureFloor(): void {
  const catPath = join(fixturesRoot, "categories.json");
  const raw = readFileSync(catPath, "utf8");
  const { categories } = JSON.parse(raw) as { categories: string[] };
  expect(categories.length).toBeGreaterThan(0);
  const all = listFixtureFiles();
  expect(all.length).toBeGreaterThan(0);
  for (const cat of categories) {
    const hits = all.filter((p) => p.includes(`/${cat}/`) || p.includes(`\\${cat}\\`));
    expect(hits.length, `category ${cat} has no fixtures`).toBeGreaterThan(0);
  }
}

export function assertArgsAreStrings(tool_calls: ToolCall[]): void {
  for (const tc of tool_calls) {
    expect(typeof tc.function.arguments).toBe("string");
  }
}

function parseArgs(tc: ToolCall): unknown {
  try {
    return JSON.parse(tc.function.arguments);
  } catch {
    return tc.function.arguments;
  }
}

export function assertToolCalls(actual: ToolCall[], expected: FixtureExpect["tool_calls"]): void {
  expect(
    actual.map((t) => ({
      name: t.function.name,
      arguments: parseArgs(t),
    })),
  ).toEqual(expected);
}

function assertContent(actual: string | null, fx: FixtureExpect): void {
  if (fx.content !== undefined) expect(actual).toBe(fx.content);
  for (const s of fx.contentContains ?? []) expect(actual ?? "").toContain(s);
  for (const s of fx.contentExcludes ?? []) {
    expect(actual ?? "").not.toContain(s);
  }
}

function wantsContent(fx: FixtureExpect): boolean {
  return fx.content !== undefined || !!fx.contentContains?.length || !!fx.contentExcludes?.length;
}

export async function runFixtureCase(fx: FixtureCase): Promise<void> {
  resetRegistryForTests();
  ensureBuiltins();

  if (fx.chunks) {
    const events = collectEvents(fx.chunks, fx.opts);
    const ends = events
      .filter((e) => e.type === "tool_call_end")
      .map(
        (e) =>
          e as unknown as {
            name: string;
            arguments: string;
            partial?: boolean;
          },
      );
    const executable = ends.filter((e) => !e.partial);
    assertToolCalls(
      executable.map((e, i) => ({
        id: `stream_${i}`,
        type: "function" as const,
        function: { name: e.name, arguments: e.arguments },
      })),
      fx.expect.tool_calls,
    );
    if (wantsContent(fx.expect)) {
      const text = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e.type === "text_delta" ? e.text : ""))
        .join("");
      const content = text.trimEnd().length > 0 ? text.trimEnd() : null;
      assertContent(content, fx.expect);
    }
    return;
  }

  const r = normalizeMessage(fx.input, fx.opts);
  assertArgsAreStrings(r.tool_calls);
  assertToolCalls(r.tool_calls, fx.expect.tool_calls);
  assertContent(r.content, fx.expect);
  if (fx.expect.finish_reason !== undefined) {
    expect(r.finish_reason).toBe(fx.expect.finish_reason);
  }
  if (fx.expect.meta?.dropped) {
    expect(
      r.meta.dropped.map((d) => ({
        name: d.name || undefined,
        reason: d.reason,
      })),
    ).toEqual(
      expect.arrayContaining(
        fx.expect.meta.dropped.map((d) =>
          expect.objectContaining({
            reason: d.reason,
            name: d.name,
          }),
        ),
      ),
    );
  }
  if (fx.expect.meta?.partial) {
    expect(r.meta.partial).toEqual(fx.expect.meta.partial);
  }
  if (fx.expect.meta?.estimated !== undefined) {
    expect(r.meta.estimated).toBe(fx.expect.meta.estimated);
  }
}
