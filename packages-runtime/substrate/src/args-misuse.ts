// args-misuse — localize an upstream (or own-decode) misuse rejection to the ONE failing
// top-level kwarg. Two pure functions, no session state (mirrors doors.ts's door-generator discipline):
//
//   extractClues(errorText)              — upstream prose → a family-tagged clue list.
//   localizeFailingParam(text, args, schema) — clue + the ARGS THE MODEL ACTUALLY SENT
//                                              (ground truth at the boundary) → the ONE
//                                              param it implicates, or `undefined` when the
//                                              evidence is ambiguous (never a guess rendered
//                                              as fact — the module's central discipline,
//                                              shared with doors.ts).
//
// Six clue families: the OWN-DECODE pair first (arrival's kwargs-rejection grammar names
// its param natively — own-unknown-key tight-matches a top-level typo against the declared
// params, own-decode's dotted path resolves like a zod path; design doc §2.5's first-priority
// rule), then the design doc §2.2 table — three python-jsonschema prose shapes
// (value-mismatch, unexpected-keys, required-key) plus the TS-SDK/zod issues[].path family.
// zod-path/own-decode are AUTHORITATIVE (the path IS the answer, no walk needed);
// value-mismatch and unexpected-keys walk the SENT-ARGS tree (args are ground truth);
// required-key walks the SCHEMA (a missing key has no sent-args leaf to find).
//
// This file does not render prose (that's the `argsMisuseDoor` scope, design doc §2.3) —
// it only ever answers "which param, if any, does this evidence name with certainty."

import { isTightKeyMatch } from "./doors.js";
import type { JsonSchemaProperty, ToolJsonSchema } from "./tool-schema.js";

/** One family-tagged clue pulled from an upstream (or own-decode) rejection's prose. */
export interface ArgsClue {
  kind: "own-unknown-key" | "own-decode" | "zod-path" | "value-mismatch" | "unexpected-keys" | "required-key";
  /** own-decode/zod-path: the failing param's path segments (own-decode splits the dotted
   *  `:<path> —` line head; zod-path stringifies the issues[].path array). own-unknown-key:
   *  the ONE rejected top-level keyword (which by definition resolves to no schema path —
   *  its resolver tight-matches it against the declared params instead). Others: the quoted
   *  token(s) from the prose (a single token for value-mismatch/required-key, one-or-more for
   *  unexpected-keys). */
  tokens: readonly string[];
  /** value-mismatch only: the expected type named by the error ("object", "array", …). */
  expectedType?: string;
  /** own-decode only: the humanized issue tail (`missing (required)`, `expected number, got
   *  string: "50"`, …) — lets the renderer distinguish a MISSING required arg (which earns the
   *  discovery nudge — don't punt to the user, enumerate it) from a type mismatch. */
  issue?: string;
}

/** The localization result: the ONE param path a clue implicates, resolved against BOTH the
 *  sent-args tree (ground truth) and the tool's declared schema (soundness — never names a
 *  param the schema doesn't have). */
export interface Localized {
  /** Path from the call's top-level kwargs to the failing value/container, e.g. `["query"]`. */
  path: readonly string[];
  clue: ArgsClue;
  /** The sub-schema at `path`, resolved against the tool's inputSchema. */
  subSchema: JsonSchemaProperty;
  /** The value the model actually sent at `path` (when args were available to walk). */
  sentValue?: unknown;
}

// ─── clue extraction — pure regex families over the upstream's OWN prose ───
//
// Every regex is deliberately narrow (matches the exact phrasing python-jsonschema / the TS
// MCP SDK emit, per the design doc's fixtures) rather than a general natural-language parser —
// a clue that fails to match falls through to `undefined` (today's Signature + Example fallback),
// which is always safe; a clue that matches WRONGLY would risk naming an absent param, which
// isn't — so narrow-and-miss is the correct failure mode, never broad-and-guess.

/** TS SDK / zod issues JSON: captures the CONTENTS of a `"path": [...]` array literal —
 *  intersected with the surrounding text rather than requiring the whole message to be one
 *  JSON blob, since the upstream frequently wraps issues JSON inside its own prose (e.g.
 *  `Input validation error: Invalid arguments for tool X: [{...}]`).
 *  An incidental `"path"` fragment elsewhere in wrapped prose CAN match, but it only ever
 *  becomes a Localized after `walkSchema` verifies the path against the tool's own schema —
 *  a coincidental match either names a real declared param or is discarded, never invents
 *  one. Anchoring on the full issues-array shape would trade that residual for missing
 *  legitimately re-wrapped blobs — the wrong side of narrow-and-miss. */
const ZOD_PATH_RE = /"path"\s*:\s*(\[[^\]]*])/g;

/** python-jsonschema value-mismatch: `'<sent value>' is not of type '<expected type>'`. Both
 *  captures are single-quoted prose tokens (python's own repr convention for a string leaf) —
 *  a non-string sent value (a bare number/bool) renders unquoted by python and is deliberately
 *  NOT matched here (see `resolveValueMismatch`'s doc for why the sent-args walk is
 *  string-leaf-only, the same scope boundary). A sent value with an EMBEDDED apostrophe
 *  (`'King's …'`) splits the capture — the truncated token then matches no sent-args leaf and
 *  localization declines to the fallback (narrow-and-miss, never a wrong leaf). */
const VALUE_MISMATCH_RE = /'([^']*)' is not of type '([^']*)'/g;

/** python-jsonschema unexpected-keys: `Additional properties are not allowed ('k1', 'k2' were
 *  unexpected)` — captures the parenthesized clause; {@link QUOTED_TOKEN_RE} pulls every
 *  quoted key out of it below. */
const UNEXPECTED_KEYS_RE = /Additional properties are not allowed \(([^)]*)\)/g;

/** Any single-quoted token — reused to pull one-or-more keys out of an
 *  {@link UNEXPECTED_KEYS_RE} match's parenthesized clause. */
const QUOTED_TOKEN_RE = /'([^']*)'/g;

/** python-jsonschema required-key: `'<key>' is a required property`. */
const REQUIRED_KEY_RE = /'([^']*)' is a required property/g;

/** OUR OWN kwargs-decode rejection (arrival common/kwargs-rejection.ts's frozen grammar,
 *  design doc §2.5): `<qualified>: arguments rejected — N problem(s):` followed by
 *  `  :<dotted.path> — <issue>` lines. The head gate keeps the line-head regex from firing on
 *  arbitrary `:foo —` prose in an unrelated upstream error. */
const OWN_DECODE_HEAD_RE = /(?:^|: )arguments rejected — \d+ problem\(s\):/;
const OWN_DECODE_LINE_RE = /^ {2}:([\w.-]+) — (.*)$/gm;

/** The strict decode's per-key unknown-key issue tail (kwargs-rejection.ts's frozen
 *  grammar). An unknown key is NOT a schema path — walking it as one always misses — so
 *  it gets its own clue family (tight-match against the declared params) instead of the
 *  generic own-decode path family. */
const OWN_UNKNOWN_KEY_TAIL = "unknown key";

/** Extract every clue an upstream (or own-decode) rejection's prose carries, in family
 *  PRIORITY order (design doc §2.2: zod-path is authoritative — a structured path needs no
 *  walk — so it's tried first by every caller that iterates this list). A single error text
 *  may carry more than one clue of the same family (a multi-issue zod rejection) or, in
 *  principle, clues from more than one family; callers try each in order and stop at the
 *  first that localizes soundly (see {@link localizeFailingParam}). Zero clues ⇒ empty array
 *  (never `undefined` — "no clue" and "clue that didn't localize" are different states, only
 *  the latter is this module's job to fall back FROM). */
export function extractClues(errorText: string): ArgsClue[] {
  const clues: ArgsClue[] = [];

  // own-decode families FIRST (design doc §2.5: first-priority — the message names its
  // failing param natively in a grammar WE freeze, so it outranks even zod-path). Within
  // them, UNKNOWN-KEY lines outrank the rest: a top-level keyword typo usually CAUSES the
  // sibling missing-required issue (`:qeury` typo ⇒ `:query` missing) — teaching the rename
  // fixes both, while teaching the missing key first never names the typo.
  if (OWN_DECODE_HEAD_RE.test(errorText)) {
    const unknownKeys: ArgsClue[] = [];
    const paths: ArgsClue[] = [];
    for (const m of errorText.matchAll(OWN_DECODE_LINE_RE)) {
      if (m[2] === OWN_UNKNOWN_KEY_TAIL) unknownKeys.push({ kind: "own-unknown-key", tokens: [m[1]!] });
      else paths.push({ kind: "own-decode", tokens: m[1]!.split("."), issue: m[2] });
    }
    clues.push(...unknownKeys, ...paths);
  }

  for (const m of errorText.matchAll(ZOD_PATH_RE)) {
    let path: unknown;
    try {
      path = JSON.parse(m[1]!);
    } catch {
      continue; // malformed fragment (e.g. truncated prose) — not a real zod-path clue.
    }
    if (Array.isArray(path) && path.length > 0) {
      clues.push({ kind: "zod-path", tokens: path.map(String) });
    }
  }

  for (const m of errorText.matchAll(VALUE_MISMATCH_RE)) {
    clues.push({ kind: "value-mismatch", tokens: [m[1]!], expectedType: m[2] });
  }

  for (const m of errorText.matchAll(UNEXPECTED_KEYS_RE)) {
    const keys = [...m[1]!.matchAll(QUOTED_TOKEN_RE)].map((k) => k[1]!);
    if (keys.length > 0) clues.push({ kind: "unexpected-keys", tokens: keys });
  }

  for (const m of errorText.matchAll(REQUIRED_KEY_RE)) {
    clues.push({ kind: "required-key", tokens: [m[1]!] });
  }

  return clues;
}

// ─── schema/args tree walks — shared primitives ───

/** Resolve a path of object-property names against a schema node's `properties`, one segment
 *  at a time. `undefined` the moment a segment isn't declared — the caller's "verify it
 *  resolves in the schema, else discard" step (design doc §2.2), and S2's soundness
 *  invariant: a `Localized.path` is NEVER returned without a resolved `subSchema` alongside
 *  it, so a param absent from the schema can never be named. `properties`-only by scope: an
 *  array-index segment (zod paths like `["items", 0, "name"]`) or a `patternProperties`-only
 *  shape has no `properties` entry to walk, so such paths DECLINE to the fallback rather than
 *  localize — completeness ceded, soundness kept. */
function walkSchema(
  schema: JsonSchemaProperty | ToolJsonSchema | undefined,
  path: readonly string[],
): JsonSchemaProperty | undefined {
  let node: JsonSchemaProperty | undefined = schema as JsonSchemaProperty | undefined;
  for (const segment of path) {
    node = node?.properties?.[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/** Resolve a path of keys against the SENT-ARGS tree (plain JSON-ish values — objects/arrays/
 *  scalars, never a schema). `undefined` on any missing/non-object step — the same
 *  "unavailable, don't guess" posture as {@link walkSchema}. */
function walkValue(args: unknown, path: readonly string[]): unknown {
  let node = args;
  for (const segment of path) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Collect every STRING leaf path in `node` whose value equals `token` exactly. Restricted to
 *  string leaves (never numbers/booleans coerced to string) because {@link VALUE_MISMATCH_RE}
 *  only ever captures a python-quoted token — python's jsonschema only quotes STRING repr this
 *  way, so a token can only ever have come from a string leaf; matching a coerced number would
 *  risk a false candidate (e.g. sent `{a: "5", b: 5}` — a token `"5"` must localize to `a`
 *  alone, not tie against `b`). Descends through plain objects and arrays; a computed arg the
 *  caller could only record as an opaque marker (design doc §2.2 "Where sentArgs come from",
 *  the form-walk fallback) never equals a real sent string, so it correctly contributes zero
 *  candidates rather than a wrong one. */
function collectStringLeafPaths(node: unknown, token: string, path: readonly string[], out: string[][]): void {
  if (typeof node === "string") {
    if (node === token) out.push([...path]);
    return;
  }
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) collectStringLeafPaths(item, token, [...path, String(i)], out);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      collectStringLeafPaths(value, token, [...path, key], out);
    }
  }
}

/** Collect the path of every plain-object NODE (never the root itself — root has no single
 *  kwarg name to report) that carries every one of `tokens` as its OWN key. Case B/C of the
 *  design doc (§2.2 unexpected-keys walk): the bad key(s) live one level inside a top-level
 *  kwarg's object value (`:query {:terms ...}` → the `query` node has key `terms`), so the
 *  candidate is the CONTAINING node's path, not the bad key's own path (there is no "path to a
 *  key that doesn't exist" — the container is what needs teaching). */
function collectObjectNodesWithKeys(
  node: unknown,
  tokens: readonly string[],
  path: readonly string[],
  out: string[][],
  isRoot: boolean,
): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  if (!isRoot) {
    const keys = new Set(Object.keys(record));
    if (tokens.every((t) => keys.has(t))) out.push([...path]);
  }
  for (const [key, value] of Object.entries(record)) {
    collectObjectNodesWithKeys(value, tokens, [...path, key], out, false);
  }
}

/** Collect every schema-node path whose OWN `required` list includes `token` — root first
 *  (`path: []`, a missing TOP-LEVEL kwarg), then every nested object property, recursively.
 *  Design doc §2.2 required-key walk: "walk the SCHEMA for nodes whose required includes the
 *  token" (a missing key has no sent-args leaf, so this is schema-only, unlike the other three
 *  families). */
function findRequiredKeyNodes(
  schema: JsonSchemaProperty | ToolJsonSchema | undefined,
  token: string,
  path: readonly string[],
  out: string[][],
): void {
  if (!schema) return;
  const node = schema as JsonSchemaProperty;
  if (node.required?.includes(token)) out.push([...path]);
  if (node.properties) {
    for (const [key, prop] of Object.entries(node.properties)) {
      findRequiredKeyNodes(prop, token, [...path, key], out);
    }
  }
}

// ─── per-family resolution — each returns a sound Localized or undefined, never a guess ───

/** zod-path: authoritative — the path IS the answer, just verified against the schema (and,
 *  when available, read off the sent-args tree for `sentValue`). */
function resolveZodPath(
  clue: ArgsClue,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  if (clue.tokens.length === 0) return undefined;
  const subSchema = walkSchema(schema, clue.tokens);
  if (subSchema === undefined) return undefined;
  return { path: clue.tokens, clue, subSchema, sentValue: sentArgs ? walkValue(sentArgs, clue.tokens) : undefined };
}

/** value-mismatch: exactly-one-candidate-or-undefined over the sent-args string leaves. */
function resolveValueMismatch(
  clue: ArgsClue,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  const token = clue.tokens[0];
  if (token === undefined || sentArgs === undefined) return undefined;
  const candidates: string[][] = [];
  collectStringLeafPaths(sentArgs, token, [], candidates);
  if (candidates.length !== 1) return undefined;
  const path = candidates[0]!;
  const subSchema = walkSchema(schema, path);
  if (subSchema === undefined) return undefined;
  return { path, clue, subSchema, sentValue: token };
}

/** unexpected-keys: exactly-one-candidate-or-undefined over object nodes carrying every bad
 *  key; cross-checked against the schema declaring `properties` at that path (design doc's
 *  truthfulness requirement — the "only these keys exist" teaching must be a fact). */
function resolveUnexpectedKeys(
  clue: ArgsClue,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  if (clue.tokens.length === 0 || sentArgs === undefined) return undefined;
  const candidates: string[][] = [];
  collectObjectNodesWithKeys(sentArgs, clue.tokens, [], candidates, true);
  if (candidates.length !== 1) return undefined;
  const path = candidates[0]!;
  const subSchema = walkSchema(schema, path);
  if (subSchema?.properties === undefined) return undefined;
  return { path, clue, subSchema, sentValue: walkValue(sentArgs, path) };
}

/** required-key: schema-only walk for the containing node(s), tie-broken toward the node the
 *  model actually sent (evidence it meant to fill that container in, just dropped one key).
 *  A root-level match (`nodePath: []`, the missing key IS a top-level kwarg) reports `path:
 *  [token]` — there is no shallower container to point at than the missing kwarg itself; a
 *  nested match reports the CONTAINING node's path (mirrors unexpected-keys — the container is
 *  what needs teaching, not a path to a key that was never written). */
function resolveRequiredKey(
  clue: ArgsClue,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  const token = clue.tokens[0];
  if (token === undefined) return undefined;
  const nodePaths: string[][] = [];
  findRequiredKeyNodes(schema, token, [], nodePaths);
  if (nodePaths.length === 0) return undefined;
  let chosen = nodePaths;
  if (nodePaths.length > 1 && sentArgs !== undefined) {
    const backed = nodePaths.filter((p) => {
      const v = walkValue(sentArgs, p);
      return v !== null && typeof v === "object" && !Array.isArray(v);
    });
    if (backed.length > 0) chosen = backed;
  }
  if (chosen.length !== 1) return undefined;
  const nodePath = chosen[0]!;
  const path = nodePath.length === 0 ? [token] : nodePath;
  const subSchema = walkSchema(schema, path);
  if (subSchema === undefined) return undefined;
  return { path, clue, subSchema, sentValue: sentArgs ? walkValue(sentArgs, path) : undefined };
}

/** own-unknown-key: the strict decode rejected a TOP-LEVEL keyword that matches no declared
 *  param — there is no schema path to walk, so soundness comes from the tight-match gate
 *  instead: EXACTLY one declared top-level param within canonical edit distance 1 of the
 *  rejected key ⇒ that param is the lesson (the model typo'd its name); zero or several ⇒
 *  decline (never a guessed rename). `path` names the MATCHED param (the tracker's lesson
 *  key and the sub-schema to teach); the clue's token keeps the model's own bad spelling
 *  for the fact line. */
function resolveOwnUnknownKey(
  clue: ArgsClue,
  _sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  const bad = clue.tokens[0];
  if (bad === undefined || schema?.properties === undefined) return undefined;
  const matches = Object.keys(schema.properties).filter((k) => isTightKeyMatch(bad, k));
  if (matches.length !== 1) return undefined;
  const path = [matches[0]!];
  const subSchema = walkSchema(schema, path);
  if (subSchema === undefined) return undefined;
  return { path, clue, subSchema };
}

/** One resolver per {@link ArgsClue} family — a lookup table instead of a nested ternary chain,
 *  so adding a family (the own-decode clues, design doc §2.5) is a one-line addition, not
 *  a re-threaded conditional. */
const RESOLVERS: {
  readonly [K in ArgsClue["kind"]]: (
    clue: ArgsClue,
    sentArgs: Record<string, unknown> | undefined,
    schema: ToolJsonSchema | undefined,
  ) => Localized | undefined;
} = {
  "own-unknown-key": resolveOwnUnknownKey,
  // own-decode resolves exactly like zod-path: the path IS the answer (our own frozen grammar
  // named it), verified against the schema before it may be taught (same soundness gate).
  "own-decode": resolveZodPath,
  "zod-path": resolveZodPath,
  "value-mismatch": resolveValueMismatch,
  "unexpected-keys": resolveUnexpectedKeys,
  "required-key": resolveRequiredKey,
};

/** Localize a misuse rejection's failing parameter — the args-as-ground-truth pipeline (design
 *  doc §2.2): extract every clue, try each in family-priority order, return the FIRST that
 *  resolves against both the sent-args tree and the tool's schema. Zero clues, or every clue
 *  ambiguous (0 or several candidates) ⇒ `undefined` — the caller falls back to today's
 *  Signature + Example echo, NEVER a guessed param name (S2's soundness law, shared with
 *  doors.ts's "never phrase a guess as a fact" discipline). `sentArgs` absent (schema-only
 *  resolution) still localizes zod-path/required-key clues (no walk needed / schema-only by
 *  nature); value-mismatch/unexpected-keys need args to walk and correctly decline without
 *  them.
 *
 *  First-sound-wins is deliberate for a MULTI-clue rejection (a multi-issue zod blob names
 *  several failing paths): every schema-verified zod path is an authoritative fact about a
 *  genuinely failing param, so teaching the first one is never a guess — the model fixes it,
 *  the next rejection carries only the remaining issues, and the ladder converges one true
 *  lesson at a time. */
export function localizeFailingParam(
  errorText: string,
  sentArgs: Record<string, unknown> | undefined,
  schema: ToolJsonSchema | undefined,
): Localized | undefined {
  for (const clue of extractClues(errorText)) {
    const localized = RESOLVERS[clue.kind](clue, sentArgs, schema);
    if (localized) return localized;
  }
  return undefined;
}
