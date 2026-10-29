// Tape projection of substrate `unwrap-begin.ts`. Execution splices the AST;
// this file splices the stored expr so the identity line matches what ran.
// CHANGE ONLY with that file — same three wrappers, same quote/dot refusals.

import { tokenize } from "@here.build/arrival/lsp-internals";

const SPLICE_HEADS = new Set(["begin", "list"]);
const CLOSE = new Set([")", "]", "}"]);
const QUOTE_PREFIX = new Set(["'", "`", ",", ",@"]);

function isOpen(tok: string): boolean {
  return (
    tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("))
  );
}

function isSkippable(tok: string): boolean {
  return /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");
}

type Token = { readonly token: string; readonly offset: number };

function tokenAt(tokens: readonly Token[], index: number): Token | undefined {
  return tokens[index];
}

function skipSkippable(tokens: readonly Token[], index: number): number {
  let i = index;
  for (;;) {
    const tok = tokenAt(tokens, i);
    if (tok == null || !isSkippable(tok.token)) return i;
    i += 1;
  }
}

function splitTopLevel(source: string): string[] {
  const tokens = tokenize(source, true);
  const starts: number[] = [];
  let depth = 0;
  let between = true;
  for (const { token, offset } of tokens) {
    if (isSkippable(token)) continue;
    if (between) {
      starts.push(offset);
      between = false;
    }
    if (isOpen(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      if (depth === 0) between = true;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      between = true;
    }
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length).trim()).filter(Boolean);
}

function matchGroup(
  tokens: readonly Token[],
  openIdx: number,
  closeTok: string,
): { readonly closeIdx: number; readonly dotted: boolean } | undefined {
  let depth = 0;
  let dotted = false;
  for (let i = openIdx; i < tokens.length; i++) {
    const row = tokenAt(tokens, i);
    if (row == null) return undefined;
    const tok = row.token;
    if (isSkippable(tok)) continue;
    if (isOpen(tok)) {
      depth += 1;
      continue;
    }
    if (CLOSE.has(tok)) {
      depth -= 1;
      if (depth === 0) {
        if (tok !== closeTok) return undefined;
        return { closeIdx: i, dotted };
      }
      continue;
    }
    if (depth === 1 && tok === ".") dotted = true;
  }
  return undefined;
}

function wrapperInterior(src: string): string[] | undefined {
  const tokens = tokenize(src, true);
  const firstIdx = skipSkippable(tokens, 0);
  const first = tokenAt(tokens, firstIdx);
  if (first == null || QUOTE_PREFIX.has(first.token)) return undefined;

  if (first.token === "[" || first.token === "#(") {
    const closed = matchGroup(tokens, firstIdx, first.token === "[" ? "]" : ")");
    if (closed == null || closed.dotted) return undefined;
    if (skipSkippable(tokens, closed.closeIdx + 1) < tokens.length) return undefined;
    const closer = tokenAt(tokens, closed.closeIdx);
    if (closer == null) return undefined;
    return splitTopLevel(src.slice(first.offset + first.token.length, closer.offset));
  }

  if (first.token !== "(") return undefined;
  const nameIdx = skipSkippable(tokens, firstIdx + 1);
  const name = tokenAt(tokens, nameIdx);
  if (name == null || !SPLICE_HEADS.has(name.token.toLowerCase())) return undefined;
  const closed = matchGroup(tokens, firstIdx, ")");
  if (closed == null || closed.dotted) return undefined;
  if (skipSkippable(tokens, closed.closeIdx + 1) < tokens.length) return undefined;
  const closer = tokenAt(tokens, closed.closeIdx);
  if (closer == null) return undefined;
  return splitTopLevel(src.slice(name.offset + name.token.length, closer.offset));
}

export function unwrapTopLevelSource(src: string): string {
  if (src.trim() === "") return src;
  try {
    const out: string[] = [];
    let spliced = false;
    const visit = (stmt: string): void => {
      const body = wrapperInterior(stmt);
      if (body === undefined) {
        out.push(stmt);
        return;
      }
      spliced = true;
      for (const inner of body) visit(inner);
    };
    for (const stmt of splitTopLevel(src)) visit(stmt);
    return spliced ? out.join("\n") : src;
  } catch {
    return src;
  }
}
