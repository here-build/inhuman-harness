import { resolveLang } from "@inhuman.tools/harness-ui/blocks/lang";
import {
  type ColorScheme,
  type HighlightLine,
  MAX_HIGHLIGHT_CHARS,
  type SyntaxHighlighter,
} from "@inhuman.tools/harness-ui/blocks/syntax";

import { wasmDetectShellEmbeds, wasmGuessLang, wasmHighlightDiff, wasmHighlightLines } from "./syntax-wasm.js";

/** Token lines, or null when coloring should stay off and the plain source show. */
export async function highlightLines(
  code: string,
  lang: string,
  scheme: ColorScheme,
  guess = false,
): Promise<HighlightLine[] | null> {
  const resolved = resolveLang(lang);
  if ((!guess && resolved === "text") || code.length === 0 || code.length > MAX_HIGHLIGHT_CHARS) return null;
  return wasmHighlightLines(code, resolved, scheme, guess);
}

/** WASM-backed syntax highlighter connected through {@link SyntaxHighlightProvider}. */
export const wasmSyntaxHighlighter: SyntaxHighlighter = {
  highlightLines,
  highlightDiff: wasmHighlightDiff,
  guessLang: wasmGuessLang,
  detectShellEmbeds: wasmDetectShellEmbeds,
};
