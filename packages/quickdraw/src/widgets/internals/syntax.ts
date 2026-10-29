/**
 * ./syntax.js — shiki tokens → Style runs → LayoutNode lines.
 *
 * Prefer warmHighlighter() once at app boot, then highlightCodeSync in paint path.
 */

import { observable } from "mobx";
import { createHighlighter, type Highlighter, type BundledLanguage, type BundledTheme } from "shiki";

import { ARRIVAL_LANG } from "./arrival-lang.js";
import { detectShellEmbeds, spliceEmbeds } from "./embedded-syntax.js";
import type { Style } from "../../buffer/index.js";
import type { Rgb } from "../../lexicon/index.js";

export type TokenRun = {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
};
export type HighlightLine = TokenRun[];

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

/**
 * Syntax policy stage 1 (quickdraw-color-hygiene): shiki theme is
 * polarity-selected, not hardcoded. `"dark"|"light"` matches theme's
 * `CanvasPolarity` structurally — callers pass `canvasPolarity(ground)`
 * straight through without this package depending on quickdraw-theme.
 */
export type SyntaxPolarity = "dark" | "light";

const THEME_DARK = "github-dark";
const THEME_LIGHT = "github-light";
const DEFAULT_POLARITY: SyntaxPolarity = "dark";
const DEFAULT_LANG = "text";

/**
 * Ambient syntax polarity (stage-1 syntax policy). Hosts set this at theme
 * attunement via {@link setHighlightPolarity} from `canvasPolarity(ground)` —
 * widgets (markdown fences, diff) then inherit without threading polarity
 * through every call site. Explicit `opts.polarity` still wins per call.
 */
const ambientPolarity = observable.box<SyntaxPolarity>(DEFAULT_POLARITY, { deep: false });

/** True once {@link warmHighlighter} loaded the shared highlighter. */
const highlighterWarm = observable.box(false, { deep: false });

/**
 * Bind the highlighter's default shiki theme polarity (dark/light ground).
 * The value is MobX-observable: retained widgets read it (via
 * {@link syntaxPolarity}) inside their `reaction` data function, so a flip
 * marks their baked-token subtree dirty without any manual invalidation.
 */
export function setHighlightPolarity(polarity: SyntaxPolarity): void {
  ambientPolarity.set(polarity === "light" ? "light" : "dark");
}

function themeForPolarity(polarity: SyntaxPolarity): BundledTheme {
  return polarity === "light" ? THEME_LIGHT : THEME_DARK;
}

function resolvePolarity(opts?: { polarity?: SyntaxPolarity }): SyntaxPolarity {
  return opts?.polarity ?? ambientPolarity.get();
}

const WARM_LANGS = [
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
  "shell",
  "css",
  "html",
  "yaml",
  "toml",
  "text",
] as const;

let highlighter: Highlighter | null = null;
let warmPromise: Promise<Highlighter> | null = null;

function plainLines(code: string): HighlightLine[] {
  return code.split("\n").map((line) => [{ text: line }]);
}

function tokenToRun(content: string, color?: string, fontStyle?: number): TokenRun {
  const run: TokenRun = { text: content };
  if (color) run.color = color;
  const fs = fontStyle ?? 0;
  if (fs & FONT_BOLD) run.bold = true;
  if (fs & FONT_ITALIC) run.italic = true;
  return run;
}

function mapTokens(tokens: { content: string; color?: string; fontStyle?: number }[][]): HighlightLine[] {
  return tokens.map((line) => line.map((tok) => tokenToRun(tok.content, tok.color, tok.fontStyle)));
}

/**
 * Ambient highlighter state, MobX-observable. Retained widgets
 * (harness `WorkCellWidget` / `SpeechWidget` / `ComposerWidget`) read these
 * inside their `reaction` data function, so MobX tracks them and re-marks
 * the baked-token subtree dirty when either changes — no manual
 * invalidation counter. Both genuinely affect the bytes a
 * `highlightCodeSync` call returns for identical input:
 * - polarity selects the shiki theme (`github-dark` ↔ `github-light`), and
 * - warmth decides whether tokens are returned at all (cold → plain lines).
 */
export function syntaxPolarity(): SyntaxPolarity {
  return ambientPolarity.get();
}

export function syntaxWarm(): boolean {
  return highlighterWarm.get();
}

/** Warm shared highlighter (idempotent). Call at app boot. */
export async function warmHighlighter(langs: string[] = [...WARM_LANGS]): Promise<void> {
  if (highlighter) return;
  if (!warmPromise) {
    warmPromise = createHighlighter({
      themes: [THEME_DARK, THEME_LIGHT],
      langs: [...(langs as BundledLanguage[]), ARRIVAL_LANG],
    })
      .then((h) => {
        highlighter = h;
        highlighterWarm.set(true);
        return h;
      })
      .catch((error) => {
        // Clear the cached promise on failure so the next warm() retries
        // instead of returning the same rejected promise forever.
        warmPromise = null;
        throw error;
      });
  }
  await warmPromise;
}

export function isHighlighterReady(): boolean {
  return highlighter !== null;
}

/**
 * Sync highlight after warmHighlighter(). Falls back to plain if not warm
 * or lang unknown. `theme` overrides `polarity` when both are given;
 * `polarity` (dark default) is the intent-level knob callers should reach for.
 */
const HIGHLIGHT_CACHE_LIMIT = 128;
/** Skip shiki for pathological sources — first paint of a huge always-open diff. */
const HIGHLIGHT_MAX_CHARS = 128 * 1024;
const highlightCache = new Map<string, HighlightLine[]>();

function highlightCacheKey(code: string, lang: string, theme: string): string {
  return `${theme}\0${lang}\0${code}`;
}

export function highlightCodeSync(
  code: string,
  opts?: { lang?: string; theme?: string; polarity?: SyntaxPolarity },
): HighlightLine[] {
  const lang = opts?.lang ?? DEFAULT_LANG;
  const theme = (opts?.theme ?? themeForPolarity(resolvePolarity(opts))) as BundledTheme;
  if (code.length > HIGHLIGHT_MAX_CHARS) return plainLines(code);
  if (!highlighter) return plainLines(code);
  const cacheKey = highlightCacheKey(code, lang, theme);
  const cached = highlightCache.get(cacheKey);
  if (cached !== undefined) {
    highlightCache.delete(cacheKey);
    highlightCache.set(cacheKey, cached);
    return cached;
  }
  try {
    const result = highlighter.codeToTokens(code, {
      lang: lang as BundledLanguage,
      theme,
    });
    const baseline = mapTokens(result.tokens);
    // Shell commands carry other languages inside them (heredocs writing a
    // file, `python -c "…"`). Color those spans with their own language,
    // spliced back into the bash baseline by offset. Only languages that are
    // actually loaded — a cold language tokenizes to plain runs and would
    // trade the bash string color for nothing.
    let lines = baseline;
    if (lang === "bash" || lang === "shell") {
      const loaded = new Set(highlighter.getLoadedLanguages());
      const regions = detectShellEmbeds(code).filter((r) => loaded.has(r.lang));
      if (regions.length > 0) {
        lines = spliceEmbeds(baseline, code, regions, (slice, sliceLang) =>
          highlightCodeSync(slice, { lang: sliceLang, theme }),
        );
      }
    }
    if (highlightCache.size >= HIGHLIGHT_CACHE_LIMIT) {
      const oldest = highlightCache.keys().next().value;
      if (oldest !== undefined) highlightCache.delete(oldest);
    }
    highlightCache.set(cacheKey, lines);
    return lines;
  } catch {
    return plainLines(code);
  }
}

/**
 * Best-effort language guess for fences without an info string. Cheap signal
 * scoring, not parsing — returns undefined when no signal clears the bar, so
 * callers fall back to plain rendering rather than mis-highlighting.
 */
export function guessLang(code: string): string | undefined {
  const head = code.slice(0, 2000);
  const shebang = /^#!\s*(?:\S*\/)?(?:env\s+)?(bash|sh|zsh|node|python3?|ruby)\b/.exec(head);
  if (shebang) {
    const bin = shebang[1]!;
    if (bin === "node") return "javascript";
    if (bin.startsWith("python")) return "python";
    if (bin === "ruby") return "ruby";
    return "bash";
  }
  const trimmed = head.trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      JSON.parse(code);
      return "json";
    } catch {
      // fall through — JS object literals land in the keyword scoring below
    }
  }
  if (/^<!doctype\s|^<html\b|^<\?xml\b/i.test(trimmed)) return "html";
  const scores: Record<string, number> = {};
  const bump = (lang: string, n = 1) => (scores[lang] = (scores[lang] ?? 0) + n);
  if (/\b(interface|type)\s+\w+\s*(?:=\s*)?[{<]|:\s*(string|number|boolean|void)\b|\bas\s+const\b/.test(head))
    bump("typescript", 2);
  if (/\b(const|let|=>|function|import\s.+\sfrom)\b/.test(head)) bump("typescript", 1);
  if (/\bdef\s+\w+\s*\(|\bself\b|^\s*(from|import)\s+\w+(\s+import\s)?/m.test(head)) bump("python", 2);
  if (/\bfn\s+\w+|\blet\s+mut\b|::\w+|#\[\w+/.test(head)) bump("rust", 2);
  if (/\bfunc\s+\w+\(|:=|\bpackage\s+\w+$/m.test(head)) bump("go", 2);
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE)\b/im.test(head)) bump("sql", 2);
  if (/^[.#]?[\w-]+\s*\{[^:}]*:[^}]*;/m.test(head)) bump("css", 2);
  if (/^\s*<[a-z][\w-]*(\s|>)/m.test(head)) bump("html", 1);
  if (/^\w[\w-]*:\s+\S/m.test(head) && !/[{;]/.test(head)) bump("yaml", 2);
  if (/^\s*(if|for|while)\s+\[\[|\becho\s|\$\{?\w+/m.test(head)) bump("bash", 1);
  const MIN_SCORE = 2;
  let best: string | undefined;
  let bestScore = 0;
  for (const [lang, s] of Object.entries(scores)) {
    if (s >= MIN_SCORE && s > bestScore) {
      best = lang;
      bestScore = s;
    }
  }
  return best;
}

function parseHexRgb(color: string): Rgb | undefined {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function runsToStyle(run: TokenRun): Style {
  const style: Style = {};
  if (run.color) {
    // Token RGB is hue/chroma. Resolver recasts AL onto the paired role.
    const rgb = parseHexRgb(run.color);
    if (rgb) style.fgRgb = rgb;
  }
  if (run.bold) style.bold = true;
  if (run.italic) style.italic = true;
  return style;
}
