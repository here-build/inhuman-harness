// Caller-visible `analyzeStatement` record: isDefine, definedName, and localBindings.
// localBindings order is unspecified; rows compare the sorted names.

import { parse } from "@here.build/arrival";
import { describe, expect, it } from "vitest";

import { analyzeStatement } from "../statement-facts.js";

interface FactRow {
  name: string;
  src: string;
  isDefine: boolean;
  definedName: string | undefined;
  localBindings: readonly string[];
}

function fact(
  name: string,
  src: string,
  isDefine: boolean,
  definedName: string | undefined,
  localBindings: readonly string[],
): FactRow {
  return { name, src, isDefine, definedName, localBindings };
}

const FACT_ROWS: readonly FactRow[] = [
  fact("variable define", "(define x 5)", true, "x", []),
  fact("function define names the head, not the param list", "(define (f a b) (+ a b))", true, "f", []),
  fact("zero-param function define", "(define (g) 1)", true, "g", []),
  fact("non-define", "(+ 1 2)", false, undefined, []),
  fact("tool-valued define", '(define p (shop_price :item "widget"))', true, "p", []),
  fact("nameless define", "(define)", true, undefined, []),
  fact("empty function head", "(define () body)", true, undefined, []),
  fact("let wrapping a nested define is not itself a define", "(let ((y 1)) (define z 2) z)", false, undefined, [
    "y",
    "z",
  ]),
  fact("let binding", "(let ((z 5)) z)", false, undefined, ["z"]),
  fact("let*", "(let* ((a 1) (b 2)) (+ a b))", false, undefined, ["a", "b"]),
  fact("letrec plus lambda param", "(letrec ((f (lambda (n) n))) (f 1))", false, undefined, ["f", "n"]),
  fact("named let", "(let loop ((i 0)) (if (< i 5) (loop (+ i 1)) i))", false, undefined, ["i", "loop"]),
  fact("lambda parameters", "(lambda (x y) (+ x y))", false, undefined, ["x", "y"]),
  fact("variadic lambda parameter", "(lambda args args)", false, undefined, ["args"]),
  fact("top-level define is not a local", "(define a (car 5))", true, "a", []),
  fact("lambda-valued define", "(define f (lambda (x) (+ x 1)))", true, "f", ["x"]),
  fact("clojure let", "(let [a 1 b 2] (+ a b))", false, undefined, ["a", "b"]),
  fact("clojure let*", "(let* [a 1 b 2] (+ a b))", false, undefined, ["a", "b"]),
  fact("clojure letrec with an atomic value", "(letrec [f 1] f)", false, undefined, ["f"]),
  fact("named let, whole-list", "(let loop [i 0] i)", false, undefined, ["i", "loop"]),
  fact("named let, whole-list, recursive body", "(let loop [i 0] (if (= i 3) i (loop (+ i 1))))", false, undefined, [
    "i",
    "loop",
  ]),
  fact("racket let", "(let ([a 1] [b 2]) (+ a b))", false, undefined, ["a", "b"]),
  fact("racket let*", "(let* ([a 1] [b 2]) (+ a b))", false, undefined, ["a", "b"]),
  fact("racket letrec whose value is a lambda", "(letrec ([f (lambda () 1)]) (f))", false, undefined, ["f"]),
  fact("letrec*", "(letrec* ([a 1] [b 2]) b)", false, undefined, ["a", "b"]),
  fact("named let, per-element", "(let loop ([i 0]) i)", false, undefined, ["i", "loop"]),
  fact("mixed bracket and paren pairs", "(let ([a 1] (b 2)) (+ a b))", false, undefined, ["a", "b"]),
  // `do` is outside LET_FORMS; the step variable is not a local.
  fact("do step variable is not local", "(do ((i 0 (+ i 1))) (= i 3) i)", false, undefined, []),
  // A nested `(define (name params) ...)` records the function name only.
  fact(
    "nested function-define records the name, not the params",
    "(let ((y 1)) (define (g x) (+ x y)) (g 1))",
    false,
    undefined,
    ["g", "y"],
  ),
  fact("binding named map", "(let ((map 5)) map)", false, undefined, ["map"]),
  fact("parameter named substring", "(lambda (substring) substring)", false, undefined, ["substring"]),
  fact("clojure whole-list with a compound value", "(let [a 1 b (+ 1 2)] (+ a b))", false, undefined, ["a", "b"]),
  fact("clojure binding whose value is a lambda", "(let [f (lambda (n) n)] (f 1))", false, undefined, ["f", "n"]),
  fact("odd-length whole-list keeps the dangling name", "(let [a 1 b] a)", false, undefined, ["a", "b"]),
  fact("named let with no bindings slot", "(let loop)", false, undefined, ["loop"]),
  fact("bare let", "(let)", false, undefined, []),
  fact("racket outer let and clojure inner let*", "(let ([a 1]) (let* [b 2 c 3] (+ a b c)))", false, undefined, [
    "a",
    "b",
    "c",
  ]),
  fact("empty source", "", false, undefined, []),
  fact("comment-only source", ";; just a comment", false, undefined, []),
  fact("trailing same-line comment", "(define x 5) ;; note", true, "x", []),
  fact("binding named let, atomic value", "(let ((let 5)) let)", false, undefined, ["let"]),
  fact("binding named let, symbol value", "(let ((let foo)) let)", false, undefined, ["let"]),
  fact("binding named lambda, list value", "(let ((lambda (p q))) x)", false, undefined, ["lambda"]),
  fact("binding named define", "(let ((define 5)) x)", false, undefined, ["define"]),
  fact("racket binding named let", "(let ([let 5]) let)", false, undefined, ["let"]),
  fact("non-keyword binding name", "(let ((f foo)) f)", false, undefined, ["f"]),
  fact("value is a let expression", "(let ((x (let ((y 1)) y))) x)", false, undefined, ["x", "y"]),
  fact("lambda nested in a binding value", "(let ((f (lambda (n) n))) (f 1))", false, undefined, ["f", "n"]),
  fact("dotted rest arg", "(lambda (a . b) b)", false, undefined, ["a", "b"]),
  fact("dotted rest after fixed params", "(lambda (a b . rest) rest)", false, undefined, ["a", "b", "rest"]),
  fact("whole-list value is a nested let", "(let [a (let [b 1] b)] a)", false, undefined, ["a", "b"]),
  fact("racket value is a nested let", "(let ([a (let [b 1] b)]) a)", false, undefined, ["a", "b"]),
  fact("paren-pair value is a nested let", "(let ((a (let ((b 1)) b))) a)", false, undefined, ["a", "b"]),
  fact("every whole-list value is compound", "(let [a (f 1) b (g 2)] (+ a b))", false, undefined, ["a", "b"]),
  fact("string in the first name slot still keeps a later name", '(let ["foo" 1 b 2] b)', false, undefined, ["b"]),
  fact("bare-atom first bindings slot is a whole-list name", "(let (a (b 2)) body)", false, undefined, ["a"]),
  fact("keyword binding name keeps the colon", "(let ((:map 5)) :map)", false, undefined, [":map"]),
  fact("shadowed let name collapses", "(let ((x 1)) (let ((x 2)) x))", false, undefined, ["x"]),
  fact("lambda param shadowed by a let collapses", "(lambda (v) (let ((v 2)) v))", false, undefined, ["v"]),
  fact("circular datum in a define still names the define", "(define x '#0=(a . #0#))", true, "x", []),
];

const sorted = (names: readonly string[]): string[] => [...names].toSorted((a, b) => a.localeCompare(b));

async function facts(src: string) {
  const forms = await parse(src);
  return analyzeStatement(forms[0]);
}

describe("analyzeStatement", () => {
  it.each(FACT_ROWS)("$name", async ({ src, isDefine, definedName, localBindings }) => {
    const f = await facts(src);
    expect({
      isDefine: f.isDefine,
      definedName: f.definedName,
      localBindings: sorted(f.localBindings),
    }).toEqual({ isDefine, definedName, localBindings });
  });

  it("unbalanced source is rejected by the reader", async () => {
    await expect(facts("(define x")).rejects.toThrow();
  });

  it("a circular let bindings spine does not throw", async () => {
    const forms = await parse("(let #0=(a 1 . #0#) a)");
    expect(() => analyzeStatement(forms[0])).not.toThrow();
  });
});
