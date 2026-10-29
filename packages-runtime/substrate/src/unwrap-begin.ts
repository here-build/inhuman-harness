// unwrap-begin — splice top-level `(begin …)`, `(list …)`, and `[]` into the REPL
// statement list.
//
// Models wrap a multi-statement program in one of those three spellings. The
// runner already evaluates each top-level form as its own statement and records
// every non-void result. A wrapping begin/list/vector is one form, so eval keeps
// only the last value (or one collected list), and analyzeStatement never sees
// inner `define`s.
//
// R7RS §5.6.1: a top-level begin is splicing. `(list …)` and `[…]` are the other
// two "I have several statements" habits — same splice. Nested begin/list/`[]`
// inside `if`, `lambda`, … is sequencing / data — leave it. An improper
// `(begin . x)` / `(list . x)` is not a splice; leave it so eval fails honestly.
// Quote / quasiquote / unquote prefixes are not a splice.

import { ANil, type SchemeValue } from "@here.build/arrival";
import { tokenize } from "@here.build/arrival/lsp-internals";
import { APair, ASymbol, AVector } from "@here.build/arrival/reflect-internals";

export type TopLevelSplice = "begin" | "list" | "vector";

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

function isBeginOrListCall(form: SchemeValue): form is APair<ASymbol, SchemeValue> {
  if (!(form instanceof APair) || !(form.car instanceof ASymbol)) return false;
  const name = form.car.__name__;
  return typeof name === "string" && SPLICE_HEADS.has(name);
}

/** Proper-list body, or `undefined` when the form is not a splice. */
function properListBody(form: APair<SchemeValue, SchemeValue>): SchemeValue[] | undefined {
  const body: SchemeValue[] = [];
  const seen = new Set<object>();
  let cur: SchemeValue = form.cdr;
  while (cur instanceof APair) {
    if (seen.has(cur)) return undefined;
    seen.add(cur);
    body.push(cur.car);
    cur = cur.cdr;
  }
  if (!(cur instanceof ANil)) return undefined;
  return body;
}

function spliceOf(
  form: SchemeValue,
): { readonly kind: TopLevelSplice; readonly body: readonly SchemeValue[] } | undefined {
  if (form instanceof AVector) return { kind: "vector", body: form.__vector__ };
  if (!isBeginOrListCall(form)) return undefined;
  const body = properListBody(form);
  if (body === undefined) return undefined;
  const name = form.car.__name__;
  if (name !== "begin" && name !== "list") return undefined;
  return { kind: name, body };
}

export type TopLevelUnwrap = {
  readonly forms: readonly SchemeValue[];
  readonly kinds: readonly TopLevelSplice[];
};

/**
 * Recursively splice every top-level `(begin …)`, `(list …)`, and `[]` into its
 * body. Identity when there is no splice — callers use that to keep source-aligned
 * display text. `kinds` is each splice spelling once, in first-seen order.
 */
export function unwrapTopLevel(forms: readonly SchemeValue[]): TopLevelUnwrap {
  if (!forms.some((form) => spliceOf(form) !== undefined)) return { forms, kinds: [] };
  const out: SchemeValue[] = [];
  const kinds: TopLevelSplice[] = [];
  const seen = new Set<TopLevelSplice>();
  const visit = (form: SchemeValue): void => {
    const splice = spliceOf(form);
    if (splice !== undefined) {
      if (!seen.has(splice.kind)) {
        seen.add(splice.kind);
        kinds.push(splice.kind);
      }
      for (const inner of splice.body) visit(inner);
      return;
    }
    out.push(form);
  };
  for (const form of forms) visit(form);
  return { forms: out, kinds };
}

export function unwrapTopLevelBegins(forms: readonly SchemeValue[]): readonly SchemeValue[] {
  return unwrapTopLevel(forms).forms;
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
    const innerStart = first.offset + first.token.length;
    return splitTopLevel(src.slice(innerStart, closer.offset));
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
  const innerStart = name.offset + name.token.length;
  return splitTopLevel(src.slice(innerStart, closer.offset));
}

/**
 * Sync projection of {@link unwrapTopLevelBegins} over source text. Identity when
 * there is no splice, so comments and spacing stay put.
 */
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
