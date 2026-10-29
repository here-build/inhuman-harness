// server — wires the MCP SDK Server directly. Every connected upstream server's tools
// bind into ONE assembled ambient (bind.ts); the catalog (catalog.ts) becomes the
// single exposed tool; ListTools/CallTool hand off to that one tool (manifold-tool.ts).
// A CallTool for anything other than the manifold tool is a boundary DOOR (errors-as-
// doors): the server serves nothing else, and it says so as isError carrying the recovery.
//
// AUTO-PRESENT: a single-text-block response that
// isn't valid JSON is also tried against `detectEnvelope`'s strict recognizer family
// (ndjson/csv/tsv/toon/python-literal, plus prose-prefix/suffix stripping) — same class
// as the grandfathered JSON.parse below, extended to the other strict formats; a
// refusal still falls back to the raw string (`unwrapToolResult`'s NEVER-throw
// contract). The FIRST time a tool's response is auto-presented this way, its qualified
// name is latched by `ObservedSignatureTracker` (normalizer/observed-signature.ts) and
// the tool's catalog signature line gains an `[observed] <format> <shape>` annotation on
// the NEXT soft refresh — see `softRefresh`/`runWithSoftRefresh` below.
//
// BLOCK-LEVEL ENVELOPE ALGEBRA is an ARITY gate, not a SHAPE gate: a multi-TEXT-block
// response (cli-mcp-server's payload + invariant "\nCommand completed with return code:
// 0" trailer; pubmed's one-complete-JSON-object-per-block search results) is classified
// by `detectBlockEnvelope` (normalizer/detect.ts) before falling back to the untouched
// block-array passthrough — exactly one structural block (with prose anywhere around it)
// becomes an envelope `{value, prefix?, suffix?}`; every block structural AND homogeneous
// in top-level kind becomes a vector of the parsed values; anything else (0 structural,
// or 2+ of mixed kind) stays raw. See `unwrapToolResult`'s doc comment below for the full
// rule set.
//
// tools/listChanged (H-2): rebuild-the-world. `buildManifoldEnv` composes ALL servers'
// tools onto one EnvCapability; there is no per-server layer to surgically rebind, so a
// toolset change is a full rebuild: re-list the notifying server, then rebuild ambient +
// scope + catalog + tool. This is cheap (the capability is symbol-only) and IMMUTABLE-SWAP safe:
//   • the rebuild constructs a brand-new ambient/scope/catalog/tool; the old ones are
//     never mutated;
//   • an in-flight eval holds the old tool closure (and its ambient/scope) and finishes
//     against the old world undisturbed;
//   • the swap is one reference assignment after the rebuild completes — a listChanged
//     becomes visible atomically BETWEEN evals, never within one. The superseded world's
//     ambient is disposed right after the swap (never before — an in-flight eval must
//     never see its own ambient torn down mid-flight).
// Ordering contract: a CallTool that dispatches before the swap sees the old world even
// if the notification has already arrived; after the swap, the new one. Multiple
// notifications serialize on a promise chain (no interleaved rebuilds; each rebuild re-
// reads the current tool map, so a coalesced older notification cannot clobber a newer
// build). DELIBERATE side effect: the fresh scope drops any `(define ...)`s accumulated by
// earlier evals — a toolset change is a world change, and stale session state referring
// to vanished tools is worse than a clean slate.
//
// SOFT REFRESH (auto-present signature amendment) is the OTHER, narrower kind of world
// update: it rebuilds ONLY the catalog string + the manifold tool's description, reusing
// the SAME ambient/scope/tools/bypassResolution/trace the live world already has — no
// upstream is re-listed, nothing is re-bound, and `(define ...)`s survive. It fires after
// a manifold-tool call completes (never mid-call, so a single program's multiple
// first-detections batch into one catalog rebuild), and only when at least one signature
// line actually changed (a purely-declared tool's response parsing is latched but never
// changes its already-declared `-> shape`, so it never triggers a notification).

import { disposeRunContext, type EnvCapability, type LexicalScope, type RunContext } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import {
  ambiguousBypassDoor,
  ArgsFailureTracker,
  bareToolCallDoor,
  createSpineLens,
  DoorSession,
  FutilityTracker,
  renderRetryExpr,
  unknownToolDoor,
  type BoundTool,
  type TypeHintLens,
  type TypeHintsMode,
  type ToolSignature,
} from "@inhuman.tools/substrate";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolResultSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  AttachmentCollector,
  type ContentBlockish,
  formatAttachmentStub,
  isBinaryContentBlock,
} from "./attachments.js";
import {
  type AttestationMode,
  type BoundServer,
  type BypassResolution,
  buildManifoldEnv,
  resolveBypass,
  toBoundTools,
} from "./bind.js";
import { buildCatalog, type CatalogOptions } from "./catalog.js";
import type { ConnectedServer } from "./connect.js";
import { createManifoldTool, type ManifoldTool, type ManifoldToolOptions } from "./manifold-tool.js";
import { ARG_NAME, TOOL_NAME } from "./names.js";
import { detectBlockEnvelope, detectEnvelope } from "./normalizer/detect.js";
import { amendSignatureText, ObservedSignatureTracker } from "./normalizer/observed-signature.js";
import { normalizeToolJsonSchema } from "./tool-signature.js";

/** Tool naming threaded into every door builder (replaces doors.ts's direct names.ts
 *  import — see substrate's `ToolNaming`). */
const TOOL_NAMING = { toolName: TOOL_NAME, argName: ARG_NAME };

/** Narrow the MCP call-args object off the wire. A predicate, not a cast: the `unknown`
 *  from `request.params.arguments` is proven here, once, and `ManifoldTool.call`
 *  re-validates every field it reads. */
function isArgsRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** The TS MCP SDK prefixes JSON-RPC re-throws with `MCP error <code>: ` — that frame
 *  is transport plumbing, not the upstream server's message. Models should never see
 *  JSON-RPC internals, so it is stripped at the invoke boundary (first occurrence; the
 *  remainder crosses VERBATIM per the H-4 contract). */
const JSONRPC_FRAME = /^MCP error -?\d+: /;
export function stripJsonRpcFrame(message: string): string {
  return message.replace(JSONRPC_FRAME, "");
}

/** Fallback stub function for standalone/unit-test calls to `unwrapToolResult` — a
 *  private counter starting at 1 for THIS call only. Production wiring (`toBoundServer`
 *  below) always supplies the `AttachmentCollector`'s `stub`, whose numbering resets per
 *  manifold-tool CALL (not per `unwrapToolResult` invocation) and captures the original
 *  block for pass-through. */
function defaultAttachmentStub(): (block: ContentBlockish) => string {
  let index = 0;
  return (block) => formatAttachmentStub(++index, block);
}

/** H-5 REVERSE MARSHALLING (frozen alongside H-4 in manifold-tool.ts). A tool's
 *  CallToolResult re-enters evaluation as a value, so nested composition
 *  `(toy/add :a (toy/add :a 1 :b 1) :b 3)` works. Resolution, in order:
 *    1. `isError: true` THROWS (text blocks' text as the message) — an upstream error
 *       becomes the standard `Error: <message>` observation.
 *    2. `structuredContent` present → it IS the typed value (outputSchema-declaring
 *       servers only).
 *    3. exactly ONE text block → the text, JSON-parsed when valid JSON (a block holding
 *       `3` composes as the number 3 — MCP has no other channel for a typed scalar
 *       from a plain server), else raw string. A server needing a literal string that
 *       happens to be valid JSON declares an outputSchema and sends structuredContent.
 *         - A3 — DOUBLE-ENCODED JSON STRING: when `JSON.parse` SUCCEEDS and yields a
 *           STRING (not object/array — a server that double-JSON-encodes, or a plain
 *           prose payload that happens to arrive JSON-string-quoted), that string is
 *           re-fed through `detectEnvelope` ONCE (never recursing further — depth-0 past
 *           this single re-dispatch, per response-normalizer.md §3's "narrow and
 *           non-recursive" re-dispatch law). A genuinely double-encoded structure
 *           (met-museum-shaped: the block's text IS a JSON string whose OWN content is
 *           itself valid JSON) surfaces as that structure; ordinary prose (met-museum's
 *           actual colon-KV `"Object ID: …\nTitle: …"` shape) is refused by
 *           `detectEnvelope` exactly like any other unrecognized text and stays the
 *           plain string — never silently coerced into something else.
 *         - AUTO-PRESENT (response-normalizer.md §3.5): when the text is NOT valid JSON,
 *           it is tried against `detectEnvelope` — a strict superset of the narrower
 *           `detectParse` (ndjson/csv/tsv/toon/python-literal, strict-or-refuse) that
 *           ALSO strips a prose prefix/suffix around one embedded structure
 *           (desktop-commander get_config's `"Current configuration:\n{…}"`) — BEFORE
 *           falling back to the raw string. Only `.value.value` crosses; the envelope
 *           shell's own keys (`raw`/`prefix`/`suffix`) never enter the observed type
 *           (response-normalizer.md §4.2) — dropping the prose prefix here is a
 *           deliberate faithfulness trade AT THIS SINGLE-BLOCK SEAM (the block-level
 *           envelope below keeps `prefix`/`suffix` VISIBLE instead, because there the
 *           prose is already a separate block, not text sharing one block with the
 *           structure). Same never-throw contract either way. `onAutoPresent` fires (at
 *           most once per call, for any sub-case above) with the format tag and parsed
 *           value whenever this rule actually presents something other than the bare raw
 *           string — the caller's hook for the observed-signature latch (server.ts's
 *           `toBoundServer`).
 *    4. more than one TEXT block, ALL blocks text (no binary in play — rule 5's binary
 *       pre-pass stays untouched and runs after this, exactly as before) — A1
 *       BLOCK-LEVEL ENVELOPE ALGEBRA, an ARITY-gate fix: `detectBlockEnvelope`
 *       (normalizer/detect.ts) partitions the blocks' texts by `detectParse` success.
 *       MCP block boundaries are EXACT (the server handed us the cuts), so — unlike
 *       rule 3's single-string envelope — prose on BOTH sides of the one structural
 *       block is unambiguous, never refused:
 *         - exactly ONE structural block (any number of prose blocks around it, either
 *           side) → an envelope `{value, prefix?, suffix?}` (cli-mcp-server's
 *           payload-block + invariant `"\nCommand completed with return code: 0"`
 *           trailer-block shape).
 *         - EVERY block structural AND homogeneous in top-level kind (all object, or
 *           all array) → a vector of the parsed values (pubmed's JSONL-by-blocks: one
 *           complete JSON object per block, `content[]` genuinely IS a collection).
 *         - anything else (0 structural, or 2+ structural of MIXED kind) → falls
 *           through to rule 5/6 below, strict-or-refuse held exactly as at the string
 *           level.
 *    5. zero / non-text / unclassified-multi-text blocks → the untouched block array,
 *       EXCEPT (attachments.ts): a BINARY block among them is never passed through raw.
 *       Its base64 payload is serialized REPL text; it is replaced by a compact
 *       `#<attachment N: mime/type, NNN bytes>` stub. A lone binary block collapses
 *       straight to that stub STRING (mirroring rule 3's single-value shape); a mix
 *       keeps every text block's own object, binary members swapped only. The original
 *       block is captured (via the `stub` callback, an `AttachmentCollector`) for the
 *       manifold tool's response to pass through as a separate content block. A call
 *       with no binary blocks takes the exact untouched path. */
export function unwrapToolResult(
  result: {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  },
  stub: (block: ContentBlockish) => string = defaultAttachmentStub(),
  onAutoPresent?: (format: string, value: unknown) => void,
): unknown {
  // `ContentBlockish` is a duck-typed view whose fields are all optional `unknown`, so
  // any non-null object inhabits it — the predicate is the proof, not an assertion.
  // Non-object elements (malformed wire) are dropped, which is also what the text/binary
  // passes below would do to them anyway.
  const blocks: ContentBlockish[] = Array.isArray(result.content)
    ? result.content.filter((b): b is ContentBlockish => typeof b === "object" && b !== null)
    : [];
  const texts = blocks
    .filter((b): b is ContentBlockish & { text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text);
  if (result.isError === true) {
    throw new Error(
      texts.join("\n") ||
        "the upstream tool reported failure without diagnostic text — retry with different arguments, " +
          "or continue without this tool's result.",
    );
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }
  if (blocks.length === 1 && texts.length === 1) {
    const text = texts[0]!;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === "string") {
        // A3 — double-encoded JSON string → scalar: re-detect ONCE, never recursing
        // further. A refusal (ordinary prose, e.g. met-museum's colon-KV shape) leaves
        // `parsed` exactly as JSON.parse produced it — the plain string, unmodified.
        const reDetected = detectEnvelope(parsed);
        if (reDetected.ok) {
          onAutoPresent?.(reDetected.value.format, reDetected.value.value);
          return reDetected.value.value;
        }
      }
      onAutoPresent?.("json", parsed);
      return parsed;
    } catch {
      // A2 — widened from `detectParse` to `detectEnvelope` (a strict superset: it
      // calls `detectParse` on the whole string first) so prose-prefixed/suffixed JSON
      // auto-presents too. Only `.value.value` crosses the envelope shell.
      const outcome = detectEnvelope(text);
      if (outcome.ok) {
        onAutoPresent?.(outcome.value.format, outcome.value.value);
        return outcome.value.value;
      }
      return text;
    }
  }
  if (blocks.length > 1 && texts.length === blocks.length) {
    // A1 — block-level envelope algebra. Only reachable when EVERY block is text (a
    // binary block among multiple blocks still falls through to rule 5 below, exactly
    // as before — this rule never disturbs the binary pre-pass).
    const blockOutcome = detectBlockEnvelope(texts);
    if (blockOutcome.kind === "vector") {
      onAutoPresent?.(blockOutcome.format, blockOutcome.value);
      return blockOutcome.value;
    }
    if (blockOutcome.kind === "envelope") {
      onAutoPresent?.(blockOutcome.value.format, blockOutcome.value.value);
      const shell: { value: unknown; prefix?: string; suffix?: string } = { value: blockOutcome.value.value };
      if (blockOutcome.value.prefix !== undefined) shell.prefix = blockOutcome.value.prefix;
      if (blockOutcome.value.suffix !== undefined) shell.suffix = blockOutcome.value.suffix;
      return shell;
    }
    // blockOutcome.kind === "raw" — strict-or-refuse: fall through to rule 5/6 below,
    // the untouched block-array passthrough.
  }
  if (blocks.some(isBinaryContentBlock)) {
    if (blocks.length === 1) return stub(blocks[0]!);
    return blocks.map((b) => (isBinaryContentBlock(b) ? { type: "text", text: stub(b) } : b));
  }
  return result.content;
}

/** Filter a connected server's tool list to an explicit allowlist BEFORE binding
 *  and BEFORE catalog rendering — an unlisted tool neither binds nor appears in any
 *  catalog mode. An allowlisted name absent from the connected server's actual tool
 *  list is a loud typo-guard error. */
function filterToAllowlist(slug: string, tools: readonly Tool[], allowlist: readonly string[]): readonly Tool[] {
  const available = new Set(tools.map((t) => t.name));
  const unknown = allowlist.filter((name) => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `arrival-manifold: server "${slug}" tools allowlist names unknown tool(s) ${unknown.join(", ")} — ` +
        `available: ${[...available].join(", ") || "(none)"}`,
    );
  }
  const allowed = new Set(allowlist);
  return tools.filter((t) => allowed.has(t.name));
}

/** Same `${slug}/${tool}` convention bind.ts's `buildManifoldEnv` binding loop uses to
 *  mint each tool's qualified name (the empty-slug single-server shape binds the bare
 *  name) — replicated here (not imported) because `toBoundServer` runs BEFORE
 *  `buildManifoldEnv` even exists to derive it from, and this is the ONLY other seam that
 *  needs a qualified name: the observed-signature latch keys by the SAME string
 *  `signatureByName`/`toolParts` use, so a later soft refresh can zip them positionally. */
function qualifiedToolName(slug: string, toolName: string): string {
  return slug === "" ? toolName : `${slug}/${toolName}`;
}

function toBoundServer(
  connected: ConnectedServer,
  allTools: readonly Tool[],
  attachments: AttachmentCollector,
  allowlist: readonly string[] | undefined,
  observedSignatures: ObservedSignatureTracker,
): BoundServer {
  const tools = allowlist === undefined ? allTools : filterToAllowlist(connected.slug, allTools, allowlist);
  return {
    slug: connected.slug,
    tools: tools.map((tool) => {
      const qualifiedName = qualifiedToolName(connected.slug, tool.name);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeToolJsonSchema(tool.inputSchema) ?? { type: "object", properties: {} },
        outputSchema: normalizeToolJsonSchema(tool.outputSchema),
        invoke: async (args: Record<string, unknown>, signal?: AbortSignal) => {
          let result;
          try {
            // ABORT PROPAGATION — passing `signal` here tells the MCP SDK's `request()`
            // (protocol.js) to send a real `notifications/cancelled` over the transport
            // AND reject locally, so an aborted manifold call ACTUALLY tells the upstream
            // server to stop, rather than abandoning the await once the trampoline
            // unsticks.
            //
            // ─── WHY `request()` AND NOT `callTool()` ─────────────────────────────────────────
            //
            // `callTool` performs the SDK's own CLIENT-SIDE output-schema validation and THROWS
            // when a tool's `structuredContent` does not match the `outputSchema` the tool itself
            // declared (sdk/client/index.js: `request()` at :495 gets the full result, the
            // validator rejects at :509, and `result` — content blocks and all — IS DISCARDED).
            //
            // The payload is never lost on the wire. It arrives, and is thrown away locally.
            //
            // That made an upstream tool whose own output contradicts its own schema COMPLETELY
            // UNUSABLE through the manifold: `(filesystem/directory_tree :path "/data")` died on
            //   "Output validation error: expected string, received array"
            // with no result, no salvage, and no recovery script — for a payload that was sitting
            // right there. The tool's data was fine. Its SCHEMA was wrong. And the SDK's reflex was
            // to destroy the data to protect the schema.
            //
            // Worse, it was silently load-bearing for a SECOND defect: the observed-signature
            // expert system (normalizer/observed-signature.ts) exists precisely to learn when a
            // tool's DECLARED shape disagrees with what it actually returns — and it could never
            // fire on the one case that matters, because the SDK killed those calls before any
            // manifold code ran. The mechanism was live and structurally unreachable.
            //
            // So we make the request ourselves and adjudicate the mismatch ourselves: the schema is
            // a CLAIM ABOUT the payload, not a licence to delete it. Annotate, do not destroy.
            result = await connected.client.request(
              { method: "tools/call", params: { name: tool.name, arguments: args } },
              CallToolResultSchema,
              { signal },
            );
          } catch (error) {
            // JSON-RPC-level failure (upstream handler threw / invalid params): keep
            // the upstream's own message, drop the SDK's plumbing frame.
            throw error instanceof Error ? new Error(stripJsonRpcFrame(error.message)) : error;
          }
          // WE DO NOT VALIDATE THE TOOL'S OUTPUT AGAINST ITS OWN SCHEMA. We do not need to —
          // we need only to STOP DESTROYING THE PAYLOAD WHEN THEY DISAGREE.
          //
          // `request()` performs no output validation, so the result always survives. That alone is
          // the whole fix: `filesystem/directory_tree` returns a perfectly good array where its own
          // schema claims a string, and the SDK's reflex was to throw the array away to protect the
          // claim. The tool is the authority on what it RETURNED; its schema is only its claim about
          // what it MEANT to return. When they disagree it is the CLAIM that is wrong — the bytes
          // are right there.
          //
          // The disagreement is still worth reporting, and the mechanism for that already exists and
          // has never once been able to fire: `ObservedSignatureTracker` renders
          // `-> [observed] <shape> (declared: <declared shape>)` into the tool's catalog signature
          // (A5's ruling: "declared wins was BACKWARDS — the catalog's declared line is not ground
          // truth, and suppressing the real observation would let the catalog keep actively lying").
          // It was only ever fed from the auto-present path, which runs solely when a tool declares
          // NO structured output — i.e. exactly never for the tools whose declarations are wrong.
          // Feeding it here closes that loop: a tool that lies about its shape now teaches the
          // catalog the truth, on the first call, instead of dying inside the SDK before any
          // manifold code runs.
          // NOT DONE, and deliberately not faked: teaching the catalog that a tool's DECLARED shape
          // is wrong. The mechanism is ready — `ObservedSignatureTracker` renders
          // `-> [observed] <shape> (declared: <declared shape>)`, and A5 already ruled that the
          // declared line is not ground truth. What is missing is DETECTION: recording every
          // declared tool's structuredContent would annotate the CORRECT ones too, which is noise,
          // and the only thing that can tell correct from incorrect — the SDK's output validator —
          // is `private` in its typings, so reaching for it would break on the next SDK bump.
          //
          // Doing it honestly means comparing the OBSERVED shape against the DECLARED one on our own
          // terms (tool-signature.ts's `renderOutputShape` vs the tracker's `renderAnnotation`), and
          // that is a real piece of work, not a line. Ticketed rather than half-built: a catalog that
          // annotates every tool teaches nothing, and one that annotates the wrong ones is worse than
          // one that stays quiet.
          //
          // Either way — detection built or still deferred — the payload survives; destroying it on
          // a schema mismatch is exactly what makes such a tool unusable through the manifold.

          // `attachments.stub` is the SAME collector manifold-tool.ts drains at the end
          // of the call — so a binary block's stub and its pass-through content block
          // share one running number, in encounter order across every tool call this
          // manifold-tool call makes. `onAutoPresent` latches this tool's FIRST observed
          // parse into the shared tracker — the amendment itself (and the soft refresh
          // it triggers) is decided later, once per manifold-tool CALL (server.ts's
          // `runWithSoftRefresh`), never here mid-invoke.
          return unwrapToolResult(result, attachments.stub, (format, value) => {
            observedSignatures.record(qualifiedName, format, value);
          });
        },
      };
    }),
  };
}

export interface BuildManifoldServerOptions extends Omit<ManifoldToolOptions, "typeHints" | "bypassResolution"> {
  /** TYPE HINTS at the server boundary. The `mode` arrives from config/env (bin.ts); the
   *  `lens` is the diagnosis seam. When `lens` is OMITTED and the mode is not "off",
   *  the server builds the REAL spine adapter (`createSpineLens(env)`) per rebuilt
   *  world (same lifecycle as the tool — a tools/listChanged rebuild harvests the new
   *  world's toolset; the old lens dies with the old world). Tests may inject a stub
   *  lens. `typeHints` absent ⇒ the feature is inert. */
  typeHints?: { mode: TypeHintsMode; lens?: TypeHintLens };
  /** Catalog-detail knob threaded to buildCatalog; undefined ⇒ "full" default. */
  catalog?: CatalogOptions;
  /** Attestation knob cut through to BOTH buildManifoldEnv (binding + boundary check)
   *  and buildCatalog (mode-matched preamble); undefined ⇒ `available` default. */
  attestation?: AttestationMode;
  /** Per-server tool allowlist keyed by connected server slug. Absent ⇒ all tools bind.
   *  Re-applied on every rebuild inclusive of a tools/listChanged refresh, so a
   *  listed-but-vanished tool surfaces the same loud config error. */
  toolAllowlist?: Record<string, readonly string[]>;
}

/** The manifold's ONE-CallTool-boundary state: every qualified bound name (for
 *  unknownToolDoor's did-you-mean), the env-side bypass-resolution map (bind.ts's
 *  `buildBypassResolution`) that decides auto-execute vs ask, and the bound-tool
 *  registry threaded to `unknownToolDoor`. Rebuilt with the world on every
 *  tools/listChanged.
 *
 *  `scope`/`signatures`/`trace`/`serverSlugs` exist ONLY so `softRefresh` (below) can
 *  reconstruct a tool with the SAME capabilities/config/runCtx/scope/tools/trace — a hard
 *  rebuild already has these as locals inside `rebuild()`, but a soft refresh runs OUTSIDE
 *  that closure and needs its own copy of the world's current state to reuse verbatim. */
interface ManifoldWorld {
  tool: ManifoldTool;
  /** The world's capability set — retained (alongside `config`) so `execState` can
   *  re-validate a reused `runCtx`'s tuple identity on every call. */
  capabilities: readonly EnvCapability[];
  /** THE SAME config object used to mint `runCtx` — reference identity. */
  config: Record<string, unknown>;
  /** The world's run — retained so a superseding rebuild can dispose it (see the
   *  rebuild-disposal note in the module header). */
  runCtx: RunContext;
  /** The persistent lexical root — same instance across a soft refresh, so `(define ...)`s
   *  survive it (unlike a hard rebuild, which deliberately mints a fresh one). */
  scope: LexicalScope;
  qualifiedNames: readonly string[];
  bypassResolution: ReadonlyMap<string, BypassResolution>;
  tools: ReadonlyMap<string, BoundTool>;
  /** Every bound tool's current ToolSignature, positionally zipped against
   *  `qualifiedNames` (same binding-order convention bind.ts's `toBoundTools` relies on)
   *  — ALREADY folded with whatever `ObservedSignatureTracker` amendments existed at the
   *  time this `ManifoldWorld` was built (`applyObservedAmendments`, used by both
   *  `rebuild` and `softRefresh`), so re-diffing against a later tracker state is a pure
   *  "did anything change since THIS snapshot" comparison. */
  signatures: readonly ToolSignature[];
  /** THE per-session provenance tap (bind.ts's `ManifoldEnv.trace`) — carried here so a
   *  soft refresh can re-thread the SAME tap into the recreated tool (never minting a
   *  second one mid-session). */
  trace: EvalTrace;
  /** Bound-server slugs with ≥1 tool, as `rebuild()` derives them from the live
   *  bindings — reused verbatim by `softRefresh` (a soft refresh never changes which
   *  servers are bound, so recomputing this would just reproduce the same list). */
  serverSlugs: readonly string[];
}

/** Bypass auto-execution: a direct (bypass) call whose name resolved to exactly ONE
 *  qualified tool is translated to `(qualified :k v ...)` (reusing doors.ts's
 *  `renderRetryExpr` — the SAME JSON-args→scheme-literal mapping the old teaching
 *  door rendered) and executed THROUGH the normal manifold tool path — so
 *  doors/serialization/session-history/attachments apply identically to a well-formed
 *  call. The result (success or `Error:`) travels through untouched, prefixed with a
 *  one-line advisory so the model learns the correct call shape from a result that
 *  actually advanced, never a wasted round trip. */
async function autoExecuteBypass(
  tool: ManifoldTool,
  session: DoorSession,
  attempted: string,
  qualified: string,
  args: Record<string, unknown> | undefined,
): Promise<CallToolResult> {
  const retryExpr = renderRetryExpr(qualified, args);
  // DECLINE-TO-AUTO-EXEC (the ONE case a uniquely-resolved bypass is NOT executed): the
  // supplied argument keys include a non-keyword-valid name (renderRetryExpr → undefined).
  // No faithful `:key value` call exists; auto-executing a degraded call would drop the
  // real datum (silently wrong) or eval a stray key fragment. Fall back to v1 teaching
  // (bareToolCallDoor) — same tolerance rule the ambiguous door obeys. */
  if (retryExpr === undefined) {
    const door = bareToolCallDoor(attempted, args, [qualified], TOOL_NAMING);
    return { content: [{ type: "text", text: session.render(door, attempted) }], isError: true };
  }
  // The advisory rides the run's CONSOLIDATED NOTE CHANNEL (seedNotes → the runner's note sink →
  // the `#| ── environment notes ── |#` footer), never a bare block prepended to the answer.
  // Prepending it would open a SECOND, unlabelled notification channel: the model learns twice
  // where bookkeeping lives, and the one place it is guaranteed to read — the answer — opens with a
  // non-answer. This advisory is bookkeeping ABOUT the call ("I rewrote your bare tool call as X"),
  // exactly like the define-introductions and the elision note beside it, so it belongs where they
  // are.
  const note = `auto-executed as ${retryExpr} — call through ${TOOL_NAME} next time.`;
  const result = await tool.call({ [ARG_NAME]: retryExpr }, [note]);
  session.logBypassAutoExec(attempted, qualified);
  return result;
}

export async function buildManifoldServer(
  connectedServers: readonly ConnectedServer[],
  options: BuildManifoldServerOptions = {},
): Promise<Server> {
  // Current tool list per upstream — starts from the connect-time snapshot, replaced
  // whenever that upstream notifies tools/listChanged.
  const currentTools = new Map<ConnectedServer, readonly Tool[]>(connectedServers.map((c) => [c, c.tools]));

  // ONE door session per server process (doors.ts): verbosity gate + follow-rate ledger
  // survive tools/listChanged rebuilds. Injected (e.g. test capturing telemetry) → honored.
  const session = options.session ?? new DoorSession();

  // ONE futility tracker per server process (futility.ts), threaded into BOTH the
  // membrane env (bind.ts records here) and the tool options (manifold-tool.ts drains
  // here). A rebuilt env re-binds the SAME tracker, so a tool that vanishes and returns
  // keeps its history.
  const tracker = new FutilityTracker();

  // ONE args-misuse escalation tracker per server process (substrate
  // args-failure-tracker.ts), threaded the same double way as `tracker`: the membrane env
  // resets it on a successful invoke (bind.ts), the runner counts failures against it
  // (runner.ts's misuse pipeline). Same instance on both seams or the reset never lands.
  const argsTracker = new ArgsFailureTracker();

  // ONE attachment collector per server process (attachments.ts), used by both
  // `toBoundServer` (record site — `unwrapToolResult` stubs a binary block and captures
  // the original) and the tool options (manifold-tool.ts drains at end of call). A
  // new `beginCall()` resets numbering per manifold-tool CALL, not per rebuild.
  const attachments = new AttachmentCollector();

  // ONE observed-signature tracker per server process (normalizer/observed-signature.ts)
  // — the auto-present ruling's per-tool "first successfully-parsed response" latch.
  // Threaded into `toBoundServer` on every rebuild (hard or soft) the SAME double way as
  // `tracker`/`argsTracker`: a hard rebuild re-binds the SAME instance, so a tool that
  // vanishes and returns keeps whatever it already taught the catalog.
  const observedSignatures = new ObservedSignatureTracker();

  // Resolve typeHints for a given world (one `ManifoldToolOptions["typeHints"]`).
  // Production (mode != "off", no injected lens) builds the real spine adapter here;
  // "off"/absent typeHints leaves the feature inert.
  const { typeHints: serverTypeHints, ...toolBaseOptions } = options;
  const typeHintsForWorld = (tools: ReadonlyMap<string, BoundTool>): ManifoldToolOptions["typeHints"] => {
    if (serverTypeHints === undefined || serverTypeHints.mode === "off") return undefined;
    return { mode: serverTypeHints.mode, lens: serverTypeHints.lens ?? createSpineLens(tools) };
  };

  // Fold every tool's OBSERVED-first-parse annotation (response-normalizer.md §3.5) into its
  // rendered ToolSignature, positionally zipped against `qualifiedNames` — the SAME
  // binding-order convention bind.ts's `toBoundTools` relies on (signatures and
  // toolParts/signatureByName are pushed together, in the same loop, in
  // `buildManifoldEnv`). A tool with a DECLARED output shape is untouched:
  // `amendSignatureText`'s own guard ("does this line already say `-> `") implements
  // "declared wins" with no separate declared/observed bookkeeping to keep in sync. Pure
  // — never mutates `signatures`; a no-op entry is returned BY REFERENCE (`sig`, not a
  // copy), so `softRefresh` can detect "did anything actually change" via `!==`.
  const applyObservedAmendments = (
    signatures: readonly ToolSignature[],
    qualifiedNames: readonly string[],
  ): readonly ToolSignature[] =>
    signatures.map((sig, i) => {
      const observed = observedSignatures.get(qualifiedNames[i]!);
      if (!observed) return sig;
      const amended = amendSignatureText(sig.signatureText, observed.annotation);
      return amended === sig.signatureText ? sig : { ...sig, signatureText: amended };
    });

  const rebuild = async (): Promise<ManifoldWorld> => {
    const bound = connectedServers.map((c) =>
      toBoundServer(c, currentTools.get(c) ?? [], attachments, options.toolAllowlist?.[c.slug], observedSignatures),
    );
    const manifoldEnv = await buildManifoldEnv(bound, {
      attestation: options.attestation,
      tracker,
      argsTracker,
    });
    const { capabilities, config, runCtx, scope, signatures, signatureByName, bypassResolution, trace } = manifoldEnv;
    const tools = toBoundTools(manifoldEnv);
    const qualifiedNames = [...signatureByName.keys()];
    // The capability inventory is derived from the LIVE bindings — the slugs the model
    // can actually reach this rebuild — never from config or prose.
    const serverSlugs = [...new Set(bound.filter((b) => b.tools.length > 0).map((b) => b.slug))].filter(Boolean);
    // A hard rebuild re-renders `signatures` from scratch (tool-signature.ts, unamended)
    // — fold back in whatever the tracker already latched BEFORE this rebuild (a
    // survived-the-rebuild tool's earlier observation should not silently vanish from the
    // catalog just because the world was rebuilt for an unrelated reason).
    const amendedSignatures = applyObservedAmendments(signatures, qualifiedNames);
    const catalog = buildCatalog(amendedSignatures, {
      ...options.catalog,
      attestation: options.attestation,
      serverSlugs,
    });
    return {
      // `trace` arms value provenance (response-normalizer §3.5): tool responses carry
      // their originating invocation, and the stringly-collection hint door teaches the
      // parser prelude AT the failure. Per-world, same lifetime as capabilities/config/runCtx/scope.
      tool: createManifoldTool({ capabilities, config, runCtx, scope }, catalog, {
        ...toolBaseOptions,
        session,
        tracker,
        argsTracker,
        attachments,
        tools,
        bypassResolution,
        typeHints: typeHintsForWorld(tools),
        trace,
      }),
      capabilities,
      config,
      runCtx,
      scope,
      qualifiedNames,
      bypassResolution,
      tools,
      signatures: amendedSignatures,
      trace,
      serverSlugs,
    };
  };

  /** SOFT REFRESH (module header): rebuild ONLY the catalog string + the manifold tool's
   *  description, reusing the CURRENT world's capabilities/config/runCtx/scope/tools/
   *  bypassResolution/trace verbatim — never re-lists an upstream, never re-binds a
   *  capability, never mints a fresh scope. Returns `undefined` when nothing actually
   *  changed (every tracker entry latched since the last refresh belonged to an
   *  already-DECLARED tool, so no signature line differs) — the caller's signal to skip
   *  the notification entirely. Immutable-swap style, same as `rebuild`'s result: builds a
   *  brand-new `ManifoldWorld` object, never mutates `current`. */
  const softRefresh = (current: ManifoldWorld): ManifoldWorld | undefined => {
    const amendedSignatures = applyObservedAmendments(current.signatures, current.qualifiedNames);
    const changed = amendedSignatures.some((sig, i) => sig !== current.signatures[i]);
    if (!changed) return undefined;
    const catalog = buildCatalog(amendedSignatures, {
      ...options.catalog,
      attestation: options.attestation,
      serverSlugs: current.serverSlugs,
    });
    return {
      tool: createManifoldTool(
        { capabilities: current.capabilities, config: current.config, runCtx: current.runCtx, scope: current.scope },
        catalog,
        {
          ...toolBaseOptions,
          session,
          tracker,
          argsTracker,
          attachments,
          tools: current.tools,
          bypassResolution: current.bypassResolution,
          typeHints: typeHintsForWorld(current.tools),
          trace: current.trace,
        },
      ),
      capabilities: current.capabilities,
      config: current.config,
      runCtx: current.runCtx,
      scope: current.scope,
      qualifiedNames: current.qualifiedNames,
      bypassResolution: current.bypassResolution,
      tools: current.tools,
      signatures: amendedSignatures,
      trace: current.trace,
      serverSlugs: current.serverSlugs,
    };
  };

  let world = await rebuild();

  const server = new Server(
    { name: "arrival-manifold", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  /** Wraps a dispatch path (the normal manifold call, or an auto-executed bypass) with
   *  the soft-refresh check: run the call, THEN — once, regardless of how many tools got
   *  their first observation during that one program (§7's batching) — swap in a soft
   *  refresh if (and only if) it actually changed something, and notify downstream. This
   *  runs strictly AFTER the call resolves, never mid-call, so a multi-statement program
   *  batches every amendment it discovers into at most one catalog rebuild + one
   *  `tools/list_changed` notification (the debounce the design calls for). */
  const runWithSoftRefresh = async (invoke: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    const result = await invoke();
    if (observedSignatures.drainPending().length > 0) {
      const refreshed = softRefresh(world);
      if (refreshed !== undefined) {
        world = refreshed;
        try {
          await server.sendToolListChanged();
        } catch {
          /* not connected (yet) */
        }
      }
    }
    return result;
  };

  // Serialize refreshes on a promise chain; each link re-lists and swaps in a fresh
  // world. A failed refresh keeps the previous world (stale catalog beats a dead
  // server); reported on stderr, never thrown into the SDK notification path.
  let refreshChain: Promise<void> = Promise.resolve();
  for (const connected of connectedServers) {
    connected.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      refreshChain = (async () => {
        await refreshChain;
        try {
          const { tools } = await connected.client.listTools();
          currentTools.set(connected, tools);
          const previousRunCtx = world.runCtx;
          world = await rebuild();
          // The swap above is the one atomic reference assignment the module header
          // promises — an in-flight eval already closed over `previousRunCtx` (its
          // own resolver, not this outer binding) and finishes against it
          // undisturbed. Disposing it now (fire-and-forget; a disposal failure is
          // reported, never left to crash the refresh chain) frees the superseded
          // world's capability-base resources instead of leaking one run per
          // tools/listChanged refresh.
          void disposeRunContext(previousRunCtx).catch((error) => {
            console.error(
              `arrival-manifold: disposing the superseded world's run failed (non-fatal):`,
              error instanceof Error ? error.message : error,
            );
          });
          // Propagate downstream (the manifold's one tool's catalog changed).
          try {
            await server.sendToolListChanged();
          } catch {
            /* not connected (yet) */
          }
        } catch (error) {
          console.error(
            `arrival-manifold: tools/listChanged refresh for "${connected.slug}" failed; keeping previous toolset:`,
            error instanceof Error ? error.message : error,
          );
        }
      })();
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [world.tool.describe()] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    if (name !== TOOL_NAME) {
      // BYPASS-CALL BOUNDARY — translate iff UNAMBIGUOUS at the env level: a uniquely
      // resolved bypass is translated AND executed through the normal path
      // (autoExecuteBypass), never a transport throw. Ambiguous/unhandled cases return
      // a structured door rendered as ordinary isError content.
      const args = isArgsRecord(request.params.arguments) ? request.params.arguments : undefined;
      const resolution = resolveBypass(world.bypassResolution, name);
      if (resolution?.kind === "unique") {
        return runWithSoftRefresh(() => autoExecuteBypass(world.tool, session, name, resolution.qualified, args));
      }
      const door =
        resolution?.kind === "ambiguous"
          ? ambiguousBypassDoor(name, args, resolution.candidates, TOOL_NAMING, resolution.globalCollision)
          : unknownToolDoor(name, world.qualifiedNames, world.tools, TOOL_NAMING);
      return { content: [{ type: "text", text: session.render(door, name) }], isError: true };
    }
    const args = request.params.arguments;
    return runWithSoftRefresh(() => world.tool.call(isArgsRecord(args) ? args : undefined));
  });
  return server;
}
