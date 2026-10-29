// Two invariants provable only through the REAL `createDoorsRunner(...).run(...)` loop
// (runner.ts) — the syntax gate, the forms/statements alignment logic, and real `exec()` —
// never at the `statement-facts.ts` unit level alone:
//
//   1. THE CRASH REGRESSION: ordinary R7RS code with a character literal (e.g.
//      `(char=? #\" (car chars))`) must return a normal, non-throwing result. A retired spike
//      parser used to run redundantly on the same source text, independently of the real
//      interpreter, and choke on `#\"`; the real interpreter has always handled it fine.
//   2. THE `#;` R7RS-CORRECTNESS CASE: `runner.ts` executes/analyzes exclusively from `forms`
//      (the real parser's output), never from `splitTopLevel`'s text-statement count — so a
//      `#;`-commented-out form must never execute. A text-based split leaves the `#;` marker
//      stripped from its slice but does NOT skip the datum that follows: `splitTopLevel`'s
//      `isSkippable` only recognizes the bare `#;` marker token, so the tokenizer still starts
//      a fresh text statement at the very next token. Executing text statements directly (as
//      opposed to `forms`, where `parse()` genuinely drops a `#;`-commented form) would run the
//      commented-out code for real. This test pins the forms-based behavior and guards against
//      regressing back to text-based execution.

import { LexicalScope, RunContext, disposeRunContext, execState } from "@here.build/arrival";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttachmentSink } from "../attachment-sink.js";
import type { BoundTool } from "../bound-tool.js";
import { createDoorsRunner } from "../runner.js";
import { KWARGS_STRATEGIES } from "../strategies.js";

/** No captured binary attachments in these tests — a no-op sink is a valid implementation
 *  (attachment-sink.ts's own doc: "arrival-mcp's positional/native-verb world has no equivalent
 *  binary-leak problem today; a no-op sink is a valid implementation there"). */
const noopSink: AttachmentSink = {
  beginCall(): void {},
  drainBlocks: () => [],
  drainNote: () => undefined,
};

function makeRunner(): ReturnType<typeof createDoorsRunner> {
  return createDoorsRunner({
    toolNaming: { toolName: "eval", argName: "expr" },
    strategies: KWARGS_STRATEGIES,
    attachmentSink: noopSink,
  });
}

// ONE bare (runCtx, capabilities, config) triple (no capabilities, no tools) shared across every
// test in this file — it is stateless and immutable, so sharing it costs nothing; only the
// SCOPE (where a test's own `(define ...)`s would land) needs to be fresh per test, for
// isolation between cases.
const capabilities: readonly [] = [];
const config: Record<string, unknown> = {};
let runCtx: RunContext;
beforeAll(async () => {
  const state = await execState("(begin)", { capabilities, config, scope: LexicalScope.fresh("runner-test-mint") });
  runCtx = state.runCtx;
});
afterAll(async () => {
  await disposeRunContext(runCtx);
});

/** A fresh, isolated lexical scope for one test — mints a null-rooted `LexicalScope` (its
 *  builtins still resolve through the shared `runCtx`/`capabilities` above). */
function freshScope(name: string): LexicalScope {
  return LexicalScope.fresh(name);
}

const noTools = new Map<string, BoundTool>();

describe("createDoorsRunner(...).run(...) — end-to-end regression, real reader + real exec", () => {
  it("the exact MCP-Atlas crash shape (char=? against a quote-character literal) runs without throwing", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-crash-regression");
    const result = await runner.run({
      expr: String.raw`(char=? #\" (car (string->list ",")))`,
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    // A bare #\" character literal must not crash the statement-facts analysis step before real
    // execution even begins — arrival's real interpreter handles this code fine.
    expect(result.isError).not.toBe(true);
    expect(result.content.some((b) => b.type === "text" && /Error:/.test(b.text))).toBe(false);
  });

  it("the fuller CSV-parser shape from the original crash report runs cleanly end to end", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-crash-regression-csv");
    const result = await runner.run({
      expr: String.raw`(define (split-csv-row row)
  (let loop ((chars (string->list row)) (current '()) (fields '()))
    (cond
      ((null? chars)
       (reverse (cons (list->string (reverse current)) fields)))
      ((char=? #\" (car chars))
       (loop (cdr chars) current fields))
      ((char=? #\, (car chars))
       (loop (cdr chars) '() (cons (list->string (reverse current)) fields)))
      (else
       (loop (cdr chars) (cons (car chars) current) fields)))))
(split-csv-row "a,\"b\",c")`,
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
  });

  it("R7RS `#;` datum comment: the commented-out form is never executed", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-hash-semicolon");
    const result = await runner.run({
      expr: "(define x 1) #;(set! x 999) x",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    // x must reflect the un-mutated define (1), never the datum-commented-out (set! x 999).
    expect(rendered).toContain("1");
    expect(rendered).not.toContain("999");
  });

  it("a `#;`-commented form alongside real forms does not shift execution onto the wrong statement", async () => {
    // `(a) #;(b) (c)` is the exact shape statement-facts.ts's module header cites: 2 real forms,
    // but splitTopLevel's TEXT split would still count 3 statements if it were (wrongly) used as
    // the execution source. Using `define`s so each statement's effect is independently visible.
    const runner = makeRunner();
    const scope = freshScope("runner-hash-semicolon-alignment");
    const result = await runner.run({
      expr: "(define a 10) #;(define bogus 999) (define c (+ a 5)) c",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    expect(result.isError).not.toBe(true);
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("15"); // c = a + 5 = 15, proving `a` resolved correctly (not shadowed by "bogus")
  });
});

describe("createDoorsRunner(...).run(...) — the import-form door (doors.ts's importDoor)", () => {
  // This REPL has no module system at all — a model may still prepend `(import (scheme base))`
  // (a malformed R7RS import) to a program. `importDoor` fires on the two unbound heads that
  // produces (`import`, `scheme`); these tests drive it through the REAL runner, not the pure
  // door builder.

  it("`(scheme base)` alone: the door teaches (stdlib already in scope / drop the form), and the rest of the program still computes", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-import-form-scheme-head");
    const result = await runner.run({
      expr: "(scheme base) (+ 1 2)",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).toContain("standard library is already fully bound");
    expect(rendered).toContain("Drop that form and resend the rest of the program unchanged");
    expect(rendered).toContain("3"); // (+ 1 2) still computed despite the first statement's error
  });

  it("`(import (scheme base))`: the outer `import` head also gets the door", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-import-form-import-head");
    const result = await runner.run({
      expr: "(import (scheme base))",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).toContain("standard library is already fully bound");
    expect(rendered).toContain("Drop that form and resend the rest of the program unchanged");
  });

  it("an unrelated unbound variable never gets the import-form door", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-import-form-unrelated");
    const result = await runner.run({
      expr: "(frobnicate 1 2)",
      capabilities,
      config,
      runCtx,
      scope,
      tools: noTools,
    });
    const rendered = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(rendered).toContain("Error: Unbound variable");
    expect(rendered).not.toContain("standard library is already fully bound");
    expect(rendered).not.toContain("module form");
  });

  it("an 11-repeat run teaches the lesson VERBOSE once, then collapses to terse (no 11 verbose repeats)", async () => {
    const runner = makeRunner();
    const scope = freshScope("runner-import-form-repeats");
    const renders: string[] = [];
    for (let i = 0; i < 11; i++) {
      const result = await runner.run({ expr: "(scheme base)", capabilities, config, runCtx, scope, tools: noTools });
      renders.push(result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
    }
    expect(renders[0]).toContain("standard library is already fully bound");
    for (let i = 1; i < renders.length; i++) {
      expect(renders[i]).not.toContain("standard library is already fully bound");
      expect(renders[i]).toContain("standard library is already in scope");
    }
  });

  // A program whose only top-level result is a void `define` must never render as an empty
  // observation — an empty observation reads as "the tool returned no data," not "a binding was
  // made." Every program that binds into session scope gets a persistence note, so a define is
  // never a silent success.
  //
  // The environment-notes block is a trailing footer — alongside the elision/futility/
  // attachment notes, one labelled footer — never a leading block or a peer next to the data.
  describe("introduced-names persistence note (void-result-trap fix, consolidated by E3)", () => {
    it("a define-only program's environment notes announce the binding AND that nothing else executed (B3)", async () => {
      const runner = makeRunner();
      const scope = freshScope("runner-introduced-define-only");
      const result = await runner.run({ expr: "(define x 41)", capabilities, config, runCtx, scope, tools: noTools });
      expect(result.isError).not.toBe(true);
      expect(result.content).toHaveLength(1);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("── environment notes ──");
      expect(text).toContain("x — also available in subsequent calls.");
      // A define-only program must name explicitly that nothing else executed — an unqualified
      // success banner reads as "something ran" to a model consuming the observation.
      expect(text).toContain("nothing was executed — these are bindings only");
    });

    it("the note TRAILS the value observations (after the data, not leading) and lists every bound name once, in declared order", async () => {
      const runner = makeRunner();
      const scope = freshScope("runner-introduced-mixed");
      const result = await runner.run({
        expr: "(define a 10) (define b (+ a 5)) b",
        capabilities,
        config,
        runCtx,
        scope,
        tools: noTools,
      });
      const texts = result.content.map((b) => (b.type === "text" ? b.text : ""));
      // The value observation (b = 15) precedes the trailing notes block.
      expect(texts.slice(0, -1).join("\n")).toContain("15");
      const notes = texts.at(-1)!;
      expect(notes).toContain("── environment notes ──");
      expect(notes).toContain("a, b — also available in subsequent calls.");
      // A real value is observed (b = 15) — the "nothing executed" clause must not appear.
      expect(notes).not.toContain("nothing was executed");
    });

    it("a program that binds NOTHING emits no environment-notes block (pure expressions are unaffected)", async () => {
      const runner = makeRunner();
      const scope = freshScope("runner-introduced-none");
      const result = await runner.run({ expr: "(+ 1 2)", capabilities, config, runCtx, scope, tools: noTools });
      const texts = result.content.map((b) => (b.type === "text" ? b.text : ""));
      expect(texts.join("\n")).not.toContain("environment notes");
      expect(texts.join("\n")).toContain("3");
    });

    it("the notes block is a valid reader block comment — inert if pasted back (round-trip invariant)", async () => {
      const { parse } = await import("@here.build/arrival");
      const runner = makeRunner();
      const scope = freshScope("runner-introduced-roundtrip");
      const result = await runner.run({ expr: "(define x 41)", capabilities, config, runCtx, scope, tools: noTools });
      const notes = (result.content[0] as { text: string }).text;
      // A block comment parses to ZERO forms — pasting it back is a harmless no-op, never data.
      const forms = await parse(notes);
      expect(forms.length).toBe(0);
    });
  });
});

describe("createDoorsRunner(...).run(...) — top-level (begin …) is splicing", () => {
  // Unique failure: wrapping a program in begin is the model's default "I have several
  // statements" spelling. Evaluated as one form, only the last value is recorded and an
  // inner define is invisible to session history. Nested begin inside `if` is sequencing.
  // `(list …)` and `[]` are the other two wrapper spellings.

  it("a wrapping begin records every body form, announces inner defines, and leaves nested begin sequenced", async () => {
    const runner = makeRunner();
    const wrapped = await runner.run({
      expr: "(begin (+ 1 2) (+ 3 4) (define x 10) x)",
      capabilities,
      config,
      runCtx,
      scope: freshScope("runner-begin-splice"),
      tools: noTools,
    });
    const nested = await runner.run({
      expr: "(if #t (begin 1 2))",
      capabilities,
      config,
      runCtx,
      scope: freshScope("runner-begin-nested"),
      tools: noTools,
    });
    const texts = (blocks: typeof wrapped.content): string[] => blocks.map((b) => (b.type === "text" ? b.text : ""));
    const wrappedTexts = texts(wrapped.content);
    const notes = wrappedTexts.find((t) => t.includes("environment notes"));
    expect({
      wrappedValues: wrappedTexts.filter((t) => !t.includes("environment notes")),
      wrappedNotes: notes,
      nested: texts(nested.content),
      wrappedError: wrapped.isError === true,
      nestedError: nested.isError === true,
    }).toEqual({
      wrappedValues: ["3", "7", "10"],
      wrappedNotes: expect.stringMatching(/x — also available in subsequent calls/),
      nested: ["2"],
      wrappedError: false,
      nestedError: false,
    });
  });

  it("a wrapping list or [] records every body form", async () => {
    const runner = makeRunner();
    const listed = await runner.run({
      expr: "(list (+ 1 2) (+ 3 4))",
      capabilities,
      config,
      runCtx,
      scope: freshScope("runner-list-splice"),
      tools: noTools,
    });
    const vector = await runner.run({
      expr: "[(+ 1 2) (+ 3 4)]",
      capabilities,
      config,
      runCtx,
      scope: freshScope("runner-vector-splice"),
      tools: noTools,
    });
    const texts = (blocks: typeof listed.content): string[] => blocks.map((b) => (b.type === "text" ? b.text : ""));
    expect({
      listed: texts(listed.content).filter((t) => !t.includes("environment notes")),
      vector: texts(vector.content).filter((t) => !t.includes("environment notes")),
    }).toEqual({
      listed: ["3", "7"],
      vector: ["3", "7"],
    });
  });
});
