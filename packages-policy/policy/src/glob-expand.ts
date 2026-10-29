/**
 * Lexical brace expansion (`.e{nv,x}`, `a{1..3}`, `{a,b}{c,d}`), the way bash does it before
 * globbing. Used to judge a shell word as every word it could become. Bounded: past `limit`
 * words the caller falls back to a wildcard superset.
 */

const DEFAULT_LIMIT = 256;

type Group = { readonly start: number; readonly end: number; readonly items: readonly string[] };

export function expandBraces(
  word: string,
  limit: number = DEFAULT_LIMIT,
): { readonly words: readonly string[]; readonly overflow: boolean } {
  const done: string[] = [];
  const work: string[] = [word];
  while (work.length > 0) {
    const next = work.pop()!;
    const group = firstGroup(next);
    if (group === undefined) {
      done.push(next);
    } else {
      const head = next.slice(0, group.start);
      const tail = next.slice(group.end + 1);
      for (const item of group.items) work.push(`${head}${item}${tail}`);
    }
    if (done.length + work.length > limit) return { words: [], overflow: true };
  }
  return { words: done.toReversed(), overflow: false };
}

/** The first top-level `{...}` that bash would expand (a comma list or a range), or undefined. */
function firstGroup(text: string): Group | undefined {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] === "\\") {
      start += 1;
      continue;
    }
    if (text[start] !== "{") continue;
    const end = matchingBrace(text, start);
    if (end === undefined) continue;
    const body = text.slice(start + 1, end);
    const items = commaItems(body) ?? rangeItems(body);
    if (items !== undefined) return { start, end, items };
  }
  return undefined;
}

function matchingBrace(text: string, start: number): number | undefined {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/** Items of a top-level comma list. Undefined when there is no top-level comma. */
function commaItems(body: string): string[] | undefined {
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "\\") i += 1;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      items.push(body.slice(from, i));
      from = i + 1;
    }
  }
  if (items.length === 0) return undefined;
  items.push(body.slice(from));
  return items;
}

const RANGE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/;
const MAX_RANGE = 1024;

function rangeItems(body: string): string[] | undefined {
  const match = RANGE.exec(body);
  if (match === null) return undefined;
  const [, a, b, stepText] = match;
  const step = Math.max(1, Math.abs(Number(stepText ?? "1")) || 1);
  const out: string[] = [];
  if (/^-?\d+$/.test(a!) && /^-?\d+$/.test(b!)) {
    const from = Number(a);
    const to = Number(b);
    const width =
      /^-?0\d/.test(a!) || /^-?0\d/.test(b!) ? Math.max(a!.replace("-", "").length, b!.replace("-", "").length) : 0;
    if (Math.abs(to - from) / step > MAX_RANGE) return Array.from({ length: MAX_RANGE + 1 }, (_, i) => String(i));
    for (let n = from; from <= to ? n <= to : n >= to; n += from <= to ? step : -step) {
      const text = String(Math.abs(n)).padStart(width, "0");
      out.push(n < 0 ? `-${text}` : text);
    }
    return out;
  }
  if (a!.length === 1 && b!.length === 1 && !/\d/.test(a! + b!)) {
    const from = a!.codePointAt(0)!;
    const to = b!.codePointAt(0)!;
    for (let c = from; from <= to ? c <= to : c >= to; c += from <= to ? step : -step)
      out.push(String.fromCodePoint(c));
    return out;
  }
  return undefined;
}
