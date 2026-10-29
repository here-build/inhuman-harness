/**
 * Second-stage argument parser: native tool_calls exist but
 * function.arguments is XML-like (Continue #11453 / Qwen-via-compat).
 *
 * Order: JSON.parse first; only on failure try <parameter=name>value</parameter>
 * (and nested <parameter name="…">). Never invent on total failure — return null.
 */

export type ParseArgsResult = { ok: true; arguments: string } | { ok: false };

function coerceScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "true" || v === "True") return true;
  if (v === "false" || v === "False") return false;
  if (v === "null" || v === "None") return null;
  // JSON-looking
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]")) ||
    (v.startsWith('"') && v.endsWith('"'))
  ) {
    try {
      return JSON.parse(v);
    } catch {
      /* keep string */
    }
  }
  // number without leading-zero trap for ids like 007
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(v)) {
    try {
      const n = JSON.parse(v);
      if (typeof n === "number" && Number.isFinite(n)) return n;
    } catch {
      /* keep */
    }
  }
  return v; // trimmed plain string
}

/**
 * Try to parse a function.arguments string into a JSON object string.
 * Returns null if neither JSON nor XML-parameter dialect applies.
 */
export function tryParseFunctionArguments(raw: string): ParseArgsResult {
  const s = raw.trim();
  if (!s) return { ok: true, arguments: "{}" };

  // 1. JSON object or array-as-root (array → keep as JSON string of array? tools expect object)
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") {
      return { ok: true, arguments: JSON.stringify(parsed) };
    }
    // bare JSON string / number — not a tool args object
  } catch {
    /* fall through to XML */
  }

  // 2. <parameter=name>value</parameter> (qwen-style) or name="…"
  const params: Record<string, unknown> = {};
  let matched = false;

  const reEq = /<parameter\s*=\s*([^\s>]+)>([\s\S]*?)<\/parameter>/gi;
  let m: RegExpExecArray | null;
  while ((m = reEq.exec(s)) !== null) {
    matched = true;
    const key = m[1]!.trim();
    const val = m[2] ?? "";
    params[key] = coerceScalar(val);
  }

  const reName = /<parameter\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
  while ((m = reName.exec(s)) !== null) {
    matched = true;
    const key = m[1]!.trim();
    const val = m[2] ?? "";
    params[key] = coerceScalar(val);
  }

  // bare <name>value</name> inside tool_call (avoid matching tool_call/function wrappers)
  if (!matched) {
    const reBare = /<([a-z_][\w.-]*)>([\s\S]*?)<\/\1>/gi;
    while ((m = reBare.exec(s)) !== null) {
      const key = m[1]!;
      if (/^(tool_call|function|tool|parameters|args)$/i.test(key)) continue;
      matched = true;
      params[key] = coerceScalar(m[2] ?? "");
    }
  }

  if (!matched || Object.keys(params).length === 0) {
    return { ok: false };
  }
  return { ok: true, arguments: JSON.stringify(params) };
}
