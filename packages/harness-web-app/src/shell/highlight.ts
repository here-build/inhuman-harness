import { bundledLanguages, createHighlighter, type BundledLanguage, type BundledTheme, type Highlighter } from "shiki";

import { detectShellEmbeds, resolveLang, spliceEmbeds } from "./lang.js";
// Arrival's TextMate grammar. Bundled Scheme marks `[]` illegal and has no `{…}` / `#null`.
// eslint-disable-next-line import-x/no-relative-packages
import { ARRIVAL_LANG } from "../../../quickdraw/src/widgets/internals/arrival-lang.js";

export type ColorScheme = "light" | "dark";

export type TokenRun = {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
};

export type HighlightLine = TokenRun[];

const THEME_DARK = "github-dark-default";
const THEME_LIGHT = "github-light-high-contrast";
const CACHE_LIMIT = 128;
/** Skip coloring a huge open diff. The plain source stays readable. */
const MAX_CHARS = 128 * 1024;

const WARM = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "markdown",
  "elixir",
  "python",
  "rust",
  "go",
  "bash",
  "css",
  "html",
  "yaml",
  "toml",
] as const satisfies readonly BundledLanguage[];

let enginePromise: Promise<Highlighter> | null = null;
const cache = new Map<string, HighlightLine[]>();

/** The page's scheme: `data-scheme` on the root when something pins it, else the OS preference. */
export function pageScheme(): ColorScheme {
  const pinned = typeof document === "undefined" ? undefined : document.documentElement.dataset.scheme;
  if (pinned === "light" || pinned === "dark") return pinned;
  if (typeof globalThis.matchMedia !== "function") return "light";
  return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Token lines, or null when coloring should stay off and the plain source show. */
export async function highlightLines(code: string, lang: string, scheme: ColorScheme): Promise<HighlightLine[] | null> {
  const resolved = resolveLang(lang);
  if (resolved === "text" || code.length === 0 || code.length > MAX_CHARS) return null;
  try {
    const engine = await shared();
    await ensure(engine, resolved);
    if (resolved === "bash") {
      for (const region of detectShellEmbeds(code)) await ensure(engine, region.lang);
    }
    return highlightSync(engine, code, resolved, scheme === "dark" ? THEME_DARK : THEME_LIGHT);
  } catch {
    return null;
  }
}

function shared(): Promise<Highlighter> {
  enginePromise ??= createHighlighter({
    themes: [THEME_DARK, THEME_LIGHT],
    langs: [...WARM, ARRIVAL_LANG],
  }).catch((error: unknown) => {
    enginePromise = null;
    throw error;
  });
  return enginePromise;
}

async function ensure(engine: Highlighter, lang: string): Promise<void> {
  const resolved = resolveLang(lang);
  if (resolved === "text" || hasLang(engine, resolved) || !isBundled(resolved)) return;
  await engine.loadLanguage(resolved);
}

function highlightSync(engine: Highlighter, code: string, lang: string, theme: BundledTheme): HighlightLine[] | null {
  if (!hasLang(engine, lang)) return null;
  const key = `${theme}\0${lang}\0${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tokens = engine.codeToTokens(code, { lang: asBundled(lang), theme });
  let lines: HighlightLine[] = tokens.tokens.map((line) =>
    line.map((token) => tokenRun(token.content, token.color, token.fontStyle)),
  );
  if (lang === "bash") {
    const ready = new Set<string>(engine.getLoadedLanguages());
    const regions = detectShellEmbeds(code).filter((region) => ready.has(resolveLang(region.lang)));
    if (regions.length > 0) {
      lines = spliceEmbeds(lines, code, regions, (slice, sliceLang) => {
        const inner = highlightSync(engine, slice, resolveLang(sliceLang), theme);
        return inner ?? slice.split("\n").map((text) => [{ text }]);
      });
    }
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, lines);
  return lines;
}

function hasLang(engine: Highlighter, lang: string): boolean {
  const names: readonly string[] = engine.getLoadedLanguages();
  return names.includes(lang);
}

function isBundled(lang: string): lang is BundledLanguage {
  return Object.hasOwn(bundledLanguages, lang);
}

function asBundled(lang: string): BundledLanguage {
  // `scm` is registered from the Arrival grammar and is absent from BundledLanguage.
  return lang as BundledLanguage;
}

function tokenRun(content: string, color?: string, fontStyle = 0): TokenRun {
  const run: TokenRun = { text: content };
  if (color !== undefined && color !== "") run.color = color;
  if ((fontStyle & 2) !== 0) run.bold = true;
  if ((fontStyle & 1) !== 0) run.italic = true;
  return run;
}
