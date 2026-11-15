import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";

import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { jailedInside } from "./jail.js";
import { behaviorSelectionSchema } from "./schemas/bot-definition.js";
import { pluginManifestSchema } from "./schemas/plugin-manifest.js";
import { PluginSurfaceError } from "./surface-error.js";

const WARM_TEXT_EXTS = new Set([".json", ".scm", ".prompt", ".md", ".hbs", ".yaml", ".yml", ".txt"]);
const immutableRoots = new Set<string>();
const fileTextCache = new Map<string, string>();
const surfaceCache = new Map<string, ResolvedSurface>();
const warmedPaths = new Set<string>();
let diskReadCount = 0;

export function pluginDiskReadCount(): number {
  return diskReadCount;
}

export function resetPluginDiskReadCount(): void {
  diskReadCount = 0;
}

export function markImmutablePluginRoot(root: string): void {
  const resolved = resolve(root);
  immutableRoots.add(resolved);
  warmedPaths.add(resolved);
  try {
    const real = realpathSync(resolved);
    immutableRoots.add(real);
    warmedPaths.add(real);
  } catch {
    /* non-existent path stays registered under its resolved form */
  }
}

export function isImmutablePluginRoot(pathOrRoot: string): boolean {
  const resolved = resolve(pathOrRoot);
  for (const root of immutableRoots) {
    if (resolved === root || resolved.startsWith(`${root}${sep}`)) return true;
  }
  return false;
}

export function hasCachedPluginText(filePath: string): boolean {
  return fileTextCache.has(resolve(filePath));
}

export function readPluginText(filePath: string, immutable?: boolean): string {
  const resolved = resolve(filePath);
  const useCache = immutable === true || isImmutablePluginRoot(resolved);
  if (useCache) {
    const cached = fileTextCache.get(resolved);
    if (cached !== undefined) return cached;
  }
  diskReadCount += 1;
  const text = readFileSync(resolved, "utf8");
  if (useCache) {
    fileTextCache.set(resolved, text);
    warmedPaths.add(resolved);
    try {
      const real = realpathSync(resolved);
      if (real !== resolved) {
        fileTextCache.set(real, text);
        warmedPaths.add(real);
      }
    } catch {
      /* ignore realpath miss */
    }
  }
  return text;
}

function walkWarmDir(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      warmedPaths.add(child);
      walkWarmDir(child);
    } else if (entry.isFile()) {
      warmedPaths.add(child);
      if (WARM_TEXT_EXTS.has(extname(entry.name).toLowerCase())) {
        readPluginText(child, true);
      }
    }
  }
}

/** Preload an immutable bundled plugin directory into memory so runtime boot reads zero files from disk. */
export function warmPluginDirectory(root: string): ResolvedSurface {
  const resolved = resolve(root);
  markImmutablePluginRoot(resolved);
  if (existsSync(resolved)) {
    walkWarmDir(resolved);
  }
  return resolvePackageSurface(resolved, { immutable: true });
}

export type BehaviorSelection = z.infer<typeof behaviorSelectionSchema>;

export type ResolvedBehavior = BehaviorSelection & {
  readonly programPath: string;
  readonly programSource: string;
  readonly environmentPath: string;
};

export type BotScope = "session" | "project" | "global";

export type ResolvedBot = {
  readonly path: string;
  /** File stem. */
  readonly name: string;
  /** Frontmatter `attach: foreground`: the bot is the foreground agent's behavior, not a named agent. */
  readonly foreground: boolean;
  /** Where one named instance lives. Session unless the frontmatter says otherwise. */
  readonly recipeScope: BotScope;
  readonly description: string;
  readonly instructions: string;
  /** Declared tool ceiling. `null` when the file does not declare one. */
  readonly tools: readonly string[] | null;
  readonly behavior: ResolvedBehavior | null;
};

export type ResolvedSurface = {
  readonly bots: readonly ResolvedBot[];
  readonly skills: readonly string[];
  /** Model-tool program. Null when the manifest declares none. */
  readonly abi: { readonly path: string; readonly source: string } | null;
  readonly states: readonly {
    readonly scope: "session" | "project" | "global";
    readonly path: string;
    readonly source: string;
  }[];
  readonly mcp: readonly {
    readonly name: string;
    readonly visibility: "private" | "public";
  }[];
};

function readJailed(
  root: string,
  spec: string,
  fromFile?: string,
  immutable?: boolean,
): { readonly path: string; readonly source: string } {
  const base = fromFile == null ? root : dirname(fromFile);
  const path = jailedInside(root, resolve(base, spec));
  PluginSurfaceError.invariant(path != null, `package escape: ${spec}`);
  PluginSurfaceError.invariant(hasCachedPluginText(path) || existsSync(path), `missing source: ${spec}`);
  return { path, source: readPluginText(path, immutable) };
}

function frontmatter(text: string): {
  readonly head: Record<string, unknown>;
  readonly body: string;
} {
  if (!text.startsWith("---")) return { head: {}, body: text };
  const close = text.indexOf("\n---", 3);
  PluginSurfaceError.invariant(close !== -1, "unterminated frontmatter");
  const raw: unknown = parseYaml(text.slice(3, close).replace(/^\n/, ""));
  PluginSurfaceError.invariant(
    !(raw == null || typeof raw !== "object" || Array.isArray(raw)),
    "frontmatter must be a map",
  );
  const body = text.slice(close + 4).replace(/^\r?\n/, "");
  return { head: raw as Record<string, unknown>, body };
}

export function parseBehaviorBlock(raw: unknown): BehaviorSelection | null {
  if (raw == null) return null;
  const parsed = behaviorSelectionSchema.safeParse(raw);
  PluginSurfaceError.invariant(parsed.success, "invalid behavior configuration");
  return parsed.data;
}

export function resolvePackageSurface(root: string, options?: { readonly immutable?: boolean }): ResolvedSurface {
  const resolvedRoot = resolve(root);
  const useImmutable = options?.immutable === true || isImmutablePluginRoot(resolvedRoot);
  if (useImmutable) {
    const cached = surfaceCache.get(resolvedRoot);
    if (cached !== undefined) return cached;
  }
  const manifest = pluginManifestSchema.parse(
    JSON.parse(readPluginText(resolve(resolvedRoot, "plugin.json"), useImmutable)),
  );
  const ext = manifest.extensions["tools.inhuman"];
  const bots = ext.bots.map((spec): ResolvedBot => {
    const file = readJailed(resolvedRoot, spec, undefined, useImmutable);
    const { head, body } = frontmatter(file.source);
    PluginSurfaceError.invariant(
      head.attach == null || head.attach === "foreground",
      'bot attach must be "foreground"',
    );
    const foreground = head.attach === "foreground";
    const declaredScope = head.recipeScope ?? head.scope;
    PluginSurfaceError.invariant(declaredScope == null || !foreground, "a foreground bot has no recipe scope");
    let recipeScope: BotScope = "session";
    if (declaredScope != null) {
      PluginSurfaceError.invariant(
        declaredScope === "session" || declaredScope === "project" || declaredScope === "global",
        "recipe scope must be session, project, or global",
      );
      recipeScope = declaredScope;
    }
    let tools: readonly string[] | null = null;
    if (head.tools != null) {
      PluginSurfaceError.invariant(Array.isArray(head.tools), "bot tools must be a list of names");
      const items: readonly unknown[] = head.tools;
      const names: string[] = [];
      for (const item of items) {
        PluginSurfaceError.invariant(typeof item === "string", "bot tools must be a list of names");
        names.push(item);
      }
      tools = names;
    }
    const shape = {
      path: file.path,
      name: basename(file.path, extname(file.path)),
      foreground,
      recipeScope,
      description: typeof head.description === "string" ? head.description : "",
      instructions: body.trim(),
      tools,
    };
    const behavior = parseBehaviorBlock(head.behavior);
    if (behavior == null) return { ...shape, behavior: null };
    const program = readJailed(resolvedRoot, behavior.program, file.path, useImmutable);
    const environment =
      behavior.environment == null ? "" : readJailed(resolvedRoot, behavior.environment, file.path, useImmutable).path;
    return {
      ...shape,
      behavior: {
        ...behavior,
        programPath: program.path,
        programSource: program.source,
        environmentPath: environment,
      },
    };
  });
  const states = (["session", "project", "global"] as const).flatMap((scope) => {
    const spec = ext.states?.[scope];
    if (spec == null) return [];
    const file = readJailed(resolvedRoot, spec, undefined, useImmutable);
    return [{ scope, path: file.path, source: file.source }];
  });
  for (const skill of ext.skills) {
    const path = jailedInside(resolvedRoot, resolve(resolvedRoot, skill));
    PluginSurfaceError.invariant(path != null, `package escape: ${skill}`);
    const alreadyKnown = useImmutable && (warmedPaths.has(path) || hasCachedPluginText(path));
    PluginSurfaceError.invariant(alreadyKnown || existsSync(path), `missing source: ${skill}`);
  }
  const surface: ResolvedSurface = {
    bots,
    skills: ext.skills,
    abi: ext.abi == null ? null : readJailed(resolvedRoot, ext.abi, undefined, useImmutable),
    states,
    mcp: ext.mcp.map((server) => ({
      name: server.name,
      visibility: server.visibility,
    })),
  };
  if (useImmutable) {
    surfaceCache.set(resolvedRoot, surface);
  }
  return surface;
}
