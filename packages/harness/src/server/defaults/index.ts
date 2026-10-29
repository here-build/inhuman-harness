import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { shippedPolicyFile } from "./policy-asset.js";

const HARNESS_PACKAGE_PREFIX = "@inhuman.tools/harness/";

const POLICY_PROCESSOR_PREFIX = "@inhuman.tools/policy-processor/";

export function defaultCompactSource(): string {
  return readFileSync(join(defaultsDir(), "compact.scm"), "utf8");
}

/**
 * The shipped default strategy is a `.scm` that `require`s `compact.prompt`
 * from its own directory. A package that lost the prompt has lost the
 * strategy: throw, so the loader falls to the keep-first failsafe (and says so)
 * instead of running a program that fails on its first line.
 */
export function defaultCompactStrategySource(): string {
  const prompt = join(packageRoot(), "compact.prompt");
  if (!existsSync(prompt)) throw new Error(`shipped compaction prompt is missing: ${prompt}`);
  return readFileSync(join(packageRoot(), "compact.scm"), "utf8");
}

/** Absolute path of the shipped default strategy; the module root for its `require`s. */
export function packageStrategyPath(): string {
  return join(packageRoot(), "compact.scm");
}

/**
 * `config.json` `compact` is a path, so the strategy is visible and editable.
 * Relative paths resolve against the kernel root.
 * The default `@inhuman.tools/harness/compact.scm` token names this package.
 * Other bare specifiers resolve as npm packages installed in the kernel root.
 */
export function resolveCompactStrategyPath(spec: string, root: string): string {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error("compact strategy path is empty");
  if (trimmed.startsWith(".") || isAbsolute(trimmed)) return resolve(root, trimmed);
  if (trimmed.startsWith(POLICY_PROCESSOR_PREFIX)) {
    return shippedPolicyFile(trimmed.slice(POLICY_PROCESSOR_PREFIX.length));
  }
  if (trimmed.startsWith(HARNESS_PACKAGE_PREFIX)) {
    return join(packageRoot(), trimmed.slice(HARNESS_PACKAGE_PREFIX.length));
  }
  return createRequire(join(root, "package.json")).resolve(trimmed);
}

export type DefaultCommandVerb = "connect" | "model" | "mcp";

const DEFAULT_COMMANDS: Record<DefaultCommandVerb, { readonly description: string }> = {
  connect: { description: "Manage provider connections" },
  model: { description: "Session model" },
  mcp: { description: "MCP connections" },
};

function defaultCommandPath(verb: DefaultCommandVerb): string {
  return join(defaultsDir(), "commands", `${verb}.scm`);
}

export function defaultCommands(): readonly {
  readonly verb: DefaultCommandVerb;
  readonly description: string;
  readonly source: string;
  readonly body: string;
}[] {
  return (["connect", "model", "mcp"] as const).map((verb) => ({
    verb,
    description: DEFAULT_COMMANDS[verb].description,
    source: defaultCommandPath(verb),
    body: readFileSync(defaultCommandPath(verb), "utf8"),
  }));
}

export function defaultsDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Dist (`dist/server/defaults`) does not copy the .scm assets.
  const candidates = [here, join(here, "../../../src/server/defaults")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "compact.scm"))) return dir;
  }
  return candidates[0];
}

/** `src/server/defaults` and `dist/server/defaults` are three up from the package root. */
function packageRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}
