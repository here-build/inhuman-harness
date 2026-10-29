// H-3 — the preamble honesty gate, as a CLAIM LEDGER.
//
// Each row is one claim the catalog preamble makes about the interpreter, carrying:
//   - `anchor`: the claim's identifying phrase in the preamble. This is the reason that exact
//     regex exists — delete the claim from the preamble and the anchor MUST fail, forcing the
//     row (and its behavioral evidence) to be reconsidered together. `anchor: null` marks
//     unclaimed-but-bound behavior we still pin: H-3 permits under-claiming; OVER-claiming is
//     the crash class (the model plans around a capability that isn't there and burns a whole
//     episode on it — the Clojure-brace bug). A claim this suite can't verify must be REMOVED
//     FROM THE PREAMBLE, not weakened here.
//   - `evals`: the claimed-available path — [expr, expected rendering] against the ACTUAL
//     assembled manifold env (buildManifoldEnv — the same assembly production uses).
//   - `forbidden`: the claimed-forbidden path — exprs that must error AND whose error must
//     NAME the forbidden head verb (an unbound OPERAND also says "Unbound variable" but names
//     the wrong symbol — the failure mode that produces a false pass on the set!-row otherwise).
//   - `contentBlocks`: claims about MESSAGE BOUNDARIES — [expr, exact content-block texts].
//     Needed because textOf joins blocks with \n, erasing exactly the boundary such a claim
//     is about (audit SEV-2).
//   - `coveredBy`: a signpost to the sibling suite that holds this claim's behavioral
//     evidence (this env binds zero tools, so tool-facing claims can't walk here).
//     The runner does not open that file.
//
// Known limit (accepted): anchors are substring pins — a meaning-inverting edit around an
// anchor ("this is NO LONGER R7RS-small") still matches. The behavioral walks are the real
// gate; anchors only tie claims to their evidence.

import { beforeAll, describe, expect, it } from "vitest";

import { buildManifoldEnv } from "../bind.js";
import { buildCatalog } from "../catalog.js";
import { createManifoldTool, type ManifoldTool } from "../manifold-tool.js";
import { ARG_NAME } from "../names.js";

let tool: ManifoldTool;
beforeAll(async () => {
  const manifoldEnv = await buildManifoldEnv([]);
  tool = createManifoldTool(manifoldEnv, "CATALOG");
});

const textOf = (r: { content: unknown }): string =>
  (r.content as Array<{ type: string; text: string }>).map((c) => c.text).join("\n");

async function expectEval(expr: string, expected: string) {
  const result = await tool.call({ expr });
  expect(result.isError, `expected ${expr} to evaluate, got: ${textOf(result)}`).toBeFalsy();
  expect(textOf(result)).toBe(expected);
}

async function expectForbidden(expr: string) {
  const head = /^\(([^\s()]+)/.exec(expr)![1]!;
  const result = await tool.call({ expr });
  expect(result.isError, `expected ${expr} to be forbidden, got: ${textOf(result)}`).toBe(true);
  const text = textOf(result);
  expect(text).toMatch(/is not available\.|Unbound variable/);
  // The head verb must APPEAR in the error text: without this, a row whose OPERAND happens
  // to be unbound (e.g. a lost cross-call define) passes on the alternation's second branch
  // while the verb it claims to forbid works fine. Substring, not "names the verb": with
  // zero tools bound no did-you-mean menu can echo a superstring of `head` (e.g. `fold` via
  // `fold-right`) — that vector reopens if this env ever binds tools (audit round 2, F5).
  expect(text, `expected the error for ${expr} to mention \`${head}\``).toContain(head);
}

interface ClaimRow {
  claim: string;
  anchor: RegExp | null;
  /** Session-building statements evaluated first (each its own tool.call), results ignored. */
  setup?: readonly string[];
  evals?: ReadonlyArray<readonly [string, string]>;
  forbidden?: readonly string[];
  /** [expr, exact content-block texts] — for message-boundary claims (see header). */
  contentBlocks?: ReadonlyArray<readonly [string, readonly string[]]>;
  /** "file — what proves it": behavioral evidence in a sibling suite (see header map). */
  coveredBy?: string;
}

const CLAIMS: readonly ClaimRow[] = [
  {
    claim: "R7RS-small subset — representative core forms evaluate per spec",
    anchor: /R7RS-small subset/,
    evals: [
      ["(map (lambda (x) (* x x)) '(1 2 3))", "[1 4 9]"],
      ["(apply + '(1 2 3))", "6"],
      ["(let* ((a 1) (b (+ a 1))) (* a b))", "2"],
      ['(string->number "42")', "42"],
      ["(guard (e (#t 'caught)) (raise 'x))", "caught"],
    ],
  },
  {
    claim: "no other IO — every §6.13 door errors",
    anchor: /no other\s+IO/,
    // `display` is bound by the MCP HOST (bind.ts `hostExtensionSymbols`) as identity-plus-echo,
    // not by the language, and performs no IO — it writes to no port, because there are no ports.
    // It is therefore not evidence for "no other IO"; that's the row below. Every genuine §6.13
    // door still errors.
    forbidden: [
      "(newline)",
      '(write "x")',
      "(read)",
      '(open-input-string "x")',
      "(open-output-string)",
      "(current-output-port)",
      "(read-line)",
    ],
  },
  {
    claim: "HOST EXTENSION: (display x) is identity + echo — bound by the host, absent from the language",
    anchor: /HOST EXTENSION: \(display x\)/,
    // The catalog SAYS display works. If a future change unbinds it, or the runner's AST rewrite
    // stops firing, the model reads a promise the medium does not keep — and it would keep writing
    // `(display …)` into a door, which is the exact 32%-of-tasks cost this affordance exists to end.
    evals: [
      // Top-level: the wrap is stripped, so the statement simply IS its argument's value.
      ["(display (list 1 2 3))", "[1 2 3]"],
      // Identity under composition — the whole point: `(f (display x))` answers exactly what `(f x)`
      // answers, and the echo rides ALONGSIDE the answer rather than replacing or perturbing it. The
      // expected text pins both halves at once, which is why the echo block is written out in full.
      ["(+ 1 (display (* 2 3)))", "7\n#| (display (* 2 3)):  6 |#"],
      ["(display 42)", "42"],
    ],
    // The ECHO itself (the `#| (display …):  … |#` block, nesting, multi-display attribution, and
    // the fact that no IO surface was added) is walked at the message boundary next door.
    coveredBy: "display-affordance.law.test.ts — the echo block, nesting, and the surviving door",
  },
  {
    claim: "no call/cc — continuations error",
    anchor: /no call\/cc/,
    forbidden: [
      "(call/cc (lambda (k) (k 1)))",
      "(call-with-current-continuation (lambda (k) (k 1)))",
      "(dynamic-wind (lambda () 1) (lambda () 2) (lambda () 3))",
    ],
  },
  {
    claim: "no mutation — the set!-family verbs error",
    anchor: /no mutation \(set! and friends unbound\)/,
    // The define lands in its own call: under REPL-continue a define+set! pair in one expr is
    // a partial SUCCESS (the door inline, isError false), while the forbidden walk asserts the
    // plain forbidden shape.
    setup: ["(define settable 1)"],
    forbidden: [
      "(set! settable 2)",
      "(set-car! (list 1 2) 9)",
      "(set-cdr! (list 1 2) 9)",
      "(vector-set! #(1 2) 0 9)",
      String.raw`(string-set! "abc" 0 #\z)`,
    ],
  },
  {
    claim: "SRFI-1 subset — the named representatives are bound and behave",
    anchor: /SRFI-1\/13\/26\/28\/43\/95/,
    evals: [
      ["(filter odd? '(1 2 3 4 5))", "[1 3 5]"],
      ["(reduce + 0 '(1 2 3))", "6"],
      ["(fold-right cons '() '(1 2 3))", "[1 2 3]"],
      ["(find even? '(1 2 3))", "2"],
      ["(take '(1 2 3 4) 2)", "[1 2]"],
      ["(drop '(1 2 3 4) 2)", "[3 4]"],
      ["(iota 3)", "[0 1 2]"],
      ["(count odd? '(1 2 3))", "2"],
      ["(delete-duplicates '(1 1 2 2 3))", "[1 2 3]"],
      ["(every odd? '(1 3 5))", "#t"],
      ["(some even? '(1 2 3))", "#t"],
      ["(any odd? '(1 2))", "#t"],
      // Multi-value returns are omitted from arrival by design — partition packages
      // both arms as one list-of-lists product; nested lists still flip to brackets.
      ["(partition odd? '(1 2 3 4))", "[[1 3] [2 4]]"],
    ],
  },
  {
    // SRFI-1's own flagship left-fold is absent from the assembled env; the preamble routes
    // models to reduce. `any` is bound in the current Arrival roster and is covered above.
    claim: "honesty carve-out — `fold` is NOT bound; the routing hint stands",
    anchor: /fold→reduce/,
    forbidden: ["(fold + 0 '(1 2 3))"],
  },
  {
    // Claimed via the SRFI-list anchor (row above); string-split is the SRFI-152 carve-in
    // models actually reach for — bound though no longer individually advertised.
    claim: "SRFI-13 string subset (+ string-split, SRFI-152) — every prior-advertised symbol stays bound",
    anchor: null,
    evals: [
      ['(string-prefix? "he" "hello")', "#t"],
      ['(string-suffix? "lo" "hello")', "#t"],
      [String.raw`(string-index "hello" #\l)`, "2"],
      ['(string-take "hello" 2)', '"he"'],
      ['(string-drop "hello" 2)', '"llo"'],
      ['(string-trim "  x  ")', '"x  "'],
      ['(string-trim-left "  x")', '"x"'],
      [String.raw`(string-pad "7" 3 #\0)`, '"007"'],
      ['(string-pad-right "ab" 4)', '"ab  "'],
      ['(string-join (list "a" "b") "-")', '"a-b"'],
      [String.raw`(string-count "banana" #\a)`, "3"],
      ['(string-null? "")', "#t"],
      ['(string-reverse "abc")', '"cba"'],
      ['(string-tokenize " a  b ")', '["a" "b"]'],
      ['(string-split "a,b,c" ",")', '["a" "b" "c"]'],
    ],
  },
  {
    // ~d is SRFI-48/CL territory, bound beyond SRFI-28's ~a ~s ~% ~~ — under-claiming, safe.
    claim: "format (SRFI-28 + the bound ~d extension)",
    anchor: null,
    evals: [
      ['(format "~a of ~d" "x" 3)', '"x of 3"'],
      ['(format "~s" "x")', String.raw`"\"x\""`],
    ],
  },
  {
    claim: "SRFI-26 — cut and cute specialize (the composition example leans on cut)",
    anchor: null,
    evals: [
      ["((cut + 1 <>) 2)", "3"],
      ["((cute + 1 <>) 2)", "3"],
    ],
  },
  {
    claim: "SRFI-43 — vector ops are bound and behave",
    anchor: null,
    evals: [
      ["(vector-map (lambda (x) (* x x)) #(1 2 3))", "[1 4 9]"],
      ["(vector-fold (lambda (acc x) (+ acc x)) 0 #(1 2 3))", "6"],
      ["(vector-index even? #(1 2 3))", "1"],
    ],
  },
  {
    claim: "SRFI-95 — sort is bound",
    anchor: null,
    evals: [["(sort '(3 1 2) <)", "[1 2 3]"]],
  },
  {
    claim: "SRFI-128 — comparators stay bound (unclaimed in the lean catalog)",
    anchor: null,
    evals: [
      ["(comparator? (make-comparator (lambda (x) #t) equal? <))", "#t"],
      ["(comparator? 42)", "#f"],
    ],
  },
  {
    // Unclaimed constructor: the lean catalog teaches construction via the round-trip property
    // ("a printed result is valid input again") — `{…}` literals ARE the constructor. `(dict …)`
    // builds the identical value and stays bound.
    claim: "(dict :key value ...) builds dicts — round-trips to brace notation",
    anchor: null,
    evals: [["(dict :a 1)", "{:a 1}"]],
  },
  {
    // `{:k v}` ≡ (dict :k v) with evaluated elements, `[…]` is a vector literal, print-back
    // matches the literal written. The comma tolerance and suffix-keyword flip evals are
    // ZIMMERFRAME: they silently hold the model up but are deliberately NOT advertised —
    // behavior pinned here, preamble silence pinned in the zimmerframe table below.
    claim: "Clojure-style {:key value} and [...] literals are first-class",
    anchor: /Clojure-style/,
    evals: [
      ["(:a {:a 1})", "1"],
      ["(:b {:a 1, :b (+ 1 1)})", "2"],
      ['(:x {"x" 5})', "5"],
      ["(vector-ref [1 (+ 1 1) 3] 1)", "2"],
      ["{:key 1}", "{:key 1}"],
      ['(:flight_number {flight_number: "HAT136"})', '"HAT136"'],
      ['(:a {"a": 1})', "1"],
    ],
  },
  {
    // (@ obj :key) dropped from the lean catalog (one accessor claim suffices; the Clojure
    // anchor carries (:key obj)); the form itself stays bound.
    claim: "keyword accessor — (:key obj) is taught; (@ obj :key) stays bound unadvertised",
    anchor: /\(:key obj\)/,
    evals: [
      ['(:name {:name "Ada" :role "analyst"})', '"Ada"'],
      ['(@ {:name "Ada"} :name)', '"Ada"'],
      ['(:status (dict :status "open"))', '"open"'],
    ],
  },
  {
    // `setup` runs as its OWN tool.call, so this row proves the claim literally: the define
    // lands in call 1, the aggregation reads it in call 2 (audit SEV-5 — the earlier version
    // put both statements in one expr and proved only within-program sequencing).
    claim: "defines persist across calls — define in one call, aggregate in the next",
    anchor: /defines persist across calls/,
    setup: ["(define orders (list (dict :total 3) (dict :total 4)))"],
    evals: [["(reduce + 0 (map (cut :total <>) orders))", "7"]],
    coveredBy: "session-declaration-persistence.test.ts — same property at the full MCP boundary",
  },
  {
    claim: "one output message per non-void top-level statement",
    anchor: /returned as its\s+own message/,
    // Exact block-array equality — textOf's \n-join would accept one merged block (audit SEV-2).
    contentBlocks: [["(+ 1 2) (* 2 3)", ["3", "6"]]],
  },
  {
    claim: "a per-call time budget exists",
    anchor: /per-call time budget/,
    coveredBy: "timeout.test.ts (H-1) — the budget machinery and its error surface",
  },
  {
    claim: "tools take keyword arguments, any order, one value each",
    anchor: /keyword arguments/,
    coveredBy: "bind.test.ts — 'keyword order at the call site doesn't matter' (kwargs fold)",
  },
  {
    claim: "omit an optional parameter by omitting its pair",
    anchor: /omitting its pair entirely/,
    coveredBy: "bind.test.ts — 'omits an optional property from the invoke args'",
  },
  {
    claim: "JSON tool output arrives parsed",
    anchor: /arrives parsed/,
    coveredBy: "unwrap.test.ts (H-5) — 'a single text block JSON-parses when valid JSON'",
  },
  {
    claim: "this is the only tool you can call",
    anchor: /only tool you can call/,
    coveredBy: "server.test.ts — 'exposes exactly one tool, named manifold'",
  },
  {
    claim: "a failed statement costs nothing — later statements still run, successes stay defined",
    anchor: /later statements still run/,
    coveredBy: "repl-continue.test.ts — positional errors, sibling survival, env keeps successes",
  },
  {
    claim: "the error message is educational — it shows the correct form",
    anchor: /error message is educational/,
    coveredBy: "doors.test.ts + error-contract.test.ts — every envelope door teaches the recovery",
  },
];

describe("catalog preamble honesty (H-3) — claim ledger", () => {
  it.each(CLAIMS)("claim: $claim", async ({ anchor, setup, evals, forbidden, contentBlocks }) => {
    if (anchor) {
      // Anchored against BOTH ends of the attestation-mode range: every ledger claim lives in
      // the mode-independent basePreamble, and this keeps it there — an anchor drifting into
      // the mode-gated s/* lines would pass "available" while vanishing under "off" (audit
      // round 2, F4).
      expect(buildCatalog([])).toMatch(anchor);
      expect(buildCatalog([], { attestation: "off" })).toMatch(anchor);
    }
    for (const expr of setup ?? []) await tool.call({ expr });
    for (const [expr, expected] of evals ?? []) await expectEval(expr, expected);
    for (const expr of forbidden ?? []) await expectForbidden(expr);
    for (const [expr, blocks] of contentBlocks ?? []) {
      const result = await tool.call({ expr });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual(blocks.map((text) => ({ type: "text", text })));
    }
  });
});

describe("catalog preamble honesty (H-3) — bespoke walks", () => {
  it("claim: an oversize result is reduced IN the brace notation with elision markers, and the preamble owns the hazard", async () => {
    // render-observation.ts rides toSExprString's caps + fair shrink-to-fit natively
    // (SerializeOpts.format): an oversize result keeps the same [..]/{..} notation the model
    // writes, with an inline elision marker (serializer-elision plan — the manifold's default
    // middle-elision: a small head + tail around a LOUD "N ... were not rendered" marker, never
    // a near-complete-looking dump with the hazard buried at the very end). No top-of-output
    // banner — the elision marker itself is the only signal. 100 × 3000-char strings render far
    // past budget, so the shrink loop actually engages.
    const result = await tool.call({ expr: String.raw`(map (lambda (x) (make-string 3000 #\a)) (iota 100))` });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).not.toContain("⚠");
    expect(text).not.toContain("output reduced");
    expect(text).toMatch(/#\| \d+ .+ were not rendered; total array length is \d+ \|#/);
    // The brace/bracket notation survives the reduction — no parens constructor fallback.
    expect(text).not.toMatch(/\(list/);
    expect(text.startsWith("[")).toBe(true);

    // The STRING-elision twin (audit SEV-11): a single oversize string gets the trailing
    // …(+N chars) marker. This walk immediately earned its keep: the preamble (old AND first
    // lean draft) advertised an ASCII "..." spelling while the renderer emits U+2026 "…" —
    // an honesty bug only a behavioral walk could catch.
    const long = await tool.call({ expr: String.raw`(make-string 100000 #\a)` });
    expect(long.isError).toBeFalsy();
    expect(textOf(long)).toMatch(/…\(\+\d+ chars\)/);

    const preamble = buildCatalog([]);
    // Elision is DISPLAY-only: the bound value stays intact in the session; only the printout is
    // sampled. Claiming the elided data is "gone" is a lie about our own state, and models read it
    // as data loss — abandoning the REPL rather than filtering the (still-intact) value in-program.
    // The honest claim — INTACT + filter in-program — is what the medium's whole thesis rests on.
    // Marker spellings stay pinned to the renderer's own spelling (middle-elision "N not rendered").
    expect(preamble).toMatch(/#\| N not rendered, total TOTAL \|#/);
    expect(preamble).toMatch(/…\(\+N chars\)/);
    expect(preamble).toMatch(/INTACT/);
    expect(preamble).toMatch(/filter in-program/);
    expect(preamble).not.toMatch(/elided is gone/);
  });

  it("the SECOND teaching surface — describe()'s program-arg description — stays in agreement with the preamble", () => {
    // manifold-tool.ts's describe() carries its own prose about the program argument (audit
    // SEV-9): the model reads BOTH surfaces. Pin the load-bearing facts on the arg description
    // so drift against the preamble breaks a named test instead of shipping silently.
    const described = tool.describe();
    const properties = (described.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    const programDesc = properties[ARG_NAME]?.description;
    expect(programDesc).toBeTruthy();
    // Same facts the preamble's PROGRAM/REPLY beats teach: string-or-array input, one program,
    // one result per top-level form, kwargs example shape.
    expect(programDesc).toMatch(/one string, or an array/);
    expect(programDesc).toMatch(/single program/);
    expect(programDesc).toMatch(/One result is returned per top-level form/);
    expect(programDesc).toMatch(/:query "bug"/);
  });

  it("claim: s/number, s/integer, s/string, s/boolean are identity-on-success, recoverable-error-on-failure", async () => {
    await expectEval("(s/number 81)", "81");
    await expectEval("(s/integer 81)", "81");
    await expectEval('(s/string "hi")', '"hi"');
    await expectEval("(s/boolean #t)", "#t");

    const numberFail = await tool.call({ expr: '(s/number "There are 81 songs")' });
    expect(numberFail.isError).toBe(true);
    expect(textOf(numberFail)).toBe('Error: s/number: expected a number, got string: "There are 81 songs"');

    const integerFail = await tool.call({ expr: "(s/integer 81.5)" });
    expect(integerFail.isError).toBe(true);
    expect(textOf(integerFail)).toBe("Error: s/integer: expected an integer, got number: 81.5");

    const stringFail = await tool.call({ expr: "(s/string 5)" });
    expect(stringFail.isError).toBe(true);
    expect(textOf(stringFail)).toBe("Error: s/string: expected a string, got number: 5");

    const booleanFail = await tool.call({ expr: "(s/boolean 1)" });
    expect(booleanFail.isError).toBe(true);
    expect(textOf(booleanFail)).toBe("Error: s/boolean: expected a boolean, got number: 1");

    const preamble = buildCatalog([]);
    expect(preamble).toMatch(
      /\(s\/number x\), \(s\/integer x\), \(s\/string x\), \(s\/boolean x\), \(s\/object x\),\s+\(s\/array x\)/,
    );
  });

  it("claim: s/object and s/array assert the top-level container (identity on pass, door on fail)", async () => {
    // identity: the asserted container is the same value — its fields still read
    await expectEval("(:a (s/object {:a 1}))", "1");
    await expectEval("(s/array (list 1 2))", "[1 2]");

    const objectFail = await tool.call({ expr: "(s/object 5)" });
    expect(objectFail.isError).toBe(true);
    expect(textOf(objectFail)).toBe("Error: s/object: expected an object, got number: 5");
    const arrayOnObject = await tool.call({ expr: "(s/array {:a 1})" });
    expect(arrayOnObject.isError).toBe(true);
    expect(textOf(arrayOnObject)).toMatch(/^Error: s\/array: expected an array, got object:/);
    const objectOnArray = await tool.call({ expr: "(s/object [1 2])" });
    expect(objectOnArray.isError).toBe(true);
    expect(textOf(objectOnArray)).toBe("Error: s/object: expected an object, got array: [1,2]");
  });

  it('attestation-mode honesty: "off" drops the s/* teaching (family unbound); "required" adds the wrap rule', async () => {
    // "off": the preamble must not advertise an unbound family (the H-3 crash class)
    const offCatalog = buildCatalog([], { attestation: "off" });
    expect(offCatalog).not.toMatch(/s\/number/);
    const offManifoldEnv = await buildManifoldEnv([], { attestation: "off" });
    const offTool = createManifoldTool(offManifoldEnv, "CATALOG");
    const offResult = await offTool.call({ expr: "(s/number 1)" });
    expect(offResult.isError).toBe(true);
    expect(textOf(offResult)).toContain("Unbound variable");

    // "required": the wrap rule is taught, with the exact example the boundary error echoes
    const requiredCatalog = buildCatalog([], { attestation: "required" });
    expect(requiredCatalog).toMatch(/REQUIRED here/);
    expect(requiredCatalog).toMatch(/\(tool :amount \(s\/number 37\)\)/);
    expect(requiredCatalog).toMatch(/pre-attested/);

    // the default is "available" — byte-identical, and it keeps today's teaching line
    expect(buildCatalog([])).toBe(buildCatalog([], { attestation: "available" }));
    expect(buildCatalog([])).not.toMatch(/REQUIRED here/);
  });
});
