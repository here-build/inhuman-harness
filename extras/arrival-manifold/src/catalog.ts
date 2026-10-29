// catalog — renders every bound tool's ToolSignature into the ONE prose block that becomes
// the manifold tool's MCP description. A model that has never seen this server reads
// this alone to know how to call any bound tool.

import type { ToolSignature } from "@inhuman.tools/substrate";
import dedent from "dedent";

import type { AttestationMode } from "./bind.js";
import { ARG_NAME } from "./names.js";

/** Catalog-detail knob (parity harness for eval). "full" renders the preamble plus
 *  one signature line per bound tool. "summary" keeps the preamble but replaces the
 *  signature list with caller-provided text (e.g. a bench's discovery-verb pointer),
 *  so comparison arms get matched information access. */
export interface CatalogOptions {
  detail?: "full" | "summary";
  /** Required when `detail: "summary"`. */
  summaryText?: string;
  /** Bound upstream server slugs, in binding order — renders the WORLD beat's capability
   *  inventory ("The functions below span: …"). Derived from the actual bindings by the
   *  composer (server.ts), never authored: the inventory is mechanism, not editorial. On a
   *  one-tool surface a model that concludes a domain is unreachable punts to the user with
   *  ZERO calls — the preamble is the only channel that exists for a model that never makes
   *  contact, so no door can recover the miss. Empty-string slugs carry no domain name to
   *  claim and are dropped; all-empty ⇒ no inventory line at all. */
  serverSlugs?: readonly string[];
  /** Attestation mode mirrored from bind.ts; "off" drops the `s/*` teaching so the
   *  preamble never over-claims. */
  attestation?: AttestationMode;
}

/** `s/*` teaching, present whenever the family is bound (available/required). */
const TYPE_ASSERTION_LINE = dedent`
  - Type assertions: (s/number x), (s/integer x), (s/string x), (s/boolean x), (s/object x),
    (s/array x) return x unchanged if it has that type, else a recoverable Error — wrap values
    where a caller expects a specific type. (s/object and s/array assert the top-level
    container only.)
`;

/** The "required" contract, taught once up front. */
const ATTESTATION_REQUIRED_LINE = dedent`
  - REQUIRED here: every tool argument you author yourself (a literal or a computed value)
    must carry an explicit type assertion — write (tool :amount (s/number 37)), never a bare
    37. Tool results, and fields read from them ((:key result), (@ result :key), car,
    vector-ref), are pre-attested and pass as-is; any computation over them (+,
    string-append, map, ...) produces a fresh value you must re-assert, e.g.
    (s/number (+ (:price r) 1)).
`;

export function buildCatalog(signatures: readonly ToolSignature[], options: CatalogOptions = {}): string {
  const attestation = options.attestation ?? "available";
  const worldBeat = dedent`
    This is not an ordinary MCP tool — it hosts an entire programming environment:
    a sandboxed Scheme REPL with an R7RS-small subset and every connected MCP server's tools bound
    as ordinary functions. It is the only tool you can call — everything below goes
    inside its \`${ARG_NAME}\` field.
  `;
  // The capability inventory rides INSIDE the WORLD beat: the affordance must land
  // before the model forms its plan — a model that concludes "this domain is not here"
  // never makes the first call, and no door can reach it. The pedagogy sentence stays
  // domain-blind: the ONLY capability words are the derived slugs themselves — naming
  // concrete capability kinds ("files", "repositories") would over-claim whenever no
  // such server is bound (H-3's never-over-claim rule, same as omitting the line when
  // no slugs exist).
  const inventorySlugs = (options.serverSlugs ?? []).filter(Boolean);
  const inventory =
    inventorySlugs.length > 0
      ? dedent`
          The functions below span these domains: ${inventorySlugs.join(", ")}.
          A task that mentions resources you have not seen in this conversation may be
          reachable through them — explore with these functions before asking the user.
        `
      : undefined;
  const basePreamble = dedent`
    Call a bound tool with keyword arguments — any order, one value each:
      (github/search-issues :query "bug" :limit 5)
    Omit an optional parameter (marked with a trailing ?) by omitting its pair entirely.

    You are writing programs, not single calls. \`${ARG_NAME}\` takes a string or an
    array of statement strings, run as one program, with each top-level result
    returned as its own message. Compose instead of round-tripping:
      (users/get :id (:owner_id (repos/get :name "acme/app")))   ; nest — results are values
      (define orders (shop/list-orders :status "open"))          ; defines persist across calls
      (reduce + 0 (map (cut :total <>) orders))                  ; SRFI-1/13/26/28/43/95 subsets loaded (fold→reduce)

    Results print as Clojure-style literals — {:key value} dicts, [a b] vectors — and
    keywords are accessors: (:key obj). JSON tool output arrives parsed.
    An object-typed param takes that same literal: (tool :query {:term "cancer"}). A signature's
    \`-> shape\` declares its return shape. #| N not rendered, total TOTAL |# and …(+N chars)
    mark display-only sampling — the value stays INTACT: bind it and filter in-program.

    Serialized-TEXT output (CSV, JSON-in-string, Python repr, TOON) parses in-program:
    (detect-parse s) → records; (detect-envelope s) strips prose around JSON.

    The sandbox is pure except the bound tools — they are its only effects; no other
    IO, no mutation (set! and friends unbound), no call/cc. HOST EXTENSION: (display x)
    = identity + echo (no IO): returns x, and shows it in a #| |# note by the result.
    A per-call time budget
    stops runaway programs — so this REPL is a safe place to experiment: a failed
    statement costs nothing, later statements still run, everything that succeeded
    stays defined, and the error message is educational — it shows the correct form.
    Try, read the error, adjust.
  `;
  const preamble = [
    worldBeat,
    ...(inventory ? [inventory] : []),
    basePreamble,
    ...(attestation === "off" ? [] : [TYPE_ASSERTION_LINE]),
    ...(attestation === "required" ? [ATTESTATION_REQUIRED_LINE] : []),
  ].join("\n");
  if (options.detail === "summary") {
    if (!options.summaryText) {
      throw new Error('buildCatalog: detail "summary" requires a non-empty summaryText');
    }
    return `${preamble}\n\n${options.summaryText}`;
  }
  if (signatures.length === 0) return `${preamble}\n\nNo tools connected.`;
  return `${preamble}\n\n${signatures.map((s) => s.signatureText).join("\n")}`;
}
