function leafEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // reject null/bool/number JS == traps
  if (a == null || b == null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") {
    if (typeof a === "boolean" && typeof b === "boolean") return a === b;
    if (typeof a === "boolean" && typeof b === "string") return String(a) === b;
    if (typeof b === "boolean" && typeof a === "string") return String(b) === a;
    return false;
  }
  if (typeof a === "number" || typeof b === "number") {
    return String(a) === String(b);
  }
  if (typeof a === "string" && typeof b === "string") return a === b;
  return false;
}

function deepLooseEqual(a: unknown, b: unknown): boolean {
  // Objects/arrays first — never String(obj) === "[object Object]"
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((x, i) => deepLooseEqual(x, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      if (!deepLooseEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return leafEqual(a, b);
}

export function argsEqual(aJson: string, bJson: string): boolean {
  try {
    const a = JSON.parse(aJson);
    const b = JSON.parse(bJson);
    return deepLooseEqual(a, b);
  } catch {
    return aJson.trim() === bJson.trim();
  }
}
