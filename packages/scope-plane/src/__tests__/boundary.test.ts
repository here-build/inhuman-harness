import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));

const MODEL_PACKAGES = ["packages/harness-model", "packages/expectations"] as const;
const SCOPE_PACKAGES = [
  "packages/scope-plane",
  "packages/scope-plane-tinybase",
  "packages/scope-plane-electric",
  "packages/scope-plane-sqlite",
  "packages/scope-plane-postgres",
] as const;

const STORAGE = ["tinybase", "@electric-sql/client", "better-sqlite3", "drizzle-orm", "pg"] as const;
const SCOPE_NAMES = [
  "@inhuman.tools/scope-plane",
  "@inhuman.tools/scope-plane-tinybase",
  "@inhuman.tools/scope-plane-electric",
  "@inhuman.tools/scope-plane-sqlite",
  "@inhuman.tools/scope-plane-postgres",
] as const;
const MODEL_NAMES = ["@inhuman.tools/harness-model", "@inhuman.tools/expectations"] as const;

const ERASED_YJS_STACK = [
  "yjs",
  "y-protocols",
  "lib0",
  "y-websocket",
  "@here.build/plexus",
  "@inhuman.tools/plexus-expectations",
] as const;

const LEGACY_SOURCE_ROOTS = [
  "packages",
  "packages-runtime",
  "surfaces",
  "plugins",
  "packages-policy",
  "packages-statusline",
  "packages-activity",
  "packages-continuation",
  "env-capabilities",
  "extras",
  "internal",
  "scripts",
] as const;

const LEGACY_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

const LEGACY_SYMBOL_PATTERNS = [
  /\b\w+Plexus\b/,
  /\b\w*PlexusAwareness\b/,
  /\bPEWDriver\b/,
  /\bPEW_DRIVER_BRAND\b/,
  /\bpewBrand\b/,
  /\bpewConfigurationSchema\b/,
  /\bpewSecretsSchema\b/,
  /\battachPlexus\b/,
  /@inhuman\.tools\/plexus-expectations\b/,
  /@here\.build\/plexus\b/,
] as const;

const LEGACY_SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "target", "coverage", "build", ".git"]);
const LEGACY_SELF_FILE = "packages/scope-plane/src/__tests__/boundary.test.ts";
/** Deprecated compatibility alias kept explicitly for v0.3 downstream migration. */
const DEPRECATED_COMPAT_ALLOWLIST: Readonly<Record<string, ReadonlySet<string>>> = {
  SessionPlexus: new Set([
    "packages/harness-model/src/session/SessionDocument.ts",
    "packages/harness-model/src/session/__tests__/registration.test.ts",
  ]),
  "@inhuman.tools/plexus-expectations": new Set([
    "packages/scope-plane-sqlite/src/sqlite-migration.ts",
    "packages/scope-plane-sqlite/src/__tests__/sqlite-kv-store.test.ts",
  ]),
};

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
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

async function sourceFiles(relDir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(join(repo, relDir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (LEGACY_SKIP_DIRS.has(entry.name)) continue;
    const rel = `${relDir}/${entry.name}`;
    if (rel === LEGACY_SELF_FILE || rel.startsWith("docs/architecture-rebuild/")) continue;
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(rel)));
    } else if (LEGACY_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      found.push(rel);
    }
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
  it("keeps model packages and the scope packages on opposite sides of the port", async () => {
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
      if (
        name !== "@inhuman.tools/harness-contract" &&
        name !== "@inhuman.tools/scope-plane" &&
        name !== "@electric-sql/client"
      ) {
        violations.push(`scope-plane-electric depends on ${name}`);
      }
    }
    const corePkg = await packageManifest("packages/scope-plane");
    const coreAllDeps = {
      ...depBlock(corePkg, "dependencies"),
      ...depBlock(corePkg, "devDependencies"),
      ...depBlock(corePkg, "peerDependencies"),
    };
    for (const banned of ["better-sqlite3", "drizzle-orm", "pg", "@electric-sql/client", "tinybase"]) {
      if (namesOf(banned, Object.keys(coreAllDeps)) != null) {
        violations.push(`packages/scope-plane depends on ${banned}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane/src")) {
      const banned = namesOf(hit.specifier, [
        "better-sqlite3",
        "drizzle-orm",
        "pg",
        "node:sqlite",
        "@electric-sql/client",
        "tinybase",
      ]);
      if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
    }

    const sqlitePkg = await packageManifest("packages/scope-plane-sqlite");
    for (const name of Object.keys(depBlock(sqlitePkg, "dependencies"))) {
      if (name !== "@inhuman.tools/harness-contract" && name !== "@inhuman.tools/scope-plane") {
        violations.push(`scope-plane-sqlite runtime depends on ${name}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane-sqlite/src")) {
      const banned = namesOf(hit.specifier, ["drizzle-orm", "pg", "@electric-sql/client", "tinybase"]);
      if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
    }

    const postgresPkg = await packageManifest("packages/scope-plane-postgres");
    for (const name of Object.keys(depBlock(postgresPkg, "dependencies"))) {
      if (name !== "@inhuman.tools/harness-contract" && name !== "@inhuman.tools/scope-plane") {
        violations.push(`scope-plane-postgres runtime depends on ${name}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane-postgres/src")) {
      const banned = namesOf(hit.specifier, [
        "better-sqlite3",
        "drizzle-orm",
        "node:sqlite",
        "@electric-sql/client",
        "tinybase",
      ]);
      if (banned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
    }

    for (const hit of await importsUnder("packages/scope-plane-tinybase/src")) {
      if (namesOf(hit.specifier, ["@electric-sql/client", "tinybase/persisters/persister-electric"]) != null) {
        violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }
    for (const hit of await importsUnder("packages/scope-plane-electric/src")) {
      if (namesOf(hit.specifier, ["tinybase", "better-sqlite3", "drizzle-orm"]) != null) {
        violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }

    const harness = await packageManifest("packages/harness");
    for (const banned of [
      "better-sqlite3",
      "drizzle-orm",
      "pg",
      "@inhuman.tools/scope-plane-postgres",
      "@inhuman.tools/scope-plane-electric",
      "tinybase",
    ]) {
      expect(harness.dependencies).not.toHaveProperty(banned);
    }
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
      if (!hit.file.includes("/__tests__/")) {
        const runtimeBanned = namesOf(hit.specifier, [
          "better-sqlite3",
          "drizzle-orm",
          "pg",
          "@inhuman.tools/scope-plane-postgres",
        ]);
        if (runtimeBanned != null) violations.push(`${hit.file} imports ${hit.specifier}`);
      }
    }

    const rootIndex = await readFile(join(repo, "packages/scope-plane/src/index.ts"), "utf8");
    if (/export\s+(?!type\b)[^;]*from\s+["']\.\/(sqlite-database|lane-server)\.js["']/.test(rootIndex)) {
      violations.push("packages/scope-plane/src/index.ts re-exports runtime SQLite modules into browser entry point");
    }

    expect(violations).toEqual([]);
  });

  it("erases yjs, y-protocols, lib0, y-websocket, @here.build/plexus, and @inhuman.tools/plexus-expectations across the entire workspace", async () => {
    const violations: string[] = [];
    const workspaceDirs: string[] = ["."];

    for (const root of ["packages", "packages-runtime", "surfaces", "plugins"]) {
      let entries;
      try {
        entries = await readdir(join(repo, root), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rel = `${root}/${entry.name}`;
        try {
          await readFile(join(repo, rel, "package.json"), "utf8");
          workspaceDirs.push(rel);
        } catch {
          // Non-JS directory (e.g. rust crate root without package.json)
        }
      }
    }

    for (const dir of workspaceDirs) {
      const pkg = await packageManifest(dir);
      const deps = {
        ...depBlock(pkg, "dependencies"),
        ...depBlock(pkg, "devDependencies"),
        ...depBlock(pkg, "peerDependencies"),
        ...depBlock(pkg, "optionalDependencies"),
      };
      for (const name of Object.keys(deps)) {
        if (namesOf(name, ERASED_YJS_STACK) != null) {
          violations.push(`${dir}/package.json depends on ${name}`);
        }
      }
      if (dir !== ".") {
        for (const hit of await importsUnder(dir)) {
          if (namesOf(hit.specifier, ERASED_YJS_STACK) != null) {
            violations.push(`${hit.file} imports ${hit.specifier}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("bans legacy *Plexus, PlexusAwareness, and PEW symbols across workspace source", async () => {
    const violations: string[] = [];

    for (const root of LEGACY_SOURCE_ROOTS) {
      for (const rel of await sourceFiles(root)) {
        const text = await readFile(join(repo, rel), "utf8");
        for (const [index, line] of text.split("\n").entries()) {
          for (const pattern of LEGACY_SYMBOL_PATTERNS) {
            const match = pattern.exec(line);
            if (match != null && !DEPRECATED_COMPAT_ALLOWLIST[match[0]]?.has(rel)) {
              violations.push(`${rel}:${index + 1} (${match[0]})`);
            }
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
