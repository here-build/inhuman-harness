import { LONGCAT_ARG_ALIASES, LONGCAT_NAME_ALIASES } from "./aliases.js";
import { ensureBuiltins, getDialect, listDialects } from "./dialects/registry.js";
import type { Dialect, NormalizeOptions } from "./types.js";

const HINT_TABLE: Array<{ re: RegExp; dialect: string }> = [
  { re: /^longcat/i, dialect: "longcat" },
  { re: /qwen3.*coder|qwen3_xml/i, dialect: "qwen_xml" },
  { re: /qwen|qwq|hermes/i, dialect: "hermes" },
  { re: /llama-?3|meta-llama\/Llama-3/i, dialect: "llama3_json" },
  { re: /mistral|mixtral|ministral/i, dialect: "mistral" },
  { re: /deepseek.*v3\.?1/i, dialect: "deepseek_v31" },
  { re: /deepseek/i, dialect: "deepseek_v3" },
  { re: /glm|chatglm/i, dialect: "glm_xml" },
  { re: /^(gpt-|o1|o3|claude)/i, dialect: "openai" },
];

export function mapModelHint(hint: string | undefined): string | undefined {
  if (!hint) return undefined;
  const exact = getDialect(hint);
  if (exact) return exact.id;
  for (const row of HINT_TABLE) {
    if (row.re.test(hint)) return row.dialect;
  }
  return undefined;
}

export function resolveDialectId(text: string, opts: NormalizeOptions): { dialect: Dialect | null; id: string } {
  ensureBuiltins();
  if (opts.dialect && opts.dialect !== "auto") {
    const d = getDialect(opts.dialect);
    return { dialect: d ?? null, id: opts.dialect };
  }
  const fromHint = mapModelHint(opts.modelHint);
  if (fromHint) {
    const d = getDialect(fromHint);
    if (d) return { dialect: d, id: d.id };
    // Unimplemented dialect (P1/P2): fall through to auto so real markup still
    // recovers (audit-007 F2). Markerless openai never maps here.
  }
  // auto cascade by autoPriority, marker hit
  for (const d of listDialects()) {
    if (!d.allowAuto || d.markers.length === 0) continue;
    for (const marker of d.markers) {
      const pos = text.toLowerCase().indexOf(marker.toLowerCase());
      if (pos === -1) continue;
      if (d.claim && !d.claim(text, pos)) continue;
      return { dialect: d, id: d.id };
    }
  }
  return { dialect: null, id: "none" };
}

/** Merge longcat aliases when dialect is longcat. */
export function effectiveAliases(
  dialectId: string,
  opts: NormalizeOptions,
): {
  nameAliases: Record<string, string>;
  argAliases: Record<string, Record<string, string>>;
} {
  const nameAliases = { ...(opts.nameAliases ?? {}) };
  const argAliases = { ...(opts.argAliases ?? {}) };
  if (dialectId === "longcat") {
    Object.assign(nameAliases, LONGCAT_NAME_ALIASES, opts.nameAliases ?? {});
    // merge * maps
    const base = { ...LONGCAT_ARG_ALIASES["*"], ...(argAliases["*"] ?? {}) };
    argAliases["*"] = base;
  }
  return { nameAliases, argAliases };
}
