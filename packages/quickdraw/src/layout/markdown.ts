/**
 * Markdown subset → LayoutNode tree (our engine only).
 * No external MD library. CSI stripped by caller via guard when needed.
 */

import type { LayoutNode } from "./types.js";
import type { Style } from "../buffer/index.js";
import { FgP } from "../lexicon/index.js";

export type MarkdownOpts = {
  key?: string;
  baseStyle?: Style;
};

/** Body voice — one HK-adjusted prominence. Headings lift to primary. */
function voiceBase(style?: Style): Style {
  return {
    ...style,
    role: style?.role ?? "foreground",
    prominence: style?.prominence ?? FgP.secondary,
  };
}

/** Inline: **bold**, *italic*, `code`, `[text](url)` — one markdown line. */
export function markdownInlineSegs(line: string, base: Style = {}): { text: string; style: Style }[] {
  const segs: { text: string; style: Style }[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      segs.push({ text: line.slice(last, m.index), style: base });
    }
    const tok = m[0]!;
    if (tok.startsWith("**")) {
      segs.push({
        text: tok.slice(2, -2),
        style: { ...base, bold: true },
      });
    } else if (tok.startsWith("*")) {
      segs.push({ text: tok.slice(1, -1), style: { ...base, italic: true } });
    } else if (tok.startsWith("`")) {
      segs.push({
        text: tok.slice(1, -1),
        style: { ...base, role: "code" }, // keep body prominence
      });
    } else if (tok.startsWith("[")) {
      const close = tok.indexOf("]");
      const label = close > 0 ? tok.slice(1, close) : tok;
      segs.push({
        text: label.length > 0 ? label : " ",
        style: { ...base, role: "accent", underline: true },
      });
    }
    last = m.index + tok.length;
  }
  if (last < line.length) segs.push({ text: line.slice(last), style: base });
  if (segs.length === 0) segs.push({ text: line, style: base });
  return segs;
}

function lineNode(key: string, line: string, style: Style): LayoutNode {
  // engine text is single-style per leaf; flatten bold runs by joining with markers lost → best-effort: strip markers for single style
  const plain = line
    .replaceAll(/\*\*([^*]+)\*\*/g, "$1")
    .replaceAll(/\*([^*]+)\*/g, "$1")
    .replaceAll(/`([^`]+)`/g, "$1");
  const bold = /\*\*/.test(line);
  const italic = !bold && /\*[^*]/.test(line);
  return {
    type: "text",
    key,
    content: plain,
    style: { ...style, bold: bold || style.bold, italic: italic || style.italic },
  };
}

const MD_CACHE_LIMIT = 64;
const mdCache = new Map<string, LayoutNode[]>();

function mdCacheKey(src: string, opts: MarkdownOpts): string {
  const style = opts.baseStyle;
  const styleKey =
    style == null
      ? ""
      : `${style.role ?? ""}:${String(style.prominence ?? "")}:${style.bold === true ? "b" : ""}:${style.italic === true ? "i" : ""}`;
  return `${opts.key ?? "md"}\0${styleKey}\0${src}`;
}

/**
 * Parse markdown subset into a column of text nodes.
 * Headings bold; lists prefixed; fences as code_pad indentation_exception.
 * Cached so measure+place share node identity (and wrap-cache hits).
 */
export function markdownToNodes(src: string, opts: MarkdownOpts = {}): LayoutNode[] {
  const cacheKey = mdCacheKey(src, opts);
  const cached = mdCache.get(cacheKey);
  if (cached !== undefined) {
    mdCache.delete(cacheKey);
    mdCache.set(cacheKey, cached);
    return cached;
  }
  const out = parseMarkdownNodes(src, opts);
  if (mdCache.size >= MD_CACHE_LIMIT) {
    const oldest = mdCache.keys().next().value;
    if (oldest !== undefined) mdCache.delete(oldest);
  }
  mdCache.set(cacheKey, out);
  return out;
}

function parseMarkdownNodes(src: string, opts: MarkdownOpts): LayoutNode[] {
  const base = voiceBase(opts.baseStyle);
  const heading = { ...base, prominence: FgP.primary };
  const key = opts.key ?? "md";
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const out: LayoutNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // fenced code
    if (line.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        body.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // close fence
      out.push({
        type: "indentation_exception",
        key: `${key}:fence-${n++}`,
        kind: "code_pad",
        children: body.map((l, j) => ({
          type: "text" as const,
          key: `${key}:c${n}-${j}`,
          content: l,
          style: { role: "code", prominence: base.prominence ?? FgP.secondary },
        })),
      });
      continue;
    }
    // Headings: same role as body, primary prominence. No emphasis hue.
    if (line.startsWith("### ")) {
      out.push(lineNode(`${key}:h3-${n++}`, line.slice(4), heading));
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(lineNode(`${key}:h2-${n++}`, line.slice(3), heading));
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(lineNode(`${key}:h1-${n++}`, line.slice(2), heading));
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const text = line.replace(/^\s*[-*]\s+/, "· ");
      out.push(lineNode(`${key}:li-${n++}`, text, base));
      i++;
      continue;
    }
    if (line.trim() === "") {
      out.push({ type: "text", key: `${key}:sp-${n++}`, content: " " });
      i++;
      continue;
    }
    out.push(lineNode(`${key}:p-${n++}`, line, base));
    i++;
  }
  return out.length > 0 ? out : [{ type: "text", key: `${key}:empty`, content: "" }];
}
