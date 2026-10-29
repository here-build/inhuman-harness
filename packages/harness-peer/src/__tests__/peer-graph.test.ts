import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const peerSrc = resolve(import.meta.dirname, "..");
const repo = resolve(peerSrc, "../../..");

const WORKSPACE: Record<string, string> = {
  "@inhuman.tools/harness-model": "packages/harness-model/src/index.ts",
  "@inhuman.tools/harness-commons": "packages/harness-commons/src/index.ts",
  "@inhuman.tools/harness-contract": "packages/harness-contract/src/index.ts",
  "@inhuman.tools/plexus-expectations": "packages/plexus-expectations/src/index.ts",
};

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const base = resolve(dirname(fromFile), spec);
    return withSuffix(base);
  }
  const workspace = WORKSPACE[spec];
  if (workspace !== undefined) return join(repo, workspace);
  const sub = Object.keys(WORKSPACE).find((key) => spec.startsWith(`${key}/`));
  if (sub !== undefined) {
    const root = WORKSPACE[sub];
    if (root === undefined) return null;
    const rest = spec.slice(sub.length + 1);
    return withSuffix(join(repo, dirname(root), rest));
  }
  return null;
}

function withSuffix(base: string): string {
  const stem = base.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = [stem, `${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return `${base}.ts`;
}

function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("import type") || trimmed.startsWith("export type")) continue;
    const match = trimmed.match(/from ["']([^"']+)["']/) ?? trimmed.match(/^import ["']([^"']+)["']/);
    const spec = match?.[1];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

describe("browser peer graph", () => {
  it("does not import node: or ws", () => {
    const banned: string[] = [];
    const seen = new Set<string>();
    const queue = [join(peerSrc, "index.ts")];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const spec of specifiers(source)) {
        if (spec.startsWith("node:") || spec === "ws" || spec.startsWith("ws/")) {
          banned.push(`${file} → ${spec}`);
          continue;
        }
        const next = resolveSpecifier(file, spec);
        if (next !== null) queue.push(next);
      }
    }
    expect(banned).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });
});
