// bind — every remote tool from every connected server binds into ONE assembled ambient
// (the capability base), as `${server-slug}/${tool-name}` scheme procedures. `/` is the
// manifold's own namespace
// separator (never legal inside a bare scheme identifier), so a qualifiedName is always
// unambiguously re-splittable into (slug, tool) by its LAST `/` (see doors.ts's `bareNameOf`).
//
// The MCP wire format constrains tool names to `^[a-zA-Z0-9_-]+$` (no `/`), so a direct
// bypass call must translate a de-slashed spelling. That translation lives at the
// CallTool boundary (server.ts's `resolveBypass`), not here.
//
// Each tool's contract is a single `z.kwargs(shape)` object: arrival's kwargs runtime folds
// a call's `:key value` pairs into an object and decodes every property through the
// scheme-identity codec (`z.dynamic`). No per-type dispatch.

import {
  execState,
  LexicalScope,
  toJS,
  z,
  type RunContext,
  type SchemeValue,
  symbol,
  type CallCtx,
} from "@here.build/arrival";
import { isAttested } from "@here.build/arrival/attestation";
import { EnvCapability, type SymbolDeclaration } from "@here.build/arrival/capability";
import { EvalTrace } from "@here.build/arrival/provenance";
import {
  normalizeSymbolName,
  type ArgsFailureTracker,
  type BoundTool,
  type FutilityTracker,
  DISPLAY_INTERNAL,
  displaySymbol,
  type KwargParam,
  type ToolJsonSchema,
  type ToolSignature,
} from "@inhuman.tools/substrate";

import { NORMALIZER_PRELUDE_SYMBOLS, type NormalizerPreludeSymbol } from "./normalizer/prelude.js";
import { toolSignature } from "./tool-signature.js";

/** `symbol.rosetta` is a tagged-template factory — its desugared form is
 *  `fn(stringsArray, ...substitutions)`; a dynamically built qualified name goes
 *  through the same factory called directly. A plain array with `.raw` stubbed is a
 *  sufficient "template". This is the desugared shape of `` `${name}: ${doc}` `` —
 *  three string parts around two holes — so `parseNameDoc` recovers BOTH halves. A 2-part
 *  `[": ", ""]` shape puts the `": "` BEFORE the name hole, so every def parses as anonymous:
 *  `formatKwargsRejection` degrades to the headless `arguments rejected` variant and run-record
 *  `symbolName`s come back empty. */
const NAME_DOC_TEMPLATE = Object.assign(["", ": ", ""], { raw: ["", ": ", ""] }) as unknown as TemplateStringsArray;

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: ToolJsonSchema;
  /** Most MCP servers today declare none — catalog.ts handles the default return shape. */
  outputSchema?: ToolJsonSchema;
  /** Abort propagation — when present, forwards the calling eval's abort signal through
   *  the upstream request (an outbound `notifications/cancelled`), so a stuck tool can be
   *  genuinely cancelled rather than abandoned. Advisory, never required for correctness. */
  invoke: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
}

export interface BoundServer {
  slug: string;
  tools: readonly RemoteTool[];
}

export interface ManifoldEnv {
  /** The composed capability set (stdlib + every bound tool). Threaded on EVERY exec call
   *  alongside `config`/`runCtx` — `execState` rebuilds/looks up the memoized Vocabulary
   *  from `{capabilities, config}` every time, and a reused `runCtx`'s tuple-identity
   *  invariant checks the result against the run's ORIGINAL vocabulary. */
  capabilities: readonly EnvCapability[];
  /** THE SAME config object used to mint `runCtx` — reference identity, not a fresh
   *  per-call object (the vocabulary memo + the reused-runCtx tuple check are both
   *  identity-keyed on it). */
  config: Record<string, unknown>;
  /** The world's run — caller-disposed (via `disposeRunContext`). */
  runCtx: RunContext;
  /** The persistent lexical root a REPL session's top-level `define`s accumulate into —
   *  minted fresh per world build, shared across every call against this world. */
  scope: LexicalScope;
  signatures: readonly ToolSignature[];
  /** Qualified name → catalog signature text (signature-echo teaching hint). */
  signatureByName: ReadonlyMap<string, string>;
  /** Resolved verdicts for every bare-name form a direct bypass call could spell. */
  bypassResolution: ReadonlyMap<string, BypassResolution>;
  /** Qualified name → the (slug, tool) pair it was built from (typed, never re-split). */
  toolParts: ReadonlyMap<string, ToolIdentityParts>;
  /** THE PER-SESSION provenance tap (arrival's `EvalTrace`) — minted ONCE here, per
   *  `ManifoldEnv`/world build, and reused for every call this world's runner makes
   *  (runner.ts's `RunInput.tap`). Provenance-point ids are minted by the tap instance
   *  itself (a plain monotonic counter, never global — see `EvalTrace#nextId`), so
   *  sharing ONE instance across calls is what lets a value minted in call 1 resolve
   *  via `trace.invocationById(id)` in call 3; a fresh trace per call would both break
   *  that cross-call resolution and risk a later trace's ids colliding with ids read
   *  off values still held from an earlier trace. Rebuilt only when the world itself
   *  rebuilds (tools/listChanged) — same lifetime as `scope`. */
  trace: EvalTrace;
}

export interface ToolIdentityParts {
  slug: string;
  tool: string;
}

/** Uniqueness verdict for one attempted bare-name bypass call.
 *  "unique": one parsed target, no collision with a bound global symbol.
 *  "ambiguous": multiple candidates, a cross-server tie, or a collision with an
 *  unrelated bound global symbol — never guess, ask. */
export type BypassResolution =
  | { kind: "unique"; qualified: string }
  | { kind: "ambiguous"; candidates: readonly string[]; globalCollision?: string };

/** Every bare-name form a direct bypass call might spell off a qualified tool:
 *  the underscore wire form (`slug_tool`), the bare tool tail alone, and the
 *  qualified name itself. Deduplicated for slugless bindings (all three coincide). */
function bypassFormsOf(qualifiedName: string, toolParts: ReadonlyMap<string, ToolIdentityParts>): readonly string[] {
  const bare = toolParts.get(qualifiedName)?.tool ?? qualifiedName;
  const wireForm = qualifiedName.replaceAll("/", "_");
  return [...new Set([qualifiedName, wireForm, bare])];
}

/** Build the env-side bypass-resolution map at world (re)build time — the ONE place
 *  that knows both the qualified tool roster and the run's full bound-symbol
 *  vocabulary (`RunContext.vocabulary.keys()`), so the uniqueness verdict is computed
 *  once. Remembers the env-side map (server.ts / python bridge via `_meta`).
 *
 *  Every registered form is indexed by both its raw spelling (an exact-lookup hit) and
 *  its `normalizeSymbolName` canonicalization (a hyphen/underscore/case-drifted hit).
 *  Consumers look up the raw name first, then normalize — an exact match is never
 *  second-guessed by an unrelated fuzzy tie.
 *
 *  A target set of size 1 is "unique" unless its canonical spelling also names a
 *  bound GLOBAL symbol that is not one of the tools (a builtin, an `s/*` validator,
 *  or a previously-`define`d name) — that's a global-symbol collision, downgrades to
 *  "ambiguous" (the verdict's `globalCollision` names the offending symbol). A target set
 *  of size > 1 is always "ambiguous". */
export function buildBypassResolution(
  toolParts: ReadonlyMap<string, ToolIdentityParts>,
  globalBoundNames: readonly string[],
): ReadonlyMap<string, BypassResolution> {
  const qualifiedNames = [...toolParts.keys()];
  const toolNames = new Set(qualifiedNames);
  const nonToolGlobalKeys = new Set(
    globalBoundNames.filter((name) => !toolNames.has(name)).map((name) => normalizeSymbolName(name)),
  );

  const targetsByKey = new Map<string, Set<string>>();
  const register = (key: string, qualified: string): void => {
    const targets = targetsByKey.get(key);
    if (targets) targets.add(qualified);
    else targetsByKey.set(key, new Set([qualified]));
  };
  for (const qualified of qualifiedNames) {
    for (const form of bypassFormsOf(qualified, toolParts)) {
      register(form, qualified);
      register(normalizeSymbolName(form), qualified);
    }
  }

  const resolution = new Map<string, BypassResolution>();
  for (const [key, targets] of targetsByKey) {
    if (targets.size > 1) {
      resolution.set(key, { kind: "ambiguous", candidates: [...targets].toSorted((a, b) => a.localeCompare(b)) });
      continue;
    }
    const [qualified] = targets;
    const globalCollision = nonToolGlobalKeys.has(normalizeSymbolName(key)) ? key : undefined;
    resolution.set(
      key,
      globalCollision === undefined
        ? { kind: "unique", qualified: qualified! }
        : { kind: "ambiguous", candidates: [qualified!], globalCollision },
    );
  }
  return resolution;
}

/** Resolve one attempted bare name against the env-side map — exact spelling first,
 *  then its own `normalizeSymbolName` canonicalization. Return value `undefined` means
 *  the name is unknown to the map. */
export function resolveBypass(
  resolution: ReadonlyMap<string, BypassResolution>,
  attempted: string,
): BypassResolution | undefined {
  return resolution.get(attempted) ?? resolution.get(normalizeSymbolName(attempted));
}

/** Captured for `assembleManifoldPrelude` (json-schema-to-ts.ts) — `z.dynamic`-erased
 *  source; schemas survive here on a module-level WeakMap keyed by the run's
 *  `Vocabulary.map` object (`RunContext.vocabulary`) — memoized per `{capabilities, config}`
 *  tuple, stable identity across every run sharing that tuple (the same object a reused
 *  `runCtx`'s tuple-identity invariant checks against). Never mutated externally; only
 *  `toolSchemasForRun` reads. */
type ToolSchemaEntry = readonly [name: string, input: ToolJsonSchema | undefined, output: ToolJsonSchema | undefined];
const toolSchemasByVocabulary = new WeakMap<object, readonly ToolSchemaEntry[]>();

/** Recover the raw JSON Schemas registered for `runCtx`'s world, or `undefined` if that
 *  world was never built by `buildManifoldEnv` (or `runCtx` carries no vocabulary at all —
 *  a bare mint outside the vocabulary path). */
export function toolSchemasForRun(runCtx: RunContext): readonly ToolSchemaEntry[] | undefined {
  return runCtx.vocabulary === undefined ? undefined : toolSchemasByVocabulary.get(runCtx.vocabulary);
}

/** Attestation mode — whether unattested top-level tool arguments are allowed,
 *  tracked on stderr, or rejected with a frozen teaching error (error-contract.test.ts). */
export type AttestationMode = "off" | "available" | "required";

export interface BuildManifoldEnvOptions {
  /** Attestation mode; undefined ⇒ `available` (full stamping, no enforcement). */
  attestation?: AttestationMode;
  /** Server-wide futility tracker — undefined disables futility detection. */
  tracker?: FutilityTracker;
  /** Server-wide args-misuse escalation tracker (args-error-reporting-v2 §2.4). The binder
   *  only ever RESETS it — a successful invoke clears that tool's counters (the model has a
   *  working shape now); failures are counted runner-side. Pass the SAME instance to the
   *  runner (`createManifoldTool`'s `argsTracker`) or the reset never reaches the counters. */
  argsTracker?: ArgsFailureTracker;
}

/** Truncate a value preview to keep a compact error message — a long prose string
 *  shouldn't blow up a single observation. */
const PREVIEW_MAX = 60;
function previewOf(v: unknown): string {
  const rendered = JSON.stringify(v) ?? String(v);
  return rendered.length > PREVIEW_MAX ? `${rendered.slice(0, PREVIEW_MAX)}...` : rendered;
}

type ValidatorName = "number" | "integer" | "string" | "boolean" | "object" | "array";

type ValidatorDef = { article: "a" | "an"; test: (v: unknown) => boolean };

/** Per-validator predicate + article — `validatorDef` itself has no per-name branching.
 *  `object`/`array` assert the top-level container only (no element-type checks). */
const VALIDATORS: Record<ValidatorName, ValidatorDef> = {
  number: { article: "a", test: (v) => typeof v === "number" },
  integer: { article: "an", test: (v) => typeof v === "number" && Number.isInteger(v) },
  string: { article: "a", test: (v) => typeof v === "string" },
  boolean: { article: "a", test: (v) => typeof v === "boolean" },
  object: { article: "an", test: (v) => typeof v === "object" && v !== null && !Array.isArray(v) },
  array: { article: "an", test: (v) => Array.isArray(v) },
};

/** `typeof` with the two JSON-relevant refinements — rejection of an array
 *  reads "got array" rather than a useless "got object". */
function typeNameOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** One `s/<kind>` validating identity primitive: returns its argument unchanged when
 *  it matches the named type (identity — no coercion), else a recoverable Error.
 *  The implementation returns the decoded JS face; Arrival owns re-boxing and stamps
 *  the source-rosetta result as attested (including freshening shared singletons). */

/**
 * ALIST → DICT, AT THE ARGUMENT BOUNDARY. V's affordance, on the side of the membrane where it bites.
 *
 * Reported (real trajectory): a model wrote the ordinary Scheme spelling of a keyed argument —
 *
 *     (clinicaltrials/list_studies :query (list (cons 'term "cancer")))
 *
 * and the tool received `[["term","cancer"]]` — a nested ARRAY, because a pair-spine projects to an
 * array. Upstream refused it: "is not of type 'object'". The model then burned several rounds
 * reasoning about quoting, tried string keys, and eventually rediscovered our Clojure-style
 * `{:term "cancer"}` literal by trial and error. Rounds spent relearning OUR spelling, not doing
 * the task. The medium made the model pay for our notation.
 *
 * THE CONTRACT SELECTS THE CHART — the same law that governs `listAlike` inside arrival.
 *
 * This is NOT a general promotion of alists (V's explicit ruling: "we teach the system to treat an
 * alist AS a dict — not to treat dicts as lists, not to promote alists; tolerance and affordance,
 * not general design"). `APair`'s outbound projection is UNTOUCHED: a list of pairs is still an
 * array of arrays everywhere else, because everywhere else nothing has claimed otherwise.
 *
 * Here something has: the tool DECLARES this parameter is an object. An alist arriving in that slot
 * is unambiguous — it is a caller spelling a dict the way Scheme spells one. So we read it as the
 * slot says, and ONLY there.
 *
 * Deliberately detected AFTER the crossing, on the JS side: no scheme internals leak into the
 * binder, and the shape we test is exactly the shape the upstream would have rejected.
 *
 * REFUSES ON ANY DOUBT. A false positive here would silently RESHAPE the caller's data, which is
 * strictly worse than the error it replaces. So every entry must be a 2-element array with a STRING
 * key; a numeric key, a ragged entry, an empty list, or a non-array value all cross untouched.
 */
/** JSON Schema `type` may be a scalar or a scalar union (`["string","null"]`). */
function schemaTypes(schema: { type?: string | readonly string[] } | undefined): readonly string[] {
  const type = schema?.type;
  if (typeof type === "string") return [type];
  return Array.isArray(type) ? type : [];
}

/**
 * A STRING IN A STRING-ARRAY SLOT IS A ONE-ELEMENT ARRAY.
 *
 * Models write `:cities "oslo"` where the tool declares `string[]`. The slot
 * already says the elements are strings, so one string is unambiguous — wrap
 * it. A real list stays a list. Anything that is not a plain string (a number,
 * an object, an array of the wrong element type) crosses untouched: wrapping
 * those would reshape data the caller did not write.
 */
function stringArrayOf(value: unknown, items: { type?: string | readonly string[] } | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const types = schemaTypes(items);
  if (!types.includes("string")) return undefined;
  return [value];
}

function alistShapedObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const key = entry[0];
    if (typeof key !== "string") return undefined;
    // `(cons 'term …)` crosses with the keyword's leading colon in some spellings; fold it, so
    // `:term` and `term` name the same field — the upstream knows only `term`.
    out[key.startsWith(":") ? key.slice(1) : key] = entry[1];
  }
  return out;
}

function validatorDef(name: ValidatorName): SymbolDeclaration {
  const { article, test } = VALIDATORS[name];
  const impl = (decoded: z.output<typeof z.dynamic>): unknown => {
    const jsValue = toJS(decoded as SchemeValue);
    if (test(jsValue)) return jsValue;
    throw new Error(`s/${name}: expected ${article} ${name}, got ${typeNameOf(jsValue)}: ${previewOf(jsValue)}`);
  };
  return symbol.rosetta(
    NAME_DOC_TEMPLATE,
    `s/${name}`,
    `Type assertion: returns its argument unchanged if it is ${article} ${name}, else a recoverable Error.`,
  )({ input: [z.dynamic], output: [z.dynamic] }, impl);
}

const VALIDATOR_NAMES = Object.keys(VALIDATORS) as readonly ValidatorName[];

/** Reserved namespace: `s` is reserved for `s/*` validators — a server slugged `s`
 *  would collide with every such symbol. Rejected loudly at bind time; the reservation
 *  holds in ALL attestation modes (including "off") so flipping the knob cannot break
 *  a working config. */
function assertNoReservedSlug(servers: readonly BoundServer[]): void {
  if (servers.some((server) => server.slug === "s")) {
    throw new Error(
      'arrival-manifold: server slug "s" collides with the reserved `s/*` type-assertion namespace ' +
        "(s/number, s/integer, s/string, s/boolean, s/object, s/array) — rename the server's slug.",
    );
  }
}

/** Build the `s/*` family along with the tool bindings. */
function validatorSymbols(): Record<string, SymbolDeclaration> {
  const symbols: Record<string, SymbolDeclaration> = {};
  for (const name of VALIDATOR_NAMES) symbols[`s/${name}`] = validatorDef(name);
  return symbols;
}

/** One normalizer-parser prelude symbol (`parse-json`, `parse-csv`, `detect-parse`, …):
 *  a pure string→value function from the inferred zone (response-normalizer §3.5 —
 *  model-invoked, never automatic). Takes a scheme string and returns the parsed JS
 *  value for Arrival's membrane to lift; a refusal is a recoverable Error naming the reason
 *  (errors-as-doors: the model reads why and picks another parser). Unlike tool defs,
 *  no attestation and no ARGS_REJECTION metadata — a parser throw is an ordinary
 *  in-REPL condition, never a tool.invoke rejection. */
function normalizerDef(entry: NormalizerPreludeSymbol): SymbolDeclaration {
  const impl = (decoded: z.output<typeof z.dynamic>): unknown => {
    const jsValue = toJS(decoded as SchemeValue);
    if (typeof jsValue !== "string") {
      throw new TypeError(`${entry.name}: expected a string, got ${typeNameOf(jsValue)}: ${previewOf(jsValue)}`);
    }
    return entry.fn(jsValue);
  };
  return symbol.rosetta(
    NAME_DOC_TEMPLATE,
    entry.name,
    entry.description,
  )({ input: [z.dynamic], output: [z.dynamic] }, impl);
}

/** Build the normalizer-parser family (present in EVERY attestation mode — parsing is
 *  a capability, not a safety knob). */
function normalizerSymbols(): Record<string, SymbolDeclaration> {
  const symbols: Record<string, SymbolDeclaration> = {};
  for (const entry of NORMALIZER_PRELUDE_SYMBOLS) symbols[entry.name] = normalizerDef(entry);
  return symbols;
}

/**
 * The MCP HOST EXTENSION family — verbs the HOST offers that the LANGUAGE does not have.
 *
 * Kept apart from `normalizerSymbols` deliberately, and the separation is not cosmetic. The parsers
 * are arrival capabilities: they exist in the language and would behave identically under any host.
 * `display` does NOT exist in arrival and must not — ports and IO are omitted by design, and that
 * law is not bending. What lives here is a HOST affordance: the MCP runner rewrites `(display …)`
 * call forms (substrate/display.ts) and lands them on this internal verb, which is identity plus
 * a record on the run's display channel. It writes nowhere; there is no port and no IO.
 *
 * The boundary matters for HONESTY, which is this medium's governing law. The catalog tells the model
 * the sandbox has "no other IO" — and that must stay TRUE OF THE LANGUAGE, because it is the sentence
 * the model reasons from when it decides what is available. Folding `display` into the language's own
 * families would quietly falsify it. Instead the catalog states the extension SEPARATELY, as what it
 * is: the host answering an intent the language declines to spell.
 */
function hostExtensionSymbols(): Record<string, SymbolDeclaration> {
  // The model never writes DISPLAY_INTERNAL — it writes `(display x)`, and the runner's AST rewrite
  // retargets it here. Arrival's own `display` door is untouched and still teaches for the residual
  // case (a bare `display` used as a VALUE, e.g. `(map display xs)`).
  return { [DISPLAY_INTERNAL]: displaySymbol() };
}

/** JSON-Schema `type` → the `s/<kind>` wrapper that the frozen attestation error suggests.
 *  A missing/unknown declared type suggests `s/string` (the safest default). */
const S_KIND_BY_SCHEMA_TYPE: Record<string, ValidatorName> = {
  number: "number",
  integer: "integer",
  string: "string",
  boolean: "boolean",
  object: "object",
  array: "array",
};

/** The frozen required-mode error — model-recoverable: "wrap this arg in (s/<kind> value)".
 *  A type ARRAY (JSON Schema's scalar-union form, e.g. ["number","null"]) has no single
 *  `s/<kind>` to suggest — it takes the same safest-default `s/string` a missing type does. */
function attestationErrorMessage(p: KwargParam, jsValue: unknown): string {
  const declared = p.schema.type;
  const kind = (typeof declared === "string" ? S_KIND_BY_SCHEMA_TYPE[declared] : undefined) ?? "string";
  return `tool argument :${p.name} requires an explicit type assertion — wrap it: (s/${kind} ${previewOf(jsValue)})`;
}

/** Symbol-keyed MEMBRANE METADATA attached to a `tool.invoke` rejection — never inline in
 *  `error.message` (H-4's verbatim-pass-through governs the MESSAGE; this rides the error
 *  OBJECT instead; membrane
 *  metadata is the EXACT source of sentArgs). The localized args-misuse door (substrate)
 *  reads `{qualifiedName, sentArgs}` back off this key — the DECODED JS args this call
 *  actually sent, ground truth at the boundary. Read it ONLY through
 *  {@link findArgsRejection}: arrival's evaluator wraps propagating throws in a fresh
 *  `ArrivalError` whose own symbol table is empty, so on the error a caller of `exec()`
 *  catches, the metadata rides `.cause`, not the top-level object. */
export const ARGS_REJECTION = Symbol("arrival-manifold/args-rejection");

/** The shape riding {@link ARGS_REJECTION}. */
export interface ArgsRejectionMetadata {
  qualifiedName: string;
  sentArgs: Record<string, unknown>;
}

/** Wrapper layers between the door-layer consumer and bind.ts's own rejection object today:
 *  exactly one (arrival's `ArrivalError`). The walk bound leaves room for a second cooperative
 *  wrapper without ever following a pathological/cyclic `cause` chain. */
const ARGS_REJECTION_MAX_CAUSE_DEPTH = 4;

/** THE one supported read path for {@link ARGS_REJECTION}: walk `error` and its `Error.cause`
 *  chain (bounded) for the metadata. Consumers must never read the symbol off the top-level
 *  error alone — arrival's evaluator wraps every propagating throw in a fresh `ArrivalError`
 *  (message copied verbatim, per that class's contract; own symbol-keyed properties
 *  necessarily empty), so a top-level-only read comes back `undefined` through every real
 *  `exec()` path and the door would silently fall back to Signature + Example forever. */
export function findArgsRejection(error: unknown): ArgsRejectionMetadata | undefined {
  let node: unknown = error;
  for (let depth = 0; depth < ARGS_REJECTION_MAX_CAUSE_DEPTH && typeof node === "object" && node !== null; depth++) {
    const metadata = (node as Record<symbol, unknown>)[ARGS_REJECTION];
    if (metadata !== undefined) return metadata as ArgsRejectionMetadata;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Wrap a `tool.invoke` rejection with {@link ARGS_REJECTION} metadata, preserving
 *  `error.message` BYTE-IDENTICAL (design doc §2.2/§3 hook #1, §4's H-4 re-freeze: "metadata
 *  rides the error object, never the message"). A non-`Error` rejection (a thrown plain
 *  value — legal JS, rare in practice; every real MCP SDK/upstream rejection is already an
 *  `Error`) is wrapped in a fresh `Error` whose message is that value's `String()` form, so
 *  the metadata always has a real object to ride. */
function attachArgsRejection(error: unknown, metadata: ArgsRejectionMetadata): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  (err as unknown as Record<symbol, unknown>)[ARGS_REJECTION] = metadata;
  return err;
}

/** Build the rosetta declaration for one tool. Input is `inputRest: shape` (kwargs, not
 *  a positional arg); the impl
 *  runs once per call. Omitted optional kwargs are absent from `decoded` (verified
 *  against the interpreter directly). Per-call attestation boundary: a non-attested
 *  supplied value triggers the required-mode error OR a stderr "measurement" warning
 *  (available mode). A `Call` is forwarded to the upstream `invoke`, propagating the
 *  outer eval's abort signal; the resolved value is recorded by the futility tracker. A
 *  rejection is annotated with {@link ARGS_REJECTION} membrane metadata before it propagates
 *  (the args-misuse door's localization source, design doc §2.2) — `error.message` itself is
 *  never touched. */
function rosettaDef(
  qualifiedName: string,
  tool: RemoteTool,
  signature: ToolSignature,
  mode: AttestationMode,
  tracker: FutilityTracker | undefined,
  argsTracker: ArgsFailureTracker | undefined,
): SymbolDeclaration {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of signature.params) shape[p.name] = p.optional ? z.dynamic.optional() : z.dynamic;
  const impl = async function (this: CallCtx, decoded: Record<string, unknown>): Promise<unknown> {
    const args: Record<string, unknown> = {};
    const unattested: string[] = [];
    for (const p of signature.params) {
      if (p.name in decoded) {
        const decodedValue = decoded[p.name];
        // Zod retains an omitted optional property as an own `undefined` key. At the
        // tool boundary omission and `undefined` are both absence; do not cross,
        // attest, or forward that synthetic entry.
        if (decodedValue === undefined) continue;
        // `decoded` is typed Record<string, unknown> at the rosetta seam, but every value
        // came through the z.dynamic codec — SchemeValue by construction.
        // If the tool DECLARES this param an object and the value crossed as an alist-shaped array,
        // read it as the slot says — see `alistShapedObject` above. Everything else is untouched.
        const crossed = toJS(decodedValue as SchemeValue);
        const declared = schemaTypes(p.schema);
        const jsValue = declared.includes("object")
          ? (alistShapedObject(crossed) ?? crossed)
          : declared.includes("array")
            ? (stringArrayOf(crossed, p.schema?.items) ?? crossed)
            : crossed;
        if (mode !== "off" && !isAttested(decodedValue)) {
          if (mode === "required") throw new Error(attestationErrorMessage(p, jsValue));
          unattested.push(`:${p.name}`);
        }
        args[p.name] = jsValue;
      }
    }
    if (unattested.length > 0) {
      console.warn(
        `arrival-manifold: (${qualifiedName} …) received unattested argument(s) ${unattested.join(", ")} — ` +
          `"required" attestation mode would reject these; wrap model-authored values: (s/<kind> value).`,
      );
    }
    let result: unknown;
    try {
      result = await tool.invoke(args, this.runCtx.signal);
    } catch (error) {
      throw attachArgsRejection(error, { qualifiedName, sentArgs: args });
    }
    tracker?.record(qualifiedName, args, result);
    // Reset-on-success (args-error-reporting-v2 §2.4): the model holds a working shape for
    // this tool now — its next misuse failure starts a fresh L1 lesson, never an inherited L3.
    argsTracker?.recordSuccess(qualifiedName);
    // `z.dynamic` skips output encoding, but the rosetta implementation still speaks
    // plain JS: Arrival's membrane owns boxing and provenance/attestation stamping.
    return result;
  };
  return symbol.rosetta(
    NAME_DOC_TEMPLATE,
    qualifiedName,
    tool.description ?? "",
  )({ input: [], inputRest: shape, output: [z.dynamic] }, impl);
}

/** Build the ONE assembled ambient for every connected server (plus a fresh session
 *  scope for REPL-style define accumulation) — a binding pass followed by ambient
 *  assembly. The empty slug binds the bare tool name (single-server shape). Collisions
 *  fail loudly. The resolved `bypassResolution` map, qualified signatures, and
 *  `toolParts` are captured onto the returned `ManifoldEnv`. */
export async function buildManifoldEnv(
  servers: readonly BoundServer[],
  options: BuildManifoldEnvOptions = {},
): Promise<ManifoldEnv> {
  const mode = options.attestation ?? "available";
  assertNoReservedSlug(servers);
  const symbols: Record<string, SymbolDeclaration> = {
    ...(mode === "off" ? {} : validatorSymbols()),
    ...normalizerSymbols(),
    ...hostExtensionSymbols(),
  };
  const signatures: ToolSignature[] = [];
  const signatureByName = new Map<string, string>();
  const toolSchemas: ToolSchemaEntry[] = [];
  const toolParts = new Map<string, ToolIdentityParts>();
  for (const server of servers) {
    for (const tool of server.tools) {
      // An empty slug keys the tool by its bare name (single-server shape); collisions
      // (duplicate slugs, or a name already bound) fail loudly at bind time.
      const qualifiedName = server.slug === "" ? tool.name : `${server.slug}/${tool.name}`;
      if (qualifiedName in symbols) {
        throw new Error(
          `arrival-manifold: tool name collision on "${qualifiedName}" — two connected servers ` +
            `bind the same symbol. Give each server a distinct non-empty slug.`,
        );
      }
      const signature = toolSignature(qualifiedName, tool.description, tool.inputSchema, tool.outputSchema);
      signatures.push(signature);
      signatureByName.set(qualifiedName, signature.signatureText);
      toolSchemas.push([qualifiedName, tool.inputSchema, tool.outputSchema]);
      toolParts.set(qualifiedName, { slug: server.slug, tool: tool.name });
      symbols[qualifiedName] = rosettaDef(qualifiedName, tool, signature, mode, options.tracker, options.argsTracker);
    }
  }
  // `symbols` is already a fully-computed record by this point (validators + normalizers +
  // host extensions + the per-tool binding loop above) — the injected `(symbol, z)` pair is
  // unused here on purpose: every `symbol.rosetta`/`z.*` use in this file lives in the
  // standalone `validatorDef`/`normalizerDef`/`rosettaDef` helpers above, which read the
  // module-level `@here.build/arrival` / `@here.build/arrival/scheme-zod`
  // imports directly (they're called from more than one place, not just this callback).
  const capability = EnvCapability.define("manifold", { symbols: () => symbols });
  const capabilities: readonly EnvCapability[] = [capability];
  const config: Record<string, unknown> = {};
  const scope = LexicalScope.fresh("manifold");
  const state = await execState("(begin)", { capabilities, config, scope });
  const runCtx = state.runCtx;
  if (runCtx.vocabulary !== undefined) toolSchemasByVocabulary.set(runCtx.vocabulary, toolSchemas);
  const globalBoundNames = [...(runCtx.vocabulary?.keys() ?? [])];
  const bypassResolution = buildBypassResolution(toolParts, globalBoundNames);
  // ONE trace per world build (see the field doc on `ManifoldEnv.trace`) — never per call.
  const trace = new EvalTrace();
  return { capabilities, config, runCtx, scope, signatures, signatureByName, bypassResolution, toolParts, trace };
}

/** Project a built `ManifoldEnv` into ONE `BoundTool` (substrate registry shape)
 *  per bound tool — a pure re-indexing, never a recomputation. The `signatures` and
 *  `toolParts` are populated per iteration of `buildManifoldEnv`'s binding loop;
 *  zipping `toolParts` keys by insertion-order against the same-ordered `signatures`
 *  index recovers each tool's `ToolSignature` directly. Not yet wired into the live
 *  server path (`server.ts`/`manifold-tool.ts`) — used in validation harnesses. */
export function toBoundTools(manifoldEnv: ManifoldEnv): ReadonlyMap<string, BoundTool> {
  const schemaByName = new Map(
    (toolSchemasForRun(manifoldEnv.runCtx) ?? []).map(([name, input, output]) => [name, { input, output }] as const),
  );
  const registry = new Map<string, BoundTool>();
  for (const [index, qualifiedName] of [...manifoldEnv.toolParts.keys()].entries()) {
    const parts = manifoldEnv.toolParts.get(qualifiedName)!;
    const signature = manifoldEnv.signatures[index]!;
    const schemaEntry = schemaByName.get(qualifiedName);
    registry.set(qualifiedName, {
      qualifiedName,
      slug: parts.slug,
      tool: parts.tool,
      schema: schemaEntry?.input,
      outputSchema: schemaEntry?.output,
      signature: () => signature,
    });
  }
  return registry;
}
