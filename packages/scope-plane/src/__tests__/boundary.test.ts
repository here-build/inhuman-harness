import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));

const MODEL_PACKAGES = ["packages/harness-model", "packages/plexus-expectations"] as const;
const SCOPE_PACKAGES = [
  "packages/scope-plane",
  "packages/scope-plane-tinybase",
  "packages/scope-plane-electric",
] as const;

const STORAGE = ["tinybase", "@electric-sql/client"] as const;
const SCOPE_NAMES = [
  "@inhuman.tools/scope-plane",
  "@inhuman.tools/scope-plane-tinybase",
  "@inhuman.tools/scope-plane-electric",
] as const;
const MODEL_NAMES = [
  "@here.build/plexus",
  "@inhuman.tools/harness-model",
  "@inhuman.tools/plexus-expectations",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depBlock(manifest: Record<string, unknown>, key: string): Record<string, string> {
  const value = manifest[key];
  if (!isRecord(value)) return {};
  const names: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec === "string") names[name] = spec;
  }
  return names;
}

function namesOf(specifier: string, banned: readonly string[]): string | undefined {
  return banned.find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

async function packageManifest(dir: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(repo, dir, "package.json"), "utf8"));
  if (!isRecord(parsed)) throw new Error(`${dir} package.json is not an object`);
  return parsed;
}

async function tsFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await tsFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

async function importsUnder(dir: string): Promise<Array<{ file: string; specifier: string }>> {
  const found: Array<{ file: string; specifier: string }> = [];
  const pattern = /from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
  for (const file of await tsFiles(join(repo, dir))) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] || match[2] || match[3];
      if (specifier !== "") found.push({ file: file.slice(repo.length + 1), specifier });
    }
  }
  return found;
}

describe("scope tree boundary", () => {
  it("keeps plexus models and the scope packages on opposite sides of the port", async () => {
    const violations: string[] = [];

    for (const dir of MODEL_PACKAGES) {
      const pkg = await packageManifest(dir);
      const deps = {
        ...depBlock(pkg, "dependencies"),
        ...depBlock(pkg, "devDependencies"),
        ...depBlock(pkg, "peerDependencies"),
      };
      for (const name of [...SCOPE_NAMES, ...STORAGE]) {
        if (namesOf(name, Object.keys(deps)) != null) violations.push(`${dir} depends on ${name}`);
      }
      for (const hit of await importsUnder(`${dir}/src`)) {
        const banned = namesOf(hit.specifier, [...SCOPE_NAMES, ...STORAGE]);
        if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }

    for (const dir of SCOPE_PACKAGES) {
      const pkg = await packageManifest(dir);
      const deps = {
        ...depBlock(pkg, "dependencies"),
        ...depBlock(pkg, "devDependencies"),
        ...depBlock(pkg, "peerDependencies"),
      };
      for (const name of MODEL_NAMES) {
        if (namesOf(name, Object.keys(deps)) != null) violations.push(`${dir} depends on ${name}`);
      }
      for (const hit of await importsUnder(`${dir}/src`)) {
        const banned = namesOf(hit.specifier, MODEL_NAMES);
        if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }

    const tiny = depBlock(await packageManifest("packages/scope-plane-tinybase"), "dependencies");
    for (const name of Object.keys(tiny)) {
      if (name !== "@inhuman.tools/scope-plane" && name !== "tinybase") {
        violations.push(`scope-plane-tinybase depends on ${name}`);
      }
    }
    const electric = depBlock(await packageManifest("packages/scope-plane-electric"), "dependencies");
    for (const name of Object.keys(electric)) {
      if (name !== "@inhuman.tools/scope-plane" && name !== "@electric-sql/client") {
        violations.push(`scope-plane-electric depends on ${name}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane-tinybase/src")) {
      if (namesOf(hit.specifier, ["@electric-sql/client", "tinybase/persisters/persister-electric"]) != null) {
        violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane-electric/src")) {
      if (namesOf(hit.specifier, ["tinybase"]) != null) violations.push(`${hit.file} imports ${hit.specifier}`);
    }

    const harness = await packageManifest("packages/harness");
    const harnessDeps = {
      ...depBlock(harness, "dependencies"),
      ...depBlock(harness, "devDependencies"),
      ...depBlock(harness, "peerDependencies"),
    };
    for (const name of ["@inhuman.tools/scope-plane-electric", "@electric-sql/client", "tinybase"]) {
      if (namesOf(name, Object.keys(harnessDeps)) != null) violations.push(`harness depends on ${name}`);
    }
    for (const dir of ["packages/harness-sdk/src", "packages/harness/src/tui"]) {
      for (const hit of await importsUnder(dir)) {
        const banned = namesOf(hit.specifier, [
          "@inhuman.tools/scope-plane-tinybase",
          "@inhuman.tools/scope-plane-electric",
          "tinybase",
          "@electric-sql/client",
        ]);
        if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }
    for (const hit of await importsUnder("packages/harness/src")) {
      const banned = namesOf(hit.specifier, [
        "@inhuman.tools/scope-plane-electric",
        "@electric-sql/client",
        "tinybase",
      ]);
      if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
    }

    expect(violations).toEqual([]);
  });
});
