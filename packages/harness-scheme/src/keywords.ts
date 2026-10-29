/**
 * Arrival binds a record `inputRest` as keywords only and drops the positional
 * `input`. A verb that takes both declares an `sz.dynamic` rest and splits it
 * here: the first keyword ends the positionals, and each keyword decodes by
 * its own schema, so a default or an optional behaves as in a record rest.
 */
import { ASymbol } from "@here.build/arrival/reflect-internals";
import { z } from "zod";

export type KeywordShape = Readonly<Record<string, z.ZodType>>;

export type Keywords<S extends KeywordShape> = {
  readonly [K in keyof S]: z.output<S[K]>;
};

export function isKeyword(value: unknown): boolean {
  return value instanceof ASymbol && String(value).startsWith(":");
}

export function splitKeywords<S extends KeywordShape>(
  verb: string,
  args: readonly unknown[],
  shape: S,
): { readonly positionals: readonly unknown[]; readonly keywords: Keywords<S> } {
  const cut = args.findIndex((arg) => isKeyword(arg));
  const positionals = cut === -1 ? [...args] : args.slice(0, cut);
  while (positionals.length > 0 && positionals.at(-1) === undefined) positionals.pop();
  const tail = cut === -1 ? [] : args.slice(cut).filter((arg) => arg !== undefined);
  if (tail.length % 2 !== 0) throw new Error(`${verb}: dangling keyword ${String(tail.at(-1))}`);
  const raw = new Map<string, unknown>();
  for (let i = 0; i < tail.length; i += 2) {
    const key = tail[i];
    if (!isKeyword(key)) throw new Error(`${verb}: expected a keyword, got ${String(key)}`);
    const name = String(key).slice(1);
    if (!Object.hasOwn(shape, name)) {
      const known = Object.keys(shape).map((field) => `:${field}`);
      throw new Error(`${verb}: unknown keyword :${name}${known.length > 0 ? ` (known: ${known.join(", ")})` : ""}`);
    }
    if (raw.has(name)) throw new Error(`${verb}: keyword :${name} given twice`);
    raw.set(name, tail[i + 1]);
  }
  const keywords: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(shape)) {
    try {
      keywords[name] = schema.decode(raw.get(name));
    } catch (error) {
      const text =
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join("; ")
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`${verb}: :${name} — ${text}`, { cause: error });
    }
  }
  return { positionals, keywords: keywords as Keywords<S> };
}

/**
 * The rest after a verb's fixed positionals. `:k v` pairs, or one trailing
 * dict — the catalog teaches the dict form, and `String(dict)` is
 * "[object Object]", which is how a rejected dict used to surface.
 */
export function keywordsOf<S extends KeywordShape>(verb: string, rest: readonly unknown[], shape: S): Keywords<S> {
  if (rest.length === 1 && isPlainRecord(rest[0]) && !isKeyword(rest[0])) {
    return keywordsOf(verb, recordKeywords(rest[0]), shape);
  }
  const { positionals, keywords } = splitKeywords(verb, rest, shape);
  if (positionals.length > 0) throw new Error(`${verb}: unexpected argument ${String(positionals[0])}`);
  return keywords;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordKeywords(record: Record<string, unknown>): unknown[] {
  const pairs: unknown[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    pairs.push(new ASymbol(`:${name}`), value);
  }
  return pairs;
}
