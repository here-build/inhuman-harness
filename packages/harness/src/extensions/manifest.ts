import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { jailedInside } from "./jail.js";
import { behaviorSelectionSchema } from "./schemas/bot-definition.js";
import { pluginManifestSchema } from "./schemas/plugin-manifest.js";
import { PluginSurfaceError } from "./surface-error.js";

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

function readJailed(root: string, spec: string, fromFile?: string): { readonly path: string; readonly source: string } {
  const base = fromFile == null ? root : dirname(fromFile);
  const path = jailedInside(root, resolve(base, spec));
  PluginSurfaceError.invariant(path != null, `package escape: ${spec}`);
  PluginSurfaceError.invariant(existsSync(path), `missing source: ${spec}`);
  return { path, source: readFileSync(path, "utf8") };
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

export function resolvePackageSurface(root: string): ResolvedSurface {
  const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(resolve(root, "plugin.json"), "utf8")));
  const ext = manifest.extensions["tools.inhuman"];
  const bots = ext.bots.map((spec): ResolvedBot => {
    const file = readJailed(root, spec);
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
    const program = readJailed(root, behavior.program, file.path);
    const environment = behavior.environment == null ? "" : readJailed(root, behavior.environment, file.path).path;
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
    const file = readJailed(root, spec);
    return [{ scope, path: file.path, source: file.source }];
  });
  for (const skill of ext.skills) {
    const path = jailedInside(root, resolve(root, skill));
    PluginSurfaceError.invariant(path != null, `package escape: ${skill}`);
    PluginSurfaceError.invariant(existsSync(path), `missing source: ${skill}`);
  }
  return {
    bots,
    skills: ext.skills,
    abi: ext.abi == null ? null : readJailed(root, ext.abi),
    states,
    mcp: ext.mcp.map((server) => ({
      name: server.name,
      visibility: server.visibility,
    })),
  };
}
