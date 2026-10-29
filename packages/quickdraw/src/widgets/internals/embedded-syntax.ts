/**
 * ./embedded-syntax.ts — language detection + token splicing for highlighting.
 *
 * Shiki colors one language per call, but shell commands routinely carry a
 * second language inside them:
 *
 * - heredoc writing a whole file — `cat > main.py << 'EOF' … EOF`
 * - interpreter reading code from stdin — `python - << 'EOF' … EOF`
 * - inline interpreter code — `python -c "…"` / `node -e '…'`
 *
 * {@link detectShellEmbeds} finds those regions; {@link spliceEmbeds} swaps
 * shiki tokens from the embedded language into the baseline bash token stream,
 * aligned by character offset so nothing shifts. {@link guessLang} infers a
 * language for untagged content (heredoc bodies with a generic filename,
 * markdown fences without an info string).
 *
 * Detection is regex-plus-scanning, not a shell parser — see the non-goals
 * listed on {@link detectShellEmbeds}. Nothing here throws: a region whose
 * language is not warm, or whose embedded tokenizer disagrees about the shape
 * of the text, is dropped and the caller keeps plain bash coloring.
 */

import type { HighlightLine, TokenRun } from "./syntax.js";

/**
 * Best-effort language guess for untagged content. Cheap signal scoring, not
 * parsing — returns undefined when no signal clears the bar, so callers fall
 * back to plain rendering rather than mis-highlighting.
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

/** A character range [start, end) within a command, colored as `lang`. */
export type EmbedRegion = {
  readonly start: number;
  readonly end: number;
  readonly lang: string;
};

/**
 * Interpreter binaries mapped to their shiki language. Kept to interpreters a
 * shell user actually invokes with inline code or a stdin heredoc. The
 * language must also be warm (`WARM_LANGS` in ./syntax.js) for a region to
 * color — otherwise the embedded tokenizer falls back to plain and the region
 * is dropped by {@link spliceEmbeds}.
 */
const INTERPRETER_LANG: Readonly<Record<string, string>> = {
  python: "python",
  python3: "python",
  py: "python",
  node: "javascript",
  deno: "typescript",
  bun: "javascript",
  ruby: "ruby",
  irb: "ruby",
  perl: "perl",
  php: "php",
  R: "r",
  Rscript: "r",
  lua: "lua",
  jq: "jq",
  sqlite3: "sql",
  psql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
};

/** File extensions mapped to shiki languages, for heredoc target files. */
const EXT_LANG: Readonly<Record<string, string>> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  scm: "scm",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  pl: "perl",
  lua: "lua",
  r: "r",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  html: "html",
  htm: "html",
  xml: "xml",
  css: "css",
  scss: "scss",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  el: "lisp",
  lisp: "lisp",
  clj: "clojure",
  cljs: "clojure",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  scala: "scala",
  gql: "graphql",
  graphql: "graphql",
  vim: "vim",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  diff: "diff",
  text: "text",
  txt: "text",
  env: "ini",
  conf: "ini",
  log: "text",
};

/** Filenames whose extension carries no language signal. */
const SPECIAL_FILES: Readonly<Record<string, string>> = {
  dockerfile: "docker",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  ".env": "ini",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
};

/** True when the command has any shape detection could latch onto. */
function hasEmbedShape(command: string): boolean {
  return /<{2}/.test(command) || /(?:^|[\s;&|`(-])(?:-c|-e|--eval|--exec|-r)\s*['"]/.test(command);
}

/**
 * Detect embedded-language regions in a shell command.
 *
 * Covers, in priority order:
 *
 * 1. heredoc into a target file — `cat > main.py << 'EOF'` — language from
 *    the extension, falling back to {@link guessLang} on the body
 * 2. interpreter reading a heredoc from stdin — `python - << 'EOF'`
 * 3. inline interpreter code — `python -c "…"` / `node -e '…'`
 *
 * Non-goals, deliberately: nested embeds inside an embedded region (a python
 * string that itself contains a heredoc), heredoc bodies containing command
 * substitution, and `<<`/quotes appearing inside a larger quoted string.
 * Overlapping regions are collapsed to the first. Returns regions sorted by
 * offset with no two sharing a character.
 */
export function detectShellEmbeds(command: string): EmbedRegion[] {
  if (!hasEmbedShape(command)) return [];
  const regions: EmbedRegion[] = [];
  collectHeredocs(command, regions);
  collectInline(command, regions);
  return collapseOverlaps(regions).sort((a, b) => a.start - b.start);
}

/** Drop any region that overlaps an earlier one; nested embeds are a non-goal. */
function collapseOverlaps(regions: EmbedRegion[]): EmbedRegion[] {
  const kept: EmbedRegion[] = [];
  for (const r of [...regions].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (kept.some((k) => r.start < k.end && r.end > k.start)) continue;
    kept.push(r);
  }
  return kept;
}

type LineSpan = { readonly start: number; readonly text: string };

/** Split `text` into lines with absolute start offsets (the `\n` is excluded). */
function lineSpans(text: string): LineSpan[] {
  const out: LineSpan[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    out.push({ start, text: line });
    start += line.length + 1;
  }
  return out;
}

/** Source line index containing `offset` (an offset at a line start is that line). */
function lineContaining(lines: LineSpan[], offset: number): number {
  let idx = 0;
  for (const [i, span] of lines.entries()) {
    if (span.start <= offset) idx = i;
    else break;
  }
  return idx;
}

type Heredoc = {
  /** Source line index of the delimiter line. */
  readonly headerLine: number;
  /** Absolute offset where the body starts (after the header line's `\n`). */
  readonly bodyStart: number;
  /** Absolute offset where the body ends (start of the terminator line). */
  readonly bodyEnd: number;
  readonly lang?: string;
};

/**
 * Heredocs: `cat > f.py << 'EOF' … EOF` and `python - << 'EOF' … EOF`.
 *
 * The region is the body between the delimiter line and the terminator line —
 * the delimiters themselves stay bash-colored so the command's structure stays
 * visible. Requires the delimiter word to be the last thing on the header
 * line, which is the write-a-file shape worth coloring.
 */
function collectHeredocs(command: string, regions: EmbedRegion[]): void {
  const lines = lineSpans(command);
  for (let li = 0; li < lines.length; li += 1) {
    const found = matchHeredoc(lines, li);
    if (found === undefined) continue;
    if (found.bodyEnd <= found.bodyStart || found.lang === undefined) continue;
    regions.push({ start: found.bodyStart, end: found.bodyEnd, lang: found.lang });
  }
}

/** Match a heredoc opening on line `li`, terminator resolved. */
function matchHeredoc(lines: LineSpan[], li: number): Heredoc | undefined {
  const header = lines[li]!;
  const open = /<<\s*(['"]?)([A-Z_]\w*)\1/i.exec(header.text);
  if (open === null) return undefined;
  // The delimiter must be the last thing on the line: a trailing command
  // (`<< EOF; ls`) is not the simple write-a-file shape we color.
  const tail = header.text.slice(open.index! + open[0]!.length);
  if (!/^\s*(?:['"]\s*)?$/.test(tail)) return undefined;
  const terminator = findTerminator(lines, li + 1, open[2]!);
  if (terminator === undefined) return undefined;
  const body = bodyText(lines, li, terminator);
  return {
    headerLine: li,
    bodyStart: header.start + header.text.length + 1,
    // -1 drops the newline that ends the last body line, so the slice is
    // exactly the body lines joined — same shape the embedded tokenizer sees.
    bodyEnd: terminator.start - 1,
    lang: heredocLang(header.text.slice(0, open.index!), body),
  };
}

/** Body text of a resolved heredoc, for language inference. */
function bodyText(lines: LineSpan[], headerLi: number, terminator: LineSpan): string {
  let out = "";
  for (let i = headerLi + 1; i < lines.length; i += 1) {
    if (lines[i] === terminator) break;
    out += `${lines[i]!.text}\n`;
  }
  return out;
}

/** Language for a heredoc: a redirect target file, else the interpreter. */
function heredocLang(lead: string, body: string): string | undefined {
  const redirect = /(>>?)\s*(\S+)/.exec(lead);
  if (redirect !== null) return langForFile(redirect[2]!, body);
  const bin = (lead.trim().split(/\s+/)[0] ?? "").replace(/^.*\//, "");
  return interpreterLang(bin);
}

/** Language for a filename: extension first, special files, then {@link guessLang}. */
function langForFile(name: string, body: string): string | undefined {
  const bare = name.replace(/^.*\//, "");
  const ext = (bare.split(".").pop() ?? "").toLowerCase();
  if (ext.length > 0 && EXT_LANG[ext] !== undefined) return EXT_LANG[ext];
  const special = SPECIAL_FILES[bare.toLowerCase()];
  if (special !== undefined) return special;
  return body.length > 0 ? guessLang(body) : undefined;
}

/** Shiki language for an interpreter binary name, or undefined when unknown. */
function interpreterLang(bin: string): string | undefined {
  return INTERPRETER_LANG[bin] ?? INTERPRETER_LANG[bin.replace(/-\d+(\.\d+)?$/, "")] ?? undefined;
}

/** Find the terminator line for a heredoc delimiter. */
function findTerminator(lines: LineSpan[], from: number, delimiter: string): LineSpan | undefined {
  for (let i = from; i < lines.length; i += 1) {
    if (lines[i]!.text.trimEnd() === delimiter) return lines[i]!;
  }
  return undefined;
}

const INLINE_RE = /(?:^|[;&|`\s(])(sudo\s+)?([\w./-]+)(\s+-[A-Za-z]+)*\s+(-c|-e|--eval|--exec|-r)\s*(?=['"])/g;

/**
 * Inline interpreter code: `python -c "…"`, `node -e '…'`.
 *
 * The region is the contents of the quoted argument — the quotes themselves
 * stay bash-colored. Multi-line quoted arguments are supported; the scan is
 * escape-aware so a `\"` inside the argument does not end the region.
 */
function collectInline(command: string, regions: EmbedRegion[]): void {
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(command)) !== null) {
    const lang = interpreterLang(m[2]!.replace(/^.*\//, ""));
    if (lang === undefined) continue;
    const quoteAt = m.index! + m[0]!.length;
    const close = scanQuoted(command, quoteAt + 1, command[quoteAt]!);
    if (close === undefined) continue;
    regions.push({ start: quoteAt + 1, end: close, lang });
  }
}

/**
 * Scan from `from` for the closing `quote`, honoring backslash escapes.
 * Returns its offset, or undefined when the quote never closes.
 */
function scanQuoted(text: string, from: number, quote: string): number | undefined {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
  }
  return undefined;
}

/** True when the highlight lines reconstruct `text` exactly, line for line. */
function sameShape(lines: HighlightLine[], text: string): boolean {
  const want = text.split("\n");
  if (lines.length !== want.length) return false;
  return lines.every((line, i) => line.reduce((n, run) => n + run.text.length, 0) === want[i]!.length);
}

type Resolved = { region: EmbedRegion; lines: HighlightLine[]; firstLine: number };

/**
 * Splice embedded-language tokens into a baseline highlight.
 *
 * `baseline` is the whole command colored as bash; for each region the
 * embedded slice is tokenized separately and its runs replace the baseline
 * runs covering the same offsets. Alignment is exact — output runs cover the
 * same characters the baseline runs did, so downstream wrapping and clipping
 * are unaffected. Returns `baseline` unchanged when nothing is usable.
 */
export function spliceEmbeds(
  baseline: HighlightLine[],
  code: string,
  regions: readonly EmbedRegion[],
  tokenize: (code: string, lang: string) => HighlightLine[],
): HighlightLine[] {
  if (regions.length === 0) return baseline;
  const lines = lineSpans(code);
  if (baseline.length !== lines.length) return baseline;

  const usable: Resolved[] = [];
  for (const region of regions) {
    const slice = code.slice(region.start, region.end);
    const tokens = tokenize(slice, region.lang);
    // An embedded tokenizer that reshapes the text would shift everything
    // after it. Require exact line-by-line reconstruction of the slice, then
    // the splice can copy embedded runs in by construction.
    if (!sameShape(tokens, slice)) continue;
    // A cold language tokenizes to colorless runs — keeping those would trade
    // the baseline's string color for nothing. Bash wins that exchange.
    if (!tokens.flat().some((run) => run.color !== undefined)) continue;
    usable.push({ region, lines: tokens, firstLine: lineContaining(lines, region.start) });
  }
  if (usable.length === 0) return baseline;

  const out: HighlightLine[] = [];
  for (let li = 0; li < lines.length; li += 1) {
    const span = lines[li]!;
    const lineEnd = span.start + span.text.length;
    const onLine = usable
      .filter((u) => u.region.start < lineEnd && u.region.end > span.start)
      .sort((a, b) => a.region.start - b.region.start);
    if (onLine.length === 0) {
      out.push(baseline[li]!);
      continue;
    }
    const runs: TokenRun[] = [];
    let cursor = span.start;
    for (const u of onLine) {
      if (u.region.start > cursor) pushBaseline(runs, baseline[li]!, span.start, cursor, u.region.start);
      // The embedded line covering this source line spans exactly the region.
      runs.push(...u.lines[li - u.firstLine]!);
      cursor = u.region.end;
    }
    if (lineEnd > cursor) pushBaseline(runs, baseline[li]!, span.start, cursor, lineEnd);
    out.push(runs.length > 0 ? runs : baseline[li]!);
  }
  return out;
}

/** Emit the baseline runs covering [from, to), split across run boundaries. */
function pushBaseline(out: TokenRun[], baseline: HighlightLine, lineStart: number, from: number, to: number): void {
  let pos = lineStart;
  for (const run of baseline) {
    const runFrom = pos;
    const runTo = pos + run.text.length;
    if (runTo <= from) {
      pos = runTo;
      continue;
    }
    if (runFrom >= to) break;
    const sliceFrom = Math.max(0, from - runFrom);
    const sliceTo = Math.min(run.text.length, to - runFrom);
    if (sliceTo > sliceFrom) out.push(copyRun(run, run.text.slice(sliceFrom, sliceTo)));
    pos = runTo;
  }
}

function copyRun(run: TokenRun, text: string): TokenRun {
  const next: TokenRun = { text };
  if (run.color !== undefined) next.color = run.color;
  if (run.bold === true) next.bold = true;
  if (run.italic === true) next.italic = true;
  return next;
}
