/**
 * Per-server `tools` globs on the connection settings bag.
 * Missing / malformed = no filter. Empty list = none. Only `!` rules
 * prepend `*`. Otherwise apply in listed order against `serverToolName`.
 * Catalog hide is not a license skip — a named call still must not run.
 */
const GLOB_SPECIALS = /[.+^${}()|[\]\\]/g;

export function mcpGlobMatch(pattern: string, value: string): boolean {
  const body = pattern
    .replaceAll(GLOB_SPECIALS, String.raw`\$&`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  // pattern is operator-authored config, not an untrusted regex.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(`^${body}$`).test(value);
}

type ToolRule = { readonly exclude: boolean; readonly pattern: string };

function parseToolRule(raw: string): ToolRule | undefined {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "!") return undefined;
  if (trimmed.startsWith("!")) {
    const pattern = trimmed.slice(1).trim();
    return pattern === "" ? undefined : { exclude: true, pattern };
  }
  return { exclude: false, pattern: trimmed };
}

/** `undefined` = no `tools` field (pass all). Empty array = admit none. */
export function parseMcpToolRules(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((row): row is string => typeof row === "string");
}

export function effectiveMcpToolRules(rules: readonly string[]): readonly ToolRule[] {
  const parsed: ToolRule[] = [];
  for (const row of rules) {
    const rule = parseToolRule(row);
    if (rule !== undefined) parsed.push(rule);
  }
  if (parsed.length === 0) return parsed;
  if (parsed.every((rule) => rule.exclude)) {
    return [{ exclude: false, pattern: "*" }, ...parsed];
  }
  return parsed;
}

function applyMcpToolRules(names: readonly string[], rules: readonly ToolRule[]): string[] {
  const admitted = new Set<string>();
  for (const rule of rules) {
    for (const name of names) {
      if (!mcpGlobMatch(rule.pattern, name)) continue;
      if (rule.exclude) admitted.delete(name);
      else admitted.add(name);
    }
  }
  return names.filter((name) => admitted.has(name));
}

export function filterMcpToolNames(names: readonly string[], raw: unknown): string[] {
  const rules = parseMcpToolRules(raw);
  if (rules === undefined) return [...names];
  return applyMcpToolRules(names, effectiveMcpToolRules(rules));
}

export function mcpToolAllowed(raw: unknown, serverToolName: string): boolean {
  return filterMcpToolNames([serverToolName], raw).includes(serverToolName);
}

export function mcpToolsSettingOf(settings: { readonly tools?: unknown } | Record<string, unknown>): unknown {
  return "tools" in settings ? settings.tools : undefined;
}
