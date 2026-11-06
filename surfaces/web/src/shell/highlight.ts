import { resolveLang } from "./lang.js";
import { wasmHighlightLines } from "./syntax-wasm.js";

export type ColorScheme = "light" | "dark";

export type TokenRun = {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
};

export type HighlightLine = TokenRun[];

/** Skip coloring a huge open diff. The plain source stays readable. */
const MAX_CHARS = 128 * 1024;

/** The page's scheme: `data-scheme` on the root when something pins it, else the OS preference. */
export function pageScheme(): ColorScheme {
  const pinned = typeof document === "undefined" ? undefined : document.documentElement.dataset.scheme;
  if (pinned === "light" || pinned === "dark") return pinned;
  if (typeof globalThis.matchMedia !== "function") return "light";
  return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Token lines, or null when coloring should stay off and the plain source show. */
export async function highlightLines(
  code: string,
  lang: string,
  scheme: ColorScheme,
  guess = false,
): Promise<HighlightLine[] | null> {
  const resolved = resolveLang(lang);
  if ((!guess && resolved === "text") || code.length === 0 || code.length > MAX_CHARS) return null;
  return wasmHighlightLines(code, resolved, scheme, guess);
}
