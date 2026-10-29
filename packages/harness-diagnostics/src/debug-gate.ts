/**
 * `DEBUG` namespaces, `debug` package shape.
 * `*` and a set-but-empty value enable every namespace. `-name` skips.
 * A name matches itself and its children. Skips win.
 */
type DebugPattern = { readonly skip: boolean; readonly name: string };

let debugSource: string | undefined;
let debugPatterns: readonly DebugPattern[] = [];

function loadDebug(): readonly DebugPattern[] {
  const present = process.env.DEBUG;
  const raw = present ?? "\u0000unset";
  if (raw === debugSource) return debugPatterns;
  debugSource = raw;
  if (present === undefined) {
    debugPatterns = [];
    return debugPatterns;
  }
  if (present.trim() === "") {
    debugPatterns = [{ skip: false, name: "*" }];
    return debugPatterns;
  }
  debugPatterns = present
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => (part.startsWith("-") ? { skip: true, name: part.slice(1) } : { skip: false, name: part }));
  return debugPatterns;
}

function patternHits(pattern: string, name: string): boolean {
  if (pattern === "*" || pattern === "") return true;
  if (pattern === name) return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name.startsWith(`${pattern}:`);
}

/** True when `DEBUG` enables `name`. */
export function debugEnabled(name: string): boolean {
  const patterns = loadDebug();
  let enabled = false;
  for (const pattern of patterns) {
    if (!patternHits(pattern.name, name)) continue;
    enabled = !pattern.skip;
  }
  return enabled;
}

/** Any `DEBUG` value, including empty. `step()` gate. */
export function debugOn(): boolean {
  return loadDebug().length > 0;
}
