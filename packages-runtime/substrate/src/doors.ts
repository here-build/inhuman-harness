// doors — the envelope error surface (errors-as-doors).
//
// Every boundary rejection at the single-tool MCP envelope is turned into a structured `Door`
// (code, fact, reason, script, terse). Doors are built at the rejection site and rendered
// to prose by the output layer.
//
// Codes are internal (routing + telemetry + per-shape verbosity gating). The text a model sees
// never contains the raw code.
//
// Verbosity model: per-shape first occurrence in a server process lifetime is verbose
// (teaching); subsequent occurrences are terse. The `DoorSession` (output layer) tracks this.
// Door generators are pure and stateless.
//
// Core principle: never phrase a guess as a fact. Explicit matches use "the symbol you want
// is X"; ambiguous cases offer menus.

import type { BoundTool, ToolNaming } from "./bound-tool.js";
import { synthesizeExampleCall } from "./example-call.js";
import type { ToolJsonSchema } from "./tool-schema.js";
import type { TypeHintTelemetry } from "./type-hints/types.js";

/** Internal codes for routing, telemetry, and per-shape verbosity gating.
 * Never appear in prose shown to models. */
export type DoorCode =
  | "envelope/bare-tool-call"
  | "envelope/unknown-tool"
  | "envelope/empty-expr"
  | "envelope/invalid-args"
  | "envelope/unbound-in-expr"
  | "envelope/scope-confusion"
  | "envelope/import-form"
  | "envelope/signature-echo"
  | "envelope/args-misuse"
  | "envelope/futile-retry"
  | "envelope/duplicate-call"
  | "envelope/bypass-autoexec"
  | "envelope/call-budget"
  | "envelope/unterminated-dict";

/** One boundary rejection, built AT the rejection point. `fact` names what collided,
 *  `reason` why the envelope owns it, `script` the exact recovery action (verbose
 *  rendering = fact + Why + script; `terse` is the one-liner for repeat occurrences —
 *  also built here so the output layer only ever CHOOSES, never composes). */
export interface Door {
  code: DoorCode;
  /** Per-SHAPE verbosity gate key (the OUTPUT layer's `DoorSession` keys its first-occurrence
   *  Set on `verbosityKey ?? code`). Set ONLY on a code that a SINGLE generator does NOT own —
   *  i.e. a code several DISTINCT lesson shapes emit (different trigger, different text), where
   *  each shape must teach FULLY on its own first occurrence rather than inherit a sibling
   *  shape's already-spent verbose slot. Absent (⇒ falls back to `code`) for every code with
   *  exactly one shape, so those keep the plain per-code gate byte-for-byte. `code` stays the
   *  telemetry/routing key regardless (Rule 3) — this only ever refines the verbosity gradient. */
  verbosityKey?: string;
  fact: string;
  reason: string;
  script: string;
  terse: string;
}

// ─── literal rendering — the retry expr is built from the caller's own JSON args ───
// Same literal conventions as render-observation ({:k v} dicts, [...] vectors, quoted
// strings, true/false/nil — all first-class reader grammar), so the rendered retry is
// parseable by construction: pasting it into the manifold's expr evaluates.

const escapeString = (s: string): string =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`)
    .replaceAll("\r", String.raw`\r`);

const BARE_KEY = /^[a-z][\w-]*$/i;

function renderJsonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => renderJsonLiteral(v)).join(" ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = BARE_KEY.test(k) ? `:${k}` : `"${escapeString(k)}"`;
      return `${key} ${renderJsonLiteral(v)}`;
    });
    return `{${pairs.join(" ")}}`;
  }
  return `"${escapeString(String(value))}"`;
}

/** TOP-LEVEL argument keys that CANNOT be written as a `:keyword` atom — a space, punctuation, or
 *  leading digit that a JSON object key / JSON Schema property name allows but this dialect's
 *  keyword-atom syntax can't read as one token (`:weird key` reads as THREE tokens — `:weird`,
 *  the symbol `key`, then the value — never one kwarg). Only the TOP-LEVEL kwargs slot is affected:
 *  a non-bare key INSIDE a `{...}` dict-literal VALUE is a different grammar position that
 *  {@link renderJsonLiteral} already quotes correctly, so this never recurses. Empty ⇒ every key
 *  renders as a faithful `:key value` pair. Reuses {@link BARE_KEY} — the same predicate
 *  renderJsonLiteral's dict branch and example-call.ts's renderCall use. */
export function nonBareKwargKeys(args: Record<string, unknown> | undefined): string[] {
  return Object.keys(args ?? {}).filter((k) => !BARE_KEY.test(k));
}

/** The exact retry expr for a bare tool call: the attempted JSON args as interleaved `:key value`
 *  kwargs on the QUALIFIED symbol — parseable by construction — OR `undefined` when no faithful
 *  call exists because a TOP-LEVEL argument key isn't a valid scheme keyword
 *  ({@link nonBareKwargKeys}). There is NO escape hatch: unlike a dict-literal VALUE's key (which
 *  renderJsonLiteral quotes inside `{...}`), the kwargs-call grammar has no quoted-key form, AND
 *  arrival's kwargs runtime rejects a single dict argument as an alternative ("kwargs call has a
 *  dangling keyword with no value — expected interleaved `:key value` pairs" — verified against the
 *  interpreter), so such an argument is STRUCTURALLY inexpressible to a bound tool. Callers MUST
 *  handle `undefined` — the LIVE bypass path (server.ts's autoExecuteBypass) declines to
 *  auto-execute and falls back to teaching; the teaching doors here degrade their script — and the
 *  `string | undefined` return makes emitting broken syntax a compile error rather than a
 *  runtime misfire. */
export function renderRetryExpr(qualifiedName: string, args: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return `(${qualifiedName})`;
  if (entries.some(([k]) => !BARE_KEY.test(k))) return undefined;
  const kwargs = entries.map(([k, v]) => `:${k} ${renderJsonLiteral(v)}`).join(" ");
  return `(${qualifiedName} ${kwargs})`;
}

// ─── did-you-mean — simple prefix/edit-distance over the catalog (top 3) ───

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i, ...Array.from({ length: n }, () => 0)];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n]!;
}

// ─── normalizeSymbolName — the canonical-form primitive (naming conventions are a
// separate research thread per MEMORY; this is deliberately the ONE generalized
// normalizer so a future symbol-identity comparison reuses it rather than growing a
// second bespoke one) ───

/** Canonical form of an identifier: lowercase, with camelCase word-boundaries AND the
 *  three separators arrival-manifold's naming space actually uses — `-` (kebab-case),
 *  `_` (snake_case), `/` (namespace — also today's qualified-name join character) —
 *  all collapsed to the SAME token, so `searchNodes`, `search-nodes`, and `search_nodes`
 *  compare equal. A qualified `server/tool` name normalizes as ONE token too
 *  (`memory/search_nodes` → `memorysearchnodes`) — callers that want the bare tool part
 *  alone (ignoring a real server prefix) must strip it first (see {@link bareNameOf})
 *  before calling this.
 *
 *  Exported and deliberately generic — not `unboundInExprDoor`-private — so a future
 *  naming-convention research thread (or any other symbol-identity comparison across
 *  camelCase/kebab-case/snake_case/namespaced spellings) has one canonical-form rule to
 *  reuse instead of reinventing it. */
// Inputs are bounded internal symbol/tool names (never adversarial user text).
const CAMEL_ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;

export function normalizeSymbolName(s: string): string {
  return s
    .replaceAll(/[-_/]+/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(CAMEL_ACRONYM_BOUNDARY, "$1 $2")
    .toLowerCase()
    .replaceAll(/\s+/g, "");
}

/** Nearest bound names for an unknown tool: scored against each qualified name AND its
 *  bare tool-name part (so `search_files` finds `filesystem/search_files`, and an
 *  underscore-mangled `filesystem_search_files` lands one edit away), prefix matches
 *  score ahead of pure distance, top 3. The bare part is read off `tools` (bind.ts's
 *  structural (slug, tool) record) — reading the map is equivalent to splitting on the
 *  last `/` (unambiguous either way) but avoids the extra indirection. A `qualified`
 *  absent from `tools` (defensive — every real bound name has an entry) falls back to
 *  comparing the full string only. */
function nearestBoundNames(
  attempted: string,
  qualifiedNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  top = 3,
): string[] {
  const needle = attempted.toLowerCase();
  return qualifiedNames
    .map((qualified) => {
      const bare = tools.get(qualified)?.tool ?? qualified;
      const candidates = [qualified.toLowerCase(), bare.toLowerCase()];
      const distance = Math.min(...candidates.map((c) => editDistance(needle, c)));
      const prefix = candidates.some((c) => c.startsWith(needle) || needle.startsWith(c));
      return { qualified, score: prefix ? Math.min(distance, 1) : distance };
    })
    .toSorted((a, b) => a.score - b.score)
    .slice(0, top)
    .map((entry) => entry.qualified);
}

// ─── door generators — pure payload builders, no session state (Rule 4) ───

/** The caller invoked a BOUND tool's name as a standalone MCP tool. `qualifiedNames` are
 *  every binding that name resolves to (one, normally; several only when the same bare
 *  name exists on multiple slugged servers). The recovery script is the exact retry expr
 *  rendered from the caller's own args. */
export function bareToolCallDoor(
  attempted: string,
  args: Record<string, unknown> | undefined,
  qualifiedNames: readonly string[],
  toolNaming: ToolNaming,
): Door {
  const [qualified = attempted, ...rest] = qualifiedNames;
  const retry = renderRetryExpr(qualified, args);
  const alternates =
    rest.length > 0
      ? ` The same tool name is also bound as ${rest.join(", ")} — pick the server you mean the same way.`
      : "";
  // `retry === undefined` ⇒ a supplied argument KEY isn't a valid scheme keyword (a space /
  // punctuation / leading digit), so no faithful `:key value` call exists AND arrival's kwargs
  // runtime rejects a single dict argument too (see renderRetryExpr) — the argument is
  // structurally inexpressible. Teach the call SHAPE with keyword-safe names and NAME the offending
  // key(s), rather than interpolate a broken (or `undefined`) expr the model would copy verbatim.
  if (retry === undefined) {
    const bad = nonBareKwargKeys(args)
      .map((k) => `"${k}"`)
      .join(", ");
    return {
      code: "envelope/bare-tool-call",
      fact: `${attempted} is a symbol inside the ${toolNaming.toolName} tool's ${toolNaming.argName}, not a standalone tool.`,
      reason:
        `This server exposes ONE tool (${toolNaming.toolName}) so calls compose — a tool result can feed the ` +
        `next call inside the same program. Your argument key(s) ${bad} can't be written as a scheme ` +
        `keyword (:key), so this call can't be auto-translated.`,
      script:
        `Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = (${qualified} :key value …), using ` +
        `keyword-safe argument names.${alternates}`,
      terse: `bare tool call again — key(s) ${bad} aren't valid scheme keywords; call ${toolNaming.toolName} with (${qualified} :key value …).`,
    };
  }
  return {
    code: "envelope/bare-tool-call",
    fact: `${attempted} is a symbol inside the ${toolNaming.toolName} tool's ${toolNaming.argName}, not a standalone tool.`,
    reason:
      `This server exposes ONE tool (${toolNaming.toolName}) so calls compose — a tool result can feed ` +
      `the next call inside the same program.`,
    script: `Retry — call the ${toolNaming.toolName} tool with:\n  ${toolNaming.argName} = ${retry}${alternates}`,
    terse: `bare tool call again — wrap it: ${retry}`,
  };
}

/** THE AMBIGUOUS-BYPASS DOOR (bind.ts's env-side `BypassResolution`, "ambiguous" verdict):
 *  a direct (bypass) tool call whose bare name does NOT resolve to exactly one qualified
 *  tool — either because it ties across multiple bound tools (`candidates.length > 1`, the
 *  same bare/wire-form spelling shared by several servers) or because its canonical spelling
 *  ALSO names an existing GLOBAL scheme symbol unrelated to any tool (`candidates.length ===
 *  1`, `globalCollision` set — a builtin, an `s/*` validator, or any other bound name).
 *  Never guess across variance — always ask. Reuses
 *  {@link bareToolCallDoor}'s retry-expr rendering (it already lists "alternates" for a
 *  multi-candidate tie); the global-collision case appends one sentence naming the colliding
 *  symbol so the model understands why an exact-looking match still wasn't auto-applied. */
export function ambiguousBypassDoor(
  attempted: string,
  args: Record<string, unknown> | undefined,
  candidates: readonly string[],
  toolNaming: ToolNaming,
  globalCollision?: string,
): Door {
  const base = bareToolCallDoor(attempted, args, candidates, toolNaming);
  if (globalCollision === undefined) return base;
  const note =
    ` "${globalCollision}" is ALSO a bound top-level symbol in this environment, unrelated to any tool — ` +
    `auto-translation is skipped on any possible collision; use the explicit call above if you meant the tool.`;
  return {
    ...base,
    verbosityKey: "envelope/bare-tool-call#global-collision",
    reason: `${base.reason}${note}`,
    terse: `${base.terse}${note}`,
  };
}

/** The attempted name is bound nowhere — did-you-mean over the catalog. */
export function unknownToolDoor(
  attempted: string,
  qualifiedNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  toolNaming: ToolNaming,
): Door {
  const nearest = nearestBoundNames(attempted, qualifiedNames, tools);
  const menu = nearest.length > 0 ? `Did you mean: ${nearest.join(", ")}?\n  ` : "";
  const retryHead = nearest[0] ?? "server/tool-name";
  return {
    code: "envelope/unknown-tool",
    fact: `${attempted} is not a tool on this server, and no bound symbol has that name.`,
    reason:
      `This server exposes ONE tool (${toolNaming.toolName}); every operation is a symbol you call ` +
      `INSIDE its ${toolNaming.argName}, and the tool's description lists every bound symbol.`,
    script: `${menu}Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = (${retryHead} :key value ...).`,
    terse:
      nearest.length > 0
        ? `unknown tool ${attempted} again — nearest bound symbols: ${nearest.join(", ")}; call them inside the ${toolNaming.toolName} tool's ${toolNaming.argName}.`
        : `unknown tool ${attempted} again — the ${toolNaming.toolName} tool is the only tool here; put operations inside its ${toolNaming.argName}.`,
  };
}

// ─── envelope/unbound-in-expr — three-tier tool resolution for "Unbound variable `X'" ───
//
// The dominant error inside expressions is an unbound symbol. Most cases are tool names with
// wrong shape (prefix, separator, naming convention) or unquoted data literals.
//
// Design principle: never phrase a guess as a fact. Exact matches state the token directly;
// ambiguous cases offer menus.
//
// Resolution order:
// 1. Normalized bare-name match (exact canonical form after stripping server prefix).
// 2. Recognizable server<sep>tool split where the server head is real.
// 3. Fuzzy edit-distance / prefix over tool names (closeness-gated).
//
// Library symbols are left to arrival's own rich errors.

/** Bare name of a qualified `server/tool` symbol (`filesystem/search_files` → `search_files`).
 *  A "/" is a namespace separator ONLY with a non-empty part on BOTH sides — a name that
 *  literally ends in "/" or IS "/" is not namespaced, so the whole name is its own bare name
 *  (otherwise the empty tail would prefix-match everything). */
const bareNameOf = (qualified: string): string => {
  const i = qualified.lastIndexOf("/");
  return i <= 0 || i === qualified.length - 1 ? qualified : qualified.slice(i + 1);
};

/** Group qualified tool names by SERVER SLUG (the segment before the first `/`). A name with no
 *  `/` (a single-server empty-slug binding) has no server concept and never contributes here or
 *  to {@link detectServerToolSplit} — it can only ever be a tier-1/tier-3 hit. */
function groupToolsByServer(
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const qualified of qualifiedToolNames) {
    const slug = tools.get(qualified)?.slug;
    if (!slug) continue;
    const bucket = groups.get(slug);
    if (bucket) bucket.push(qualified);
    else groups.set(slug, [qualified]);
  }
  return groups;
}

/** Wrong-shape separators a model might reach for in place of the manifold's `/` — kebab-case's
 *  `-` is deliberately EXCLUDED (a legitimate word separator inside a bare tool name, not a
 *  namespace mistake, and folded into tier 1 via {@link normalizeSymbolName} instead). */
const WRONG_SEPARATORS = [".", ":", "_"] as const;

/** Find a `server<sep>tool` split of `attempted` whose HEAD names a real bound server — trying
 *  `/` alone when `attempted` contains one (the correct shape, just possibly a garbled tool
 *  part), else each wrong separator in turn, leftmost occurrence first. Returns the real slug
 *  (its bound casing) and the raw tool-part guess, or `undefined` when no split's head is a real
 *  server — the common case: no server prefix was attempted at all, or `attempted` is unrelated
 *  to any bound server. */
function detectServerToolSplit(
  attempted: string,
  serverGroups: ReadonlyMap<string, readonly string[]>,
): { server: string; toolGuess: string } | undefined {
  const bySlugLower = new Map([...serverGroups.keys()].map((slug) => [slug.toLowerCase(), slug] as const));
  const trySeparator = (sep: string): { server: string; toolGuess: string } | undefined => {
    let from = 0;
    for (;;) {
      const i = attempted.indexOf(sep, from);
      if (i <= 0 || i === attempted.length - 1) return undefined;
      const server = bySlugLower.get(attempted.slice(0, i).toLowerCase());
      if (server !== undefined) return { server, toolGuess: attempted.slice(i + 1) };
      from = i + 1;
    }
  };
  if (attempted.includes("/")) return trySeparator("/");
  for (const sep of WRONG_SEPARATORS) {
    const found = trySeparator(sep);
    if (found) return found;
  }
  return undefined;
}

/** TIER 1: every bound tool whose bare name canonicalizes equal to `attempted`'s bare part (a
 *  real `/` prefix on `attempted`, if any, is stripped first via {@link bareNameOf} — everything
 *  else about the string, including a garbled prefix, folds into the canonical form). */
function tier1Matches(
  attempted: string,
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
): string[] {
  const target = normalizeSymbolName(bareNameOf(attempted));
  return qualifiedToolNames.filter((tool) => normalizeSymbolName(tools.get(tool)?.tool ?? tool) === target);
}

/** A ≥3-char prefix relation either direction — hoisted out of {@link isCloseName} (no closure
 *  capture; pure over its own two args) so it is defined once per module instead of once per
 *  call. */
const prefixPair = (x: string, y: string): boolean => x.length >= 3 && y.startsWith(x);

/** The CLOSENESS gate applied at tier 3 (the fuzzy fallback): a candidate is a "nearest tool"
 *  only on an EXACT bare/full-name match, a ≥3-char prefix relation either direction, or a
 *  bare-name edit distance ≤ 1 (a single typo) — widened to ≤ 2 only for a LONG (≥8-char)
 *  attempt. The length gate is the precision knob against short-name false positives
 *  (`never`↔`every`), while realistic de-namespaced tool names are long (`search_files`,
 *  `directory_tree`) and their distance-2 garbles are safe to suggest. `nearestBoundNames`
 *  returns its top-N regardless of distance, so this filter is what keeps a genuinely-unknown
 *  symbol from drawing a wrong suggestion — it reuses the module's editDistance, it is not a
 *  second fuzzy matcher. `candidate`'s bare part is read off `tools` (never re-split — see
 *  bind.ts's module header). */
function isCloseName(attempted: string, candidate: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  const a = attempted.toLowerCase();
  const full = candidate.toLowerCase();
  const bare = (tools.get(candidate)?.tool ?? candidate).toLowerCase();
  if (a === bare || a === full) return true;
  if (prefixPair(a, bare) || prefixPair(bare, a) || prefixPair(a, full) || prefixPair(full, a)) return true;
  const distance = editDistance(a, bare);
  return distance <= 1 || (distance <= 2 && a.length >= 8);
}

/** The EXPLICIT-hint confidence bar (module header's central design principle): exact match, or
 *  a bare/full-name edit distance of 1 — a single-character typo, transposition, or one-off
 *  insertion/deletion. Deliberately NARROWER than {@link isCloseName}'s list-gate (no prefix
 *  relation, no widened distance-2-for-long-strings): a prefix or distance-2 relation is a
 *  plausible GUESS, not a certainty. Shared by the tier-3 promotion (a single tight candidate in
 *  the closeness-gated set becomes the explicit door) and the library-typo hint (step 4).
 *  `candidate`'s bare part is read off `tools` (never re-split). */
function isTightMatch(attempted: string, candidate: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  const a = attempted.toLowerCase();
  const bare = (tools.get(candidate)?.tool ?? candidate).toLowerCase();
  const full = candidate.toLowerCase();
  if (a === bare || a === full) return true;
  return editDistance(a, bare) <= 1 || editDistance(a, full) <= 1;
}

/** KEY-level tight match (`isTightMatch` applied one level down, to a sub-schema's KEYS instead
 *  of tool names): canonical-form equality, or an edit distance of 1 between canonical forms (a
 *  single typo / one-off insertion-deletion — a `terms`→`term` rename is exactly one edit).
 *  Deliberately as narrow as the tool-name
 *  gate: a distance-2 key is a plausible GUESS, and the key-rename clause renders as an
 *  explicit fact ("the key you want is :term."), so only certainty qualifies. */
export function isTightKeyMatch(attempted: string, candidate: string): boolean {
  const a = normalizeSymbolName(attempted);
  const c = normalizeSymbolName(candidate);
  return a === c || editDistance(a, c) <= 1;
}

/** Data-literal shape classifier: `"null"` (its own nil/omit teaching), `"general"` (a value
 *  that should have been quoted), or `undefined` (no literal shape — leave the wall untouched
 *  rather than teach something false, the task's rule 4). */
function classifyLiteral(x: string): "null" | "general" | undefined {
  if (/^null$/i.test(x)) return "null";
  if (/^(?:true|false)$/i.test(x)) return "general"; // JSON booleans
  if (/^\d{4}-\d{2}-\d{2}/.test(x)) return "general"; // ISO date
  if (/^[+-]?\d[\d.,:]*[a-z%]*$/i.test(x)) return "general"; // a number with stray chars
  if (/^[A-Z][A-Z0-9_]+$/.test(x)) return "general"; // ALL-CAPS enum/const token
  if (/\w\.\w/.test(x)) return "general"; // dotted — domain / filename
  // Markdown *starred phrase* (has a space). Not Scheme earmuffs (*features*).
  if (x.length > 2 && x.startsWith("*") && x.endsWith("*") && x.slice(1, -1).includes(" ")) {
    return "general";
  }
  return undefined;
}

/** The quoting hint for a data-literal-shaped symbol. `null` gets the arrival-specific nil/omit
 *  teaching; everything else is told to quote (or keyword it, where a parameter name is meant). */
function quotingHint(x: string, kind: "null" | "general"): string {
  if (kind === "null") {
    return "JSON null is spelled '() (empty/nil) here; in tool arguments simply OMIT the optional parameter instead of passing null.";
  }
  return `${x} looks like a data value, not a symbol — write it as the string "${x}" (or keyword :${x} where a parameter name is meant).`;
}

/** True iff `qualifiedName` was bound under a non-empty server slug — read off `tools`
 *  (bind.ts's structural (slug, tool) record), NEVER by inspecting the qualified string itself
 *  (a `.includes("_")`-style check would be worthless: most bare tool names contain an
 *  underscore of their own, slug or not — see bind.ts's module header). A name absent from
 *  `tools` (defensive — every real bound name has an entry) is treated as NOT namespaced —
 *  the safe default (never phrase a guess as a fact, the module's central design principle). */
function isNamespaced(qualifiedName: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  return (tools.get(qualifiedName)?.slug ?? "") !== "";
}

/** Synthesize a full working example call for a resolved tool from its JSON Schema.
 * Falls back to a bare `(name)` when no schema is available. */
function renderExampleCall(
  qualifiedName: string,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): string {
  return synthesizeExampleCall(qualifiedName, toolSchemas.get(qualifiedName));
}

/** Several candidates' example calls, in the SAME order as the names they're offered alongside —
 *  used by the tie/fuzzy doors below, where the model must pick ONE of several plausible tools. */
function renderExampleCalls(
  qualifiedNames: readonly string[],
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): string {
  return qualifiedNames.map((name) => renderExampleCall(name, toolSchemas)).join("; ");
}

/** THE EXPLICIT TOOL DOOR — a single tool resolves with CERTAINTY (an exact canonical-form
 *  match from step 1/2, or the single tight edit-distance-≤1 candidate promoted at step 3):
 *  state the exact qualified token as FACT, not a question, so the model can copy it verbatim
 *  instead of picking from a menu — the central design principle (module header). The prefix
 *  teaching is only truthful when the token is actually namespaced ({@link isNamespaced}); a
 *  slug-less bare binding gets the plain fact with no prefix note. `literal` rides along as the
 *  second line on the combined case (unchanged, orthogonal concern). A full working call example
 *  (the example-call teaching above) rides on BOTH `fact` (verbose) and `terse` (repeat
 *  occurrences already fold their OWN actionable payload into `terse` elsewhere in this module —
 *  see `bareToolCallDoor`'s retry expr — so this door matches that convention). */
function explicitToolDoor(
  qualifiedName: string,
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
  toolNaming: ToolNaming,
): Door {
  const teach = isNamespaced(qualifiedName, tools)
    ? ` Tool symbols keep their full server/tool-name form inside ${toolNaming.argName}.`
    : "";
  const example = renderExampleCall(qualifiedName, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#explicit",
    fact: `There's no such symbol — the symbol you want is \`${qualifiedName}\`.${teach} For example: ${example}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `the symbol you want is \`${qualifiedName}\` — e.g. ${example}.`,
  };
}

/** TIER 1's TIE door (also reached via a tier-2 split that resolves to SEVERAL real tools,
 *  doors.ts § "RIGHT SERVER, WRONG TOOL"): several matches is a genuine tie, not a certainty —
 *  the did-you-mean list stands (a single match is the {@link explicitToolDoor} fact instead).
 *  The prefix teaching is only truthful when the matches are actually namespaced
 *  ({@link isNamespaced}); a slug-less bare binding gets a plain did-you-mean. `literal` rides
 *  along as the second line on the combined case. Every candidate's example call renders too
 *  (the example-call teaching above), framed as a pick-one choice — never a bare name-only
 *  menu the model must re-derive a call shape from. */
function tier1Door(
  matches: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
  toolNaming: ToolNaming,
): Door {
  const namespaced = matches.some((m) => isNamespaced(m, tools));
  const teach = namespaced ? ` Tool symbols keep their full server/tool-name form inside ${toolNaming.argName}.` : "";
  const examples = renderExampleCalls(matches, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#tie",
    fact: `There's no such symbol — did you mean: ${matches.join(", ")}?${teach} Pick the one you mean — for example: ${examples}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `did you mean: ${matches.join(", ")}? e.g. ${examples}`,
  };
}

/** TIER 2's door: the server part was real but no tool on it matched — list every tool bound on
 *  that server (bare names, read off `tools` — the form the model actually calls them by
 *  inside a namespaced symbol) so the model sees the whole menu instead of guessing blind a
 *  second time. Deliberately NOT upgraded with the example-call teaching (unlike
 *  {@link explicitToolDoor}/{@link tier1Door}/{@link tier3Door} below): this is a discovery
 *  menu over a whole server's toolset (zero of them matched the guess), not a set of candidates
 *  that DID match — rendering one example per listed tool here risks a response that scales
 *  with server size rather than with actual ambiguity. */
function tier2Door(
  server: string,
  toolGuess: string,
  toolsOnServer: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
): Door {
  const bareTools = toolsOnServer.map((t) => tools.get(t)?.tool ?? t).join(", ");
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#server-menu",
    fact: `server \`${server}\` has no tool \`${toolGuess}\` — its tools are: ${bareTools}.`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `server \`${server}\` has no tool \`${toolGuess}\` — its tools: ${bareTools}.`,
  };
}

/** TIER 3's fuzzy-fallback candidate count — widened from the old did-you-mean's 3 toward ~10
 *  (still `isCloseName`-gated, so the wider net doesn't admit distant junk). */
const TIER3_TOP = 10;

/** TIER 3's door: nothing normalized or split cleanly — the closeness-gated fuzzy fallback,
 *  drawn only from tool names (never general library syntax, per the door's narrowed job).
 *  Every candidate's example call renders too (the example-call teaching above), same pick-one
 *  framing as {@link tier1Door}'s tie. */
function tier3Door(
  nearest: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): Door {
  const examples = renderExampleCalls(nearest, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#fuzzy",
    fact: `There's no such symbol — nearest tools: ${nearest.join(", ")}. Pick the one you mean — for example: ${examples}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `nearest tools: ${nearest.join(", ")}. e.g. ${examples}`,
  };
}

/** Build the enrichment door for an in-expr "Unbound variable `X'" — the three-tier tool
 *  resolution (see the section header above). Returns `undefined` when nothing matches and no
 *  data-literal shape is found either — the caller then leaves arrival's wall untouched (a plain
 *  typo'd variable teaching nothing false beats a wrong guess; a typo of a well-known LIBRARY
 *  symbol is arrival's own `polyglot-rich-errors` capability's job, already riding inside the
 *  frozen first line by the time this door runs). `qualifiedToolNames` is the manifold's tool
 *  inventory (manifold-tool.ts threads `signatureByName`'s keys). When the attempted symbol ALSO
 *  looks like a data literal, the quoting hint rides along as a second line regardless of which
 *  step (or none) fired.
 *
 *  This door renders INLINE (DoorSession.enrichInline): `fact` is the primary teaching line,
 *  `reason` the optional second line, `terse` the repeat-occurrence one-liner. `script` is unused
 *  (the door never routes through the standalone `Error: fact / Why / script` render). */
export function unboundInExprDoor(
  attempted: string,
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  toolNaming: ToolNaming,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined> = new Map(),
  /** STEP 3's fuzzy-fallback candidate count — the calibration seam (calibration.ts's
   *  `doorsTier3Top`): a re-tune is an injected option, never a code fork. Defaults to
   *  {@link TIER3_TOP} — today's value, unchanged for every caller that doesn't pass one. */
  tier3Top: number = TIER3_TOP,
): Door | undefined {
  const literal = classifyLiteral(attempted);

  // STEP 1 — normalized bare-name match, no server prefix assumed. Exactly one match is
  // certain (an exact canonical-form equality) → the explicit fact; several is a genuine tie.
  const direct = tier1Matches(attempted, qualifiedToolNames, tools);
  if (direct.length === 1) return explicitToolDoor(direct[0]!, literal, attempted, tools, toolSchemas, toolNaming);
  if (direct.length > 1) return tier1Door(direct, literal, attempted, tools, toolSchemas, toolNaming);

  // STEP 2 — a recognizable `server<sep>tool` split whose head is a REAL bound server. A
  // SINGLE tool match on that server is really a step-1 hit reached via the split (explicit);
  // several ties the same way step 1 does; no match is the server's tool menu.
  const serverGroups = groupToolsByServer(qualifiedToolNames, tools);
  const split = detectServerToolSplit(attempted, serverGroups);
  if (split) {
    const toolsOnServer = serverGroups.get(split.server)!;
    const normalizedGuess = normalizeSymbolName(split.toolGuess);
    const matches = toolsOnServer.filter((t) => normalizeSymbolName(tools.get(t)?.tool ?? t) === normalizedGuess);
    if (matches.length === 1) return explicitToolDoor(matches[0]!, literal, attempted, tools, toolSchemas, toolNaming);
    if (matches.length > 1) return tier1Door(matches, literal, attempted, tools, toolSchemas, toolNaming);
    return tier2Door(split.server, split.toolGuess, toolsOnServer, literal, attempted, tools);
  }

  // STEP 3 — fuzzy fallback, drawn only from tool names, closeness-gated (short attempts are
  // never fuzzy-matched — too many false positives against even a handful of tool names). A
  // single TIGHT candidate inside that gated set is still a certainty (an edit-distance-1
  // typo) → promoted to the explicit fact; a genuinely ambiguous or loose-only set is the guess
  // list.
  if (attempted.length >= 2) {
    const nearest = nearestBoundNames(attempted, qualifiedToolNames, tools, tier3Top).filter((c) =>
      isCloseName(attempted, c, tools),
    );
    const tight = nearest.filter((c) => isTightMatch(attempted, c, tools));
    if (tight.length === 1) return explicitToolDoor(tight[0]!, literal, attempted, tools, toolSchemas, toolNaming);
    if (nearest.length > 0) return tier3Door(nearest, literal, attempted, toolSchemas);
  }

  // Nothing matched — the data-literal shape, if any, is the only remaining signal.
  if (literal === undefined) return undefined;
  const hint = quotingHint(attempted, literal);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#quote-literal",
    fact: hint,
    reason: "",
    script: "",
    terse: hint,
  };
}

// ─── envelope/import-form — module system misfire ───
//
// Some models assume a R7RS-style module system and emit `(import (scheme base))` (or the bare
// `(scheme base)` after stripping). Neither symbol is bound here.
//
// This is a narrow exact-match sibling to the other unbound classifiers. It runs after tool
// resolution and before scope confusion.

/** Heads produced by the common malformed import form. */
const IMPORT_FORM_HEADS = new Set(["import", "scheme"]);

export function importDoor(attempted: string): Door | undefined {
  if (!IMPORT_FORM_HEADS.has(attempted)) return undefined;
  const fact =
    "There's no `(import ...)` or `(scheme ...)` module form here — `import` was deliberately " +
    "removed from this language and there's no module system to invoke. The standard library is " +
    "already fully bound into this REPL's scope, so nothing needs importing. Drop that form and " +
    "resend the rest of the program unchanged.";
  return {
    code: "envelope/import-form",
    fact,
    reason: "",
    script: "",
    terse:
      "no `(import ...)`/`(scheme ...)` form here — the standard library is already in scope; " +
      "drop it and resend the rest of the program unchanged.",
  };
}

// ─── envelope/scope-confusion — names the model itself defined but are now unbound ───
//
// Three disjoint cases (checked in priority order):
// - Cascade: the name had a top-level define earlier in *this* program, but an earlier
//   statement failed so the define never ran.
// - Repeated local: the name has been bound locally (let/lambda/...) two or more times in the
//   session — the model has a consistent local-binding style.
// - Cross-scope: the name was bound locally exactly once (in a previous message or earlier
//   in this one) and is now referenced outside that scope.
//
// Facts are supplied by the caller; this function only classifies.

/** Build the scope-confusion door's CASCADE case: X has a top-level define attempt earlier in
 *  this SAME program, but it never bound because an earlier statement failed first. Points at
 *  the ROOT (the first failing statement), never the symptom. */
function cascadeScopeDoor(name: string, firstErrorStatementNumber: number): Door {
  const fact =
    `\`${name}' was defined above in this program, but an earlier statement failed, so its ` +
    `(define) never ran — every statement after the first error is skipped. Fix the FIRST ` +
    `error (see the error at statement ${firstErrorStatementNumber}) and the rest will bind.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#cascade",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' never bound — statement ${firstErrorStatementNumber} failed first; fix that and the rest will bind.`,
  };
}

/** Build the scope-confusion door's CROSS-SCOPE case: X was only ever locally bound (a
 *  let/lambda body or a nested define), never at top level — a local binding's lifetime is its
 *  enclosing form, so it never persisted to begin with. */
function crossScopeDoor(name: string, messagesAgo: number): Door {
  const when =
    messagesAgo <= 0 ? "earlier in this message" : `${messagesAgo} message${messagesAgo === 1 ? "" : "s"} ago`;
  const fact =
    `\`${name}' was defined inside a local scope (a let/lambda body) ${when}, not globally — a ` +
    `local binding doesn't survive its form. Re-declare it at top level with (define ${name} …), ` +
    `or bind it locally with (let ((${name} …)) …) in the statement that uses it.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#cross-scope",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' was only ever locally bound (${when}) — re-declare it at top level or bind it locally where you use it.`,
  };
}

/** Build the scope-confusion door's ≥2-LOCAL special case (V's flag, spec header): X has been
 *  locally bound this way twice or more — a consistent style, not a one-off. Acknowledges both
 *  paths without prescribing one (never push a model with a working local-binding style toward
 *  global `(define)`). */
function repeatedLocalScopeDoor(name: string): Door {
  const fact =
    `\`${name}' is a local binding you've used before — it doesn't persist across statements. ` +
    `Either bind it in the same statement that uses it, or (define ${name} …) it at top level ` +
    `to reuse it across calls.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#repeated-local",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' is a local binding again — bind it in the statement that uses it, or (define ${name} …) at top level.`,
  };
}

/** THE SCOPE-CONFUSION CLASSIFIER — the LAST branch of the unbound-in-expr enrichment chain
 *  (manifold-tool.ts: tool-name (unboundInExprDoor's three tiers) → library-symbol (arrival's
 *  own polyglot-rich-errors, already riding in the raw message) → data-literal (also
 *  unboundInExprDoor) → THIS → bare fallthrough). Priority mirrors the spec's (a)/(b)/(c)/(d): a
 *  same-program cascade explanation wins over a cross-scope one (a name that ALSO happens to
 *  have local-binding history is still, first and foremost, explained by the failure in front of
 *  the model right now); ≥2 local occurrences win over exactly one (the "don't force a style"
 *  case is strictly more specific); zero of either ⇒ undefined (case (d), not this door's job). */
export interface ScopeConfusionInput {
  /** The unbound name. */
  name: string;
  /** 1-based index of an earlier top-level `(define name ...)` in *this* program, if any. */
  topLevelDefineStatementNumber?: number;
  /** 1-based index of the first errored statement in this program. */
  firstErrorStatementNumber: number;
  /** Call indices (oldest to newest) where this name was seen as a local binding. */
  localBindingCallIndexes: readonly number[];
  /** The current call index. */
  currentCallIndex: number;
}

export function scopeConfusionDoor(input: ScopeConfusionInput): Door | undefined {
  if (input.topLevelDefineStatementNumber !== undefined) {
    return cascadeScopeDoor(input.name, input.firstErrorStatementNumber);
  }
  if (input.localBindingCallIndexes.length >= 2) {
    return repeatedLocalScopeDoor(input.name);
  }
  if (input.localBindingCallIndexes.length === 1) {
    return crossScopeDoor(input.name, input.currentCallIndex - input.localBindingCallIndexes[0]!);
  }
  return undefined;
}

// ─── envelope/signature-echo — echo tool contract on misuse errors ───
//
// When an error indicates argument shape / keyword / type misuse for a tool (and exactly one
// tool is implicated), echo the tool's one-line signature below the error.
//
// This only fires for call-shape problems, not domain execution errors or unbound names.

/** Regexes that indicate a *call shape* problem (wrong args/keywords/types) rather than
 * a successful tool execution that then failed on domain grounds. */
const TOOL_MISUSE_SHAPES: readonly RegExp[] = [
  /kwargs call has /, // dangling keyword / arity at the kwargs boundary
  /^s\/(?:number|integer|string|boolean|object|array): expected /, // s/* type-assertion failure
  /\binvalid arguments\b/i, // upstream JSON-Schema/zod argument rejection
  /\brequired propert(?:y|ies)\b/i, // JSON-Schema "must have required property"
  /\bInput validation error\b/i, // the TS MCP SDK's downstream tool-input-rejection wrapper
  // OUR OWN kwargs-decode rejection (arrival common/kwargs-rejection.ts's frozen grammar,
  // design doc §2.5) — `<qualified>: arguments rejected — N problem(s):`, INCLUDING the
  // headless variant `arguments rejected — …` that a genuinely ANONYMOUS def degrades to
  // (kwargs-rejection.ts's own contract; manifold tool defs carry real names since the
  // NAME_DOC_TEMPLATE fix, but the grammar keeps both forms).
  /(?:^|: )arguments rejected — \d+ problem\(s\):/,
];

/** True iff an error message is an argument/validation/kwarg/arity failure (see the shape list). */
export function isToolMisuseError(message: string): boolean {
  return TOOL_MISUSE_SHAPES.some((re) => re.test(message));
}

/** Whole scheme-symbol tokens in a source string. The charset recovers a `slug/tool-name`
 *  qualified symbol as ONE token, so exact set-membership against the bound names is a
 *  longest-match by construction — `toy/add` tokenizes whole, never as a bare `add`. */
const SYMBOL_TOKEN = /\w[\w./-]*/g;
const tokensOf = (source: string): Set<string> => new Set(source.match(SYMBOL_TOKEN));

/** Pick the ONE bound tool a failing statement implicates, or undefined when the choice is
 *  ambiguous (no false teaching). Candidates = bound tool names appearing as whole symbols in the
 *  statement source. Exactly one candidate ⇒ it. Several ⇒ only the one whose qualified OR bare
 *  name (read off `tools`, never re-split) the error message uniquely names; otherwise
 *  undefined (the task's "names neither → skip"). Zero candidates ⇒ undefined (e.g. a bare
 *  `(s/number "x")` — the validator is not a tool). */
export function implicatedTool(
  statement: string,
  message: string,
  boundToolNames: Iterable<string>,
  tools: ReadonlyMap<string, BoundTool>,
): string | undefined {
  const stmtTokens = tokensOf(statement);
  const candidates = [...boundToolNames].filter((name) => stmtTokens.has(name));
  if (candidates.length <= 1) return candidates[0];
  const msgTokens = tokensOf(message);
  const named = candidates.filter((name) => msgTokens.has(name) || msgTokens.has(tools.get(name)?.tool ?? name));
  return named.length === 1 ? named[0] : undefined;
}

/** The signature-echo decision for one failed statement: the implicated tool + its signature, or
 *  undefined when the error is not a misuse shape, no single tool is implicated, or that tool has
 *  no signature. The caller (manifold-tool.ts) appends `\nSignature: <signatureText>` and routes
 *  the telemetry line through DoorSession.echoSignature. */
export function signatureEchoFor(
  statement: string,
  message: string,
  signatureByName: ReadonlyMap<string, string>,
  tools: ReadonlyMap<string, BoundTool>,
  /** The misuse-shape gate — the strategy seam (strategies.ts's `IsMisuseErrorStrategy`): a
   *  positional-tuple consumer (arrival-mcp) matches a different error-message family. Defaults
   *  to {@link isToolMisuseError} — today's kwargs-world shapes, unchanged for every caller that
   *  doesn't pass an override. */
  isMisuseError: (message: string) => boolean = isToolMisuseError,
): { tool: string; signatureText: string } | undefined {
  if (!isMisuseError(message)) return undefined;
  const tool = implicatedTool(statement, message, signatureByName.keys(), tools);
  if (tool === undefined) return undefined;
  const signatureText = signatureByName.get(tool);
  return signatureText === undefined ? undefined : { tool, signatureText };
}

/** Inner tool-call quota on scheme_repl / scheme_watch. Recovery is raise `maxInternalCalls`. */
export function internalCallBudgetDoor(limit: number, toolName: string): Door {
  const arg = "maxInternalCalls";
  const fact = `internal tool-call budget exceeded (quota ${limit}) — raise the '${arg}' tool argument`;
  return {
    code: "envelope/call-budget",
    fact,
    reason: `This ${toolName} call allows ${limit} inner tool calls. The program needed another call.`,
    script: `Retry — call ${toolName} again with ${arg} set higher than ${limit}.`,
    terse: fact,
  };
}

/** Arrival's reader message when `{…}` never closed. The JSON tool-call sampler
 *  (xAI implicit-strict grammar) can cut `expr` at `{`; this host cannot recover the tail. */
export const UNTERMINATED_DICT_LITERAL = "unterminated dict literal '{'";

export function isUnterminatedDictLiteral(message: string): boolean {
  return message.includes(UNTERMINATED_DICT_LITERAL);
}

/** Parse of `{key: value …}` stopped mid-dict. Retry without commas — they are optional. */
export function unterminatedDictDoor(): Door {
  const fact = `${UNTERMINATED_DICT_LITERAL} — the host received a dict that never closed and cannot reconstruct the missing tail.`;
  return {
    code: "envelope/unterminated-dict",
    fact,
    reason:
      "The JSON tool-call sampler can cut expr at `{` when a dict uses commas (`{offset: 1, limit: 50}`), " +
      "treating the brace as JSON. The call you authored was likely complete. Commas in `{key: value}` are optional.",
    script:
      "Retry the same form with spaces instead of commas: `{offset: 90 limit: 40}`, not `{offset: 90, limit: 40}`.",
    terse: `${UNTERMINATED_DICT_LITERAL} — retry the dict without commas ({offset: 90 limit: 40}).`,
  };
}

/** A manifold call whose expr is empty/whitespace-only — zero top-level forms. The terse
 *  line IS the previously-frozen contract string, so single-line consumers keep matching. */
export function emptyExprDoor(toolNaming: ToolNaming): Door {
  return {
    code: "envelope/empty-expr",
    fact: `${toolNaming.argName} is empty — provide at least one Scheme expression.`,
    reason:
      "An empty program has zero top-level forms: evaluation would return nothing and read " +
      "as a silent success, which is worse than this error.",
    script:
      `Retry — call the ${toolNaming.toolName} tool with at least one form in ${toolNaming.argName}, e.g. ` +
      "(server/tool-name :key value); the tool description lists every bound symbol.",
    terse: `${toolNaming.argName} is empty — provide at least one Scheme expression.`,
  };
}

/** A call whose program argument is missing, or is neither a string nor an array of strings. */
export function invalidArgsDoor(program: unknown, toolNaming: ToolNaming): Door {
  const got =
    program === undefined ? `nothing (the ${toolNaming.argName} argument is missing)` : `${typeNameOf(program)}`;
  return {
    code: "envelope/invalid-args",
    fact: `${toolNaming.argName} must be a string of Scheme source, or an array of such strings — got ${got}.`,
    reason: `The ${toolNaming.toolName} tool takes {${toolNaming.argName}: string | string[]}; every operation is written inside it.`,
    script: `Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = "(server/tool-name :key value)".`,
    terse: `${toolNaming.argName} must be a string or array of strings — got ${got}.`,
  };
}

function typeNameOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ─── the futility doors — the ONLY doors on a successful call (futility.ts) ───
// Shape-based, semantics-free: the FutilityTracker watches per-tool result hashes and, when a
// tool stops moving the model forward, queues one of these. They render via DoorSession.renderNote
// as `Note:` blocks appended to the manifold call's output — the tool RESULT itself is never
// touched (it already flowed into scheme dataflow); the note is pure advice to stop retrying.

/** TRIGGER 1 — a tool's last 3 calls returned effectively the same result despite ≥2 distinct
 *  argument sets: the tool MAY be insensitive to input (degraded / rate-limited / bot-walled) —
 *  or it may be truthfully, repeatedly answering "nothing here" (measured: ~60% of real firings
 *  were exactly this — a working tool returning a legitimate empty result, e.g. met-museum's
 *  "No objects found", an empty memory search).
 *
 *  C2/B2 (experimental/arrival/packages/arrival-bench/docs/benchmark-defect-register.md §C +
 *  ADDENDUM): report the FACT, frame the interpretation CONDITIONALLY, prescribe NOTHING.
 *  Asserting degradation as fact and scripting "give your best final answer" is the rejected
 *  alternative — an outcome-fine-tuning imperative that pushes models to abandon a recoverable
 *  search and confabulate (one observed trajectory: the model proposed the WINNING query and this
 *  door vetoed it). Never ship a diagnosis this door cannot actually know. */
export function futileRetryDoor(qualifiedName: string): Door {
  return {
    code: "envelope/futile-retry",
    fact: `the last 3 calls to ${qualifiedName} returned the same result despite different arguments`,
    reason:
      "if that is not the result you expected, the tool may be degraded — retrying it unchanged is unlikely to help. " +
      "If it IS a real (e.g. empty) answer, the tool is working and the arguments are what need to change.",
    script: `either change the arguments to ${qualifiedName} materially, or take a different route.`,
    terse: `${qualifiedName} is still returning the same result — if that's not what you expected, change the arguments materially or take a different route.`,
  };
}

/** TRIGGER 2 — the same tool was called twice in a row with the same arguments AND got the same
 *  result: a pure repeat that adds nothing the model does not already have above. */
export function duplicateCallDoor(qualifiedName: string): Door {
  return {
    code: "envelope/duplicate-call",
    fact: `you already have this exact ${qualifiedName} result above — do not re-run identical calls; use the earlier result.`,
    reason: "",
    script: "",
    terse: `duplicate ${qualifiedName} call — use the earlier result above instead of re-running it.`,
  };
}

// ─── the output layer — per-session verbosity gate + follow-rate telemetry ───

/** Session = the manifold server process lifetime. Holds the ONE per-session seen-set
 *  (Rule 4's verbosity gate, keyed per lesson SHAPE via `door.verbosityKey ?? door.code` — a
 *  render concern, deliberately outside the door generators) and the follow-rate ledger (Rule
 *  5). One instance per built server; it survives tools/listChanged rebuilds. */
export class DoorSession {
  /** Lesson SHAPES already introduced this session (keyed by `door.verbosityKey ?? door.code`
   *  — finer than DoorCode, so distinct shapes sharing one code each keep their own slot). */
  private readonly seen = new Set<string>();
  /** Values are DoorCodes in-flight, but the type is `string` deliberately: on session
   *  restore a blob written by an older release can carry a code this version no longer
   *  emits, and that is harmless — the value is only ever logged verbatim
   *  (`observeSuccess`'s `{"door-followed": code}`), never matched against the current
   *  door set. Typing it `DoorCode` would force the blob parser to either reject old
   *  blobs on every door rename or assert the value into place. */
  private readonly pendingFollow = new Map<string, string>();
  private seq = 0;

  constructor(private readonly log: (line: string) => void = (line) => console.error(line)) {}

  /** Render a door for output: logs the telemetry line, arms follow-tracking for the
   *  name-level doors, and picks verbose (first occurrence of this lesson SHAPE this session,
   *  keyed `verbosityKey ?? code`) or terse (every later one). Always returns the frozen
   *  `Error: ...` contract shape. */
  render(door: Door, tool: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool }));
    if (door.code === "envelope/bare-tool-call" || door.code === "envelope/unknown-tool") {
      this.pendingFollow.set(tool, door.code);
    }
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    return verbose ? `Error: ${door.fact}\n  Why: ${door.reason}\n  ${door.script}` : `Error: ${door.terse}`;
  }

  /** Render a NON-ERROR advisory door (the futility doors) for output. Identical machinery to
   *  {@link render} — same telemetry line, same per-session verbosity gate (verbose on a lesson
   *  SHAPE's first occurrence, terse after) — with ONE deliberate difference: the prefix is `Note: `, not
   *  `Error: `. The manifold call SUCCEEDED (the tool result is valid and already in the output
   *  blocks); a futility door is advice, not a rejection, so it must not read as an error to a
   *  caller matching the frozen `Error: ` contract. `reason`/`script` are optional here (the
   *  duplicate-call door carries neither) — a Why/script line is emitted only when non-empty, so
   *  the note never renders a dangling `Why:` with nothing after it. */
  renderNote(door: Door, tool: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool }));
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    if (!verbose) return `Note: ${door.terse}`;
    const why = door.reason ? `\n  Why: ${door.reason}` : "";
    const script = door.script ? `\n  ${door.script}` : "";
    return `Note: ${door.fact}${why}${script}`;
  }

  /** Inline enrichment of an in-expr error (envelope/unbound-in-expr): the caller has ALREADY
   *  emitted the frozen `Error: Unbound variable `X'` first line — this returns ONLY the indented
   *  teaching suffix to append below it, so the H-4 first-line contract is preserved by
   *  construction. Verbosity rides the same per-session gate as render() (Rule 4): the lesson
   *  SHAPE's first occurrence gets the full teaching (fact + optional second line), later ones the terse
   *  one-liner. Telemetry is logged (Rule 6); follow-tracking is NOT armed — the attempted symbol
   *  X still appears in the same failing expr, so `observeSuccess(expr)` on a partial-success call
   *  would false-positive on it. */
  enrichInline(door: Door, attempted: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool: attempted }));
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    if (verbose) return door.reason ? `\n  ${door.fact}\n  ${door.reason}` : `\n  ${door.fact}`;
    return `\n  ${door.terse}`;
  }

  /** SIGNATURE-ECHO render + telemetry (mirrors {@link enrichInline}'s logging): emits one
   *  `{door, seq, tool}` stderr line under the new `envelope/signature-echo` code and returns the
   *  suffix to append below a preserved tool-misuse error's first line. NO verbosity gate — the
   *  signature IS the teaching and has no terser form, so re-showing it on each misuse of the same
   *  tool is the intent (the model still has the wrong contract until it stops). The frozen first
   *  line (H-4) is preserved by the caller; this only ever adds a line below it.
   *
   *  `example` is a synthesized working call (example-call.ts) for the
   *  SAME tool, APPENDED as its own `Example: ` line below `Signature: ` — never replacing it.
   *  Optional so a caller with no schema map (or omitting it entirely) keeps today's
   *  Signature-only shape byte-for-byte. */
  echoSignature(tool: string, signatureText: string, example?: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: "envelope/signature-echo", seq: this.seq, tool }));
    const exampleLine = example === undefined ? "" : `\nExample: ${example}`;
    return `\nSignature: ${signatureText}${exampleLine}`;
  }

  /** ARGS-MISUSE TEACHING render + telemetry (design doc §2.4 — echoSignature's sibling,
   *  same log-and-return-suffix shape): emits one `{door, seq, tool, param, level}` stderr line
   *  under `envelope/args-misuse` and returns `body` (the pre-rendered L1/L2/L3 teaching lines,
   *  built by args-misuse-door.ts) to append below the preserved verbatim first line. `param` is
   *  the dotted failing-param path (`"⊥"` for the unlocalized backstop); `level` is the
   *  tracker's escalation rung — benches measure retries-per-level directly off this line
   *  (follow-rate discipline, Rule 5). NO verbose/terse gate: escalation REPLACES the monotonic
   *  verbosity gradient (the signature-echo precedent — repetition here earns MORE teaching,
   *  and the ArgsFailureTracker owns that state, never the session's `seen` set). */
  appendArgsTeaching(tool: string, param: string, level: number, body: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: "envelope/args-misuse", seq: this.seq, tool, param, level }));
    return body;
  }

  /** BYPASS AUTO-EXEC telemetry (mirrors {@link echoSignature}'s logging-without-rejection
   *  shape): logs one `{door, seq, tool, resolvedTo}` stderr line under
   *  `envelope/bypass-autoexec` when a direct (bypass) call was translated and executed
   *  instead of taught. `tool` is the ATTEMPTED name (what a "bypass attempts" consumer
   *  already counts via envelope/bare-tool-call/envelope/unknown-tool); `resolvedTo` is the
   *  qualified tool it ran as. No verbosity gate — this is a distinct per-call measurement,
   *  not a repeated concept intro. Returns nothing to render: the call's own result (success
   *  or failure) travels untouched; only the caller's one advisory line is added around it. */
  logBypassAutoExec(attempted: string, resolvedTo: string): void {
    this.seq += 1;
    this.log(JSON.stringify({ door: "envelope/bypass-autoexec", seq: this.seq, tool: attempted, resolvedTo }));
  }

  /** TYPE-HINT telemetry (doc §3/G7): every lens outcome logs exactly one structured line
   *  under the `envelope/type-hint` door. Mirrors the other stderr telemetry sinks — the
   *  manifold's benches parse these lines; no verbosity gate applies (each is a distinct
   *  measurement of one lens run, not a repeated concept intro). The caller (deliver.ts) owns
   *  the event shape; this is the ONE seam onto the session's private log sink. */
  logTypeHint(event: TypeHintTelemetry): void {
    this.log(JSON.stringify(event));
  }

  /** Self-observed "followed" (Rule 5): a successful manifold call whose expr contains a
   *  door'ed tool name means the caller routed through the door. "Followed" = the retry
   *  RAN successfully — mere acknowledgment never logs. */
  observeSuccess(expr: string): void {
    for (const [tool, code] of this.pendingFollow) {
      if (expr.includes(tool)) {
        this.log(JSON.stringify({ "door-followed": code, tool }));
        this.pendingFollow.delete(tool);
      }
    }
  }

  /** Serialize the session's dedup/follow/telemetry-sequence state — session-export primitive
   *  (session-store.ts). The injected `log` sink is deliberately excluded (it is re-supplied by
   *  the constructor on restore, never data). */
  exportState(): { seen: readonly string[]; pendingFollow: readonly (readonly [string, string])[]; seq: number } {
    return { seen: [...this.seen], pendingFollow: [...this.pendingFollow], seq: this.seq };
  }

  /** Replace the session's dedup/follow/telemetry-sequence state wholesale (session restore) —
   *  a full rehydration, never a merge. */
  importState(state: {
    seen: readonly string[];
    pendingFollow: readonly (readonly [string, string])[];
    seq: number;
  }): void {
    this.seen.clear();
    for (const key of state.seen) this.seen.add(key);
    this.pendingFollow.clear();
    for (const [tool, code] of state.pendingFollow) this.pendingFollow.set(tool, code);
    this.seq = state.seq;
  }
}
