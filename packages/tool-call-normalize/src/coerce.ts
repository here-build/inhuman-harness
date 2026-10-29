import type { JsonSchema, ToolDef } from "./types.js";

function propSchema(tools: ToolDef[] | undefined, toolName: string, key: string): JsonSchema | undefined {
  const t = tools?.find((x) => x.name === toolName);
  const props = t?.parameters?.properties;
  if (!props || typeof props !== "object") return undefined;
  const p = (props as Record<string, unknown>)[key];
  return p && typeof p === "object" ? (p as JsonSchema) : undefined;
}

function typesOf(schema: JsonSchema): string[] {
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

/** TAG_WITH_TAGGED arg coercion per design §10.1 */
export function coerceArgs(
  toolName: string,
  raw: Record<string, string>,
  tools?: ToolDef[],
): { json: string; untyped: boolean } {
  const out: Record<string, unknown> = {};
  let untyped = !tools?.some((t) => t.name === toolName);

  for (const [k, v] of Object.entries(raw)) {
    const sch = propSchema(tools, toolName, k);
    if (!sch) {
      // no schema: only exact true|false|null
      switch (v) {
        case "true": {
          out[k] = true;
          break;
        }
        case "false": {
          out[k] = false;
          break;
        }
        case "null": {
          out[k] = null;
          break;
        }
        default:
          out[k] = v;
      }
      untyped = true;
      continue;
    }
    const types = typesOf(sch);
    // Schema-typed boolean/null: accept JSON and Python literals (args-xml / tagged)
    if (types.includes("boolean") && (v === "true" || v === "false" || v === "True" || v === "False")) {
      out[k] = v === "true" || v === "True";
      continue;
    }
    if (types.includes("null") && (v === "null" || v === "None")) {
      out[k] = null;
      continue;
    }
    if (types.includes("integer") || types.includes("number")) {
      // reject leading-zero integers like 007
      if (/^[+-]?0\d/.test(v) || /^\s/.test(v) || /\s$/.test(v)) {
        out[k] = v;
        continue;
      }
      try {
        const n = JSON.parse(v);
        if (typeof n === "number" && Number.isFinite(n)) {
          out[k] = types.includes("integer") && !Number.isInteger(n) ? v : n;
          continue;
        }
      } catch {
        /* keep string */
      }
      out[k] = v;
      continue;
    }
    // object/array: keep string here — schema-repair unstringifies only at
    // failure sites (MCP JSON file body must stay a string when schema is string).
    if (types.includes("object") || types.includes("array")) {
      out[k] = v;
      continue;
    }
    out[k] = v;
  }

  return { json: JSON.stringify(out), untyped };
}

/** Light repair for JSON bodies: single quotes, True/False/None, trailing commas */
export function lightRepairJson(s: string): string {
  let t = s.trim();
  // True/False/None → json
  t = t
    .replaceAll(/\bTrue\b/g, "true")
    .replaceAll(/\bFalse\b/g, "false")
    .replaceAll(/\bNone\b/g, "null");
  // trailing commas before } or ]
  t = t.replaceAll(/,(\s*[}\]])/g, "$1");
  // single-quoted strings (naive): '...' → "..."
  t = t.replaceAll(/'([^'\\]|\\.)*'/g, (m) => {
    const inner = m
      .slice(1, -1)
      .replaceAll(String.raw`\'`, "'")
      .replaceAll('"', String.raw`\"`);
    return `"${inner}"`;
  });
  return t;
}

export function parseJsonArgsBody(bodyJson: string): {
  name: string;
  arguments: string;
} | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };
  // Parse raw first — light repair only on failure (avoid corrupting string values)
  let obj = tryParse(bodyJson.trim());
  if (!obj) obj = tryParse(lightRepairJson(bodyJson));
  if (!obj) return null;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) return null;
  let args = obj.arguments ?? obj.parameters ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // Design §9.1: unparseable args → drop, not a JSON string literal
      return null;
    }
  }
  return { name, arguments: JSON.stringify(args ?? {}) };
}
