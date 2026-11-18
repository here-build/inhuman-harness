import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { resolveLang } from "./lang.js";

/** Supported color schemes read by syntax highlighters and theme-aware renderers. */
export type ColorScheme = "light" | "dark";

/** Styled token span inside a highlighted line. */
export interface TokenRun {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

/** Single highlighted line of token runs. */
export type HighlightLine = readonly TokenRun[];

/** Embedded language slice detected within a compound shell command. */
export interface EmbedRegion {
  readonly start: number;
  readonly end: number;
  readonly lang: string;
}

/** Styled token run returned by diff syntax highlighting. */
export interface DiffTokenRun {
  readonly text: string;
  readonly color?: string;
}

/** Per-side highlighted token lines for a unified or split diff. */
export interface DiffHighlightResult {
  readonly oldLines: readonly (readonly DiffTokenRun[])[];
  readonly newLines: readonly (readonly DiffTokenRun[])[];
}

/** Pluggable syntax highlighter adapter supplied by a white-label or WASM host. */
export interface SyntaxHighlighter {
  highlightLines(code: string, lang: string, scheme: ColorScheme, guess?: boolean): Promise<HighlightLine[] | null>;
  highlightDiff?(oldText: string, newText: string, path: string): Promise<DiffHighlightResult | null>;
  guessLang?(code: string): string | undefined;
  detectShellEmbeds?(command: string): readonly EmbedRegion[];
}

/** Character cap above which syntax coloring stays off to keep frames responsive. */
export const MAX_HIGHLIGHT_CHARS = 128 * 1024;

/** Resolves the active scheme from `data-scheme` / `data-theme` on `<html>` or OS preference. */
export function pageScheme(): ColorScheme {
  const pinned =
    typeof document === "undefined"
      ? undefined
      : (document.documentElement.dataset.scheme ?? document.documentElement.dataset.theme);
  if (pinned === "light" || pinned === "dark") return pinned;
  if (typeof globalThis.matchMedia !== "function") return "light";
  return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Reactively tracks the OS color scheme and pinned `data-scheme` / `data-theme` attribute on `<html>`. */
export function useScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>(pageScheme);
  useEffect(() => {
    const apply = (): void => setScheme(pageScheme());
    apply();
    const query =
      typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-color-scheme: dark)") : null;
    query?.addEventListener("change", apply);
    const pin = new MutationObserver(apply);
    pin.observe(document.documentElement, { attributes: true, attributeFilter: ["data-scheme", "data-theme"] });
    return () => {
      query?.removeEventListener("change", apply);
      pin.disconnect();
    };
  }, []);
  return scheme;
}

const plainSyntaxHighlighter: SyntaxHighlighter = {
  async highlightLines(code, lang, _scheme, guess = false) {
    const resolved = resolveLang(lang);
    if ((!guess && resolved === "text") || code.length === 0 || code.length > MAX_HIGHLIGHT_CHARS) return null;
    return null;
  },
  guessLang() {
    return undefined;
  },
  detectShellEmbeds() {
    return [];
  },
};

const SyntaxHighlightContext = createContext<SyntaxHighlighter>(plainSyntaxHighlighter);

export interface SyntaxHighlightProviderProps {
  /** Custom highlighter implementation (e.g., WASM or tree-sitter backend). */
  readonly highlighter: SyntaxHighlighter;
  readonly children?: ReactNode;
}

/** Supplies an optional syntax highlighting backend to descendant code and diff blocks. */
export function SyntaxHighlightProvider({ highlighter, children }: SyntaxHighlightProviderProps) {
  return <SyntaxHighlightContext.Provider value={highlighter}>{children}</SyntaxHighlightContext.Provider>;
}

/** Returns the active syntax highlighter or a zero-dependency plain fallback. */
export function useSyntaxHighlighter(): SyntaxHighlighter {
  return useContext(SyntaxHighlightContext);
}
