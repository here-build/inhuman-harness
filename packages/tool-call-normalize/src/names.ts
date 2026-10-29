import type { DropReason, ToolDef } from "./types.js";

export function camelToSnake(s: string): string {
  return s.replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_");
}

export function lookupKey(raw: string): string {
  return camelToSnake(raw).toLowerCase();
}

export type NameResolveResult =
  | { ok: true; name: string; renamedFrom?: string }
  | {
      ok: false;
      reason: DropReason;
      name: string;
      ambiguousCandidates?: string[];
      keepAsRaw?: boolean;
    };

/**
 * Resolve a raw tool name per design §6.2.
 * recovered always; native only when caller chooses repair/strict.
 *
 * requireKnownTool (default true when tools[]): for **recovered** calls only,
 * drop unknown names after the ladder. Natives: pass recovered=false so
 * unknown names stay unless mode is strict.
 */
export function resolveName(
  rawIn: string,
  opts: {
    tools?: ToolDef[];
    nameAliases?: Record<string, string>;
    mode: "repair" | "strict" | "pass" | "detect";
    /** When true, unknown catalog names drop even in repair mode. */
    requireKnownTool?: boolean;
    /** Recovered-from-content call (not native tool_calls entry). */
    recovered?: boolean;
  },
): NameResolveResult {
  const raw = rawIn.replace(/^(function|tool|call)\s+/i, "").trim();
  if (!raw) {
    return { ok: false, reason: "empty_name", name: "" };
  }

  const tools = opts.tools;
  const aliases = opts.nameAliases ?? {};
  const key = lookupKey(raw);
  const requireKnown = opts.requireKnownTool ?? Boolean(tools && tools.length > 0);
  const gateUnknown = opts.mode === "strict" || (Boolean(opts.recovered) && requireKnown && Boolean(tools?.length));

  // Exact catalog short-circuit before alias
  if (tools?.some((t) => t.name === raw)) {
    return { ok: true, name: raw };
  }

  const aliasHit = aliases[raw] ?? aliases[key];
  if (aliasHit) {
    if (tools?.length) {
      if (tools.some((t) => t.name === aliasHit)) {
        return { ok: true, name: aliasHit, renamedFrom: raw };
      }
      if (gateUnknown) {
        return { ok: false, reason: "unknown_name", name: aliasHit };
      }
      return { ok: true, name: aliasHit, renamedFrom: raw };
    }
    return { ok: true, name: aliasHit, renamedFrom: raw };
  }

  if (tools?.length) {
    const matches = tools.filter((t) => lookupKey(t.name) === key);
    if (matches.length === 1) {
      const name = matches[0]!.name;
      return name === raw ? { ok: true, name } : { ok: true, name, renamedFrom: raw };
    }
    if (matches.length > 1) {
      const candidates = matches.map((m) => m.name);
      if (opts.mode === "strict" || (opts.recovered && requireKnown)) {
        return {
          ok: false,
          reason: "ambiguous_name",
          name: raw,
          ambiguousCandidates: candidates,
        };
      }
      return {
        ok: false,
        reason: "ambiguous_name",
        name: raw,
        ambiguousCandidates: candidates,
        keepAsRaw: true,
      };
    }
    if (gateUnknown) {
      return { ok: false, reason: "unknown_name", name: raw };
    }
    return { ok: true, name: raw };
  }

  // no tools[]: emit raw (preserve camelCase MCP names)
  return { ok: true, name: raw };
}

export function applyArgAliases(
  toolName: string,
  args: Record<string, string>,
  argAliases?: Record<string, Record<string, string>>,
): Record<string, string> {
  if (!argAliases) return args;
  const specific = argAliases[toolName] ?? {};
  const star = argAliases["*"] ?? {};
  const map = { ...star, ...specific };
  if (Object.keys(map).length === 0) return args;
  const out: Record<string, string> = { ...args };
  for (const [from, to] of Object.entries(map)) {
    if (from in out && !(to in out)) {
      out[to] = out[from]!;
      delete out[from];
    }
    // if target exists, leave source unrenamed (keep both)
  }
  return out;
}
