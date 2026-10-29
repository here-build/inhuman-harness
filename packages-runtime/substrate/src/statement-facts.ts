// statement-facts — extract key facts from a top-level Scheme form using the real parser.
//
// Operates on the already-parsed `SchemeValue` produced by arrival's reader, never on raw
// source text — so vectors, characters, and datum comments are handled correctly for free,
// comments are naturally ignored (trivia), and R7RS datum-label cycles are walked safely.
//
// This module only *reads* the value tree; it never allocates in the execution heap.

// `ADict` is the `{...}` dict-literal NODE face
// — a reader-minted `{...}` literal is a real ADict carrying `literalForms`, the exact twin of
// AVector's `evalElements` + payload-of-forms. AJSObject (the borrowed-foreign-JS wrapper) never
// appears in a parsed-but-unevaluated statement AST, so it has no business in this walk.
import { ANil, type SchemeValue } from "@here.build/arrival";
import { ADict, APair, ASymbol, AVector } from "@here.build/arrival/reflect-internals";

export interface StatementFacts {
  /** True iff this statement's own top-level form is `(define ...)` — a bare SHAPE check.
   *  Unlike {@link definedName}, this is true even for a malformed `(define)` with no
   *  extractable name — the two fields are deliberately independent (mirrors manifold-tool.ts's
   *  `topLevelDefineName`, which could only ever express the combined "name, or nothing"). */
  readonly isDefine: boolean;
  /** The bound NAME for `(define x …)` / `(define (f a b) …)` — never the `(f a b)` head.
   *  `undefined` for a non-define statement, or a define malformed enough to carry no name
   *  (e.g. `(define)`, `(define () body)`). */
  readonly definedName: string | undefined;
  /** True iff a `map`/`filter`/`reduce`/`fold`/`fold-left`/`fold-right`/`filterv`/`mapv`
   *  SYMBOL (never a string literal, never inside a comment) appears anywhere in this
   *  statement (map/filter/reduce family). */
  readonly usesCollectionOps: boolean;
  /** True iff a `string-*` or `substring` SYMBOL (same string/comment exclusions) appears
   *  anywhere in this statement. */
  readonly usesStringOps: boolean;
  /** Every name bound in a NON-top-level lexical scope inside this statement: a `let`,
   *  `let*`, `letrec`, or `letrec*` binding (incl. a named-let's own loop name, and BOTH the
   *  whole-list/Clojure and per-element/Racket bracket-binding surfaces — see the module
   *  header), a lambda parameter (incl. the single-symbol variadic form and a dotted rest-arg),
   *  or a nested `(define X ...)`. De-duplicated; order unspecified (matches scope-scan.ts's
   *  `scanLocalBindings` contract exactly — existing callers already sort before comparing). */
  readonly localBindings: readonly string[];
}

const EMPTY_FACTS: StatementFacts = {
  isDefine: false,
  definedName: undefined,
  usesCollectionOps: false,
  usesStringOps: false,
  localBindings: [],
};

// ── real-AST structural guards ───────────────────────────────────────────────────────────────
// A "structural" node is one `walk` recurses INTO (a real cons cell, a vector, a dict-literal
// object, or the empty list); everything else — a symbol, a string, a number, a char, a
// boolean, a procedure — is a LEAF. `()` is `ANil`, the real nil singleton, NOT the old plain-
// tree's `{list: []}` — it is structural (nothing to walk, but not an "atom" for the bracket-
// binding shape discriminator below either).
type Structural = APair<any, any> | AVector | ADict | ANil;
const isStructural = (n: SchemeValue | undefined): n is Structural =>
  n instanceof APair || n instanceof AVector || n instanceof ADict || n instanceof ANil;

/** A symbol's name, or `undefined` for anything else (including a gensym, whose `__name__` is
 *  an ES6 `symbol`, not a string — this dialect's reader never produces one, but a defensive
 *  guard here costs nothing and keeps the return type honest). Never `AString` — the string-vs-
 *  symbol distinction is load-bearing (see module header): a `"map"` string literal must never
 *  be mistaken for the `map` symbol, and this guard is the one place that distinction is made. */
function symbolName(n: SchemeValue | undefined): string | undefined {
  return n instanceof ASymbol && typeof n.__name__ === "string" ? n.__name__ : undefined;
}

/** Walk a cons SPINE (`node`, `node.cdr`, `node.cdr.cdr`, …) collecting each `car`, stopping at
 *  the first non-pair `cdr` (the proper-list terminator `ANil`, or — for an IMPROPER list like a
 *  dotted `(a . b)` lambda param list — the dotted TAIL value itself, returned separately so a
 *  caller can decide whether it's a bindable name). Real cons cells are always freshly minted
 *  per read (no incidental sharing) UNLESS a datum label (`#n=`/`#n#`) explicitly shares/cycles
 *  one, so this needs its OWN, call-LOCAL cycle guard (never shared with `walk`'s cross-call
 *  memo — see module header) purely to stop an outright circular SPINE (e.g. a `#0=(a . #0#)`
 *  fed in as a params/bindings list) from looping forever while still being read fresh every time
 *  a distinct caller (`collectLetBindingNames`, then `walkLetBindingValues`) inspects the SAME
 *  bindings-slot node — sharing one guard across those two calls would make the second call see
 *  every node as "already visited" and silently return nothing. */
function spineItems(node: SchemeValue | undefined): { items: SchemeValue[]; tail: SchemeValue | undefined } {
  const items: SchemeValue[] = [];
  const localSeen = new Set<object>();
  let cur: SchemeValue | undefined = node;
  while (cur instanceof APair) {
    if (localSeen.has(cur)) return { items, tail: undefined };
    localSeen.add(cur);
    items.push(cur.car as SchemeValue);
    cur = cur.cdr as SchemeValue | undefined;
  }
  const tail = cur === undefined || cur instanceof ANil ? undefined : cur;
  return { items, tail };
}

/** Normalizes a let-family BINDINGS-SLOT (or one of its per-element pairs) to its flat element
 *  sequence, whichever real shape it arrived in: an `AVector` (`[...]` bracket literal) reads its
 *  `__vector__` payload directly; a real cons spine (`(...)` paren list, or `ANil` for an empty
 *  slot) walks via {@link spineItems}; anything else (malformed input) is `[]`. */
function bindingElements(node: SchemeValue | undefined): SchemeValue[] {
  if (node instanceof AVector) return [...node.__vector__]; // copy: the payload is readonly upstream now
  if (node instanceof APair || node instanceof ANil) return spineItems(node).items;
  return [];
}

// ── trigger-family word lists — VERBATIM from competence.ts (ported, not redesigned; see
// competence.ts for the "why these families" rationale, incl. why `fold`/`fold-left` are kept
// despite not currently being bound builtins) ────────────────────────────────────────────────
const COLLECTION_SYMBOLS = new Set(["map", "filter", "reduce", "fold", "fold-left", "fold-right", "filterv", "mapv"]);
/** competence.ts's `string-[\w?!*<>=]+|substring`, applied to a whole SYMBOL's name. No boundary
 *  lookaround is needed here (unlike competence.ts's regex, which scans raw source text) — the
 *  real reader has already delimited the token, so the symbol's own name IS exactly what would
 *  sit between a `BEFORE`/`AFTER` boundary pair in the old regex. */
const STRING_TRIGGER = /^(?:string-[\w?!*<>=]+|substring)$/;

/** scope-scan.ts's current `LET_FORMS` — deliberately NOT including `do` (see module header). */
const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

interface WalkAccumulator {
  usesCollectionOps: boolean;
  usesStringOps: boolean;
  localBindings: Set<string>;
}

/** Collect a lambda's parameter list into `acc.localBindings`: a flat list of symbols, the
 *  single-symbol variadic form (`(lambda args ...)`), or a dotted rest-arg (`(lambda (a . b)
 *  ...)`, `(lambda (a b . rest) ...)`) — this dialect never destructures a parameter, so one
 *  shallow spine-walk is exact (mirrors scope-scan.ts's `collectParamList`). There is no literal
 *  `.` marker to skip: the real reader parses a dotted param list directly to an IMPROPER cons
 *  spine (`(a . b)` = `APair(a, ASymbol(b))`, no intervening "." atom at all), so
 *  {@link spineItems}'s own dotted-tail return already IS the rest-arg name — collected the same
 *  way a whole-list name would be, from ANY position, not just the lambda-params case. */
function collectParamNames(paramsNode: SchemeValue | undefined, acc: WalkAccumulator): void {
  if (paramsNode === undefined) return;
  const variadicName = symbolName(paramsNode); // `(lambda args ...)` — the single bound name
  if (variadicName !== undefined) {
    acc.localBindings.add(variadicName);
    return;
  }
  if (!(paramsNode instanceof APair) && !(paramsNode instanceof ANil)) return; // malformed: invisible, matches old behavior
  const { items, tail } = spineItems(paramsNode);
  for (const p of items) {
    const name = symbolName(p);
    if (name !== undefined) acc.localBindings.add(name);
  }
  const tailName = symbolName(tail); // the dotted rest-arg, if any
  if (tailName !== undefined) acc.localBindings.add(tailName);
}

/** Collect a let-family form's BINDINGS-SLOT names — both bracket-binding surfaces
 *  (spec: arrival's `src/eval/evaluator.ts` bracket-binding section, `normalizeBindings`)
 *  fall out of ONE shape test on the slot's FIRST element,
 *  with no need to distinguish `[` from `(` (both real surfaces flow through
 *  {@link bindingElements} uniformly):
 *    - the FIRST element is ATOMISH (not structural — a bare symbol `[a 1 b 2]`, or the
 *      historical curiosity of a malformed `(a 1 b 2)`) → the R2a Clojure WHOLE-LIST surface:
 *      flat alternating name/value, names at the even indices.
 *    - the FIRST element is STRUCTURAL (a nested pair `((a 1) (b 2))`/`([a 1] (b 2))`, or a
 *      nested vector `([a 1] [b 2])`) → per-element: each element's own first child (again via
 *      {@link bindingElements}) is a name; a bare-atom sibling in this shape (only reachable via
 *      malformed/ambiguous input) is skipped, matching scope-scan.ts's current under-collection
 *      for that unreachable-in-practice edge.
 *
 *  WHY THE FIRST ELEMENT ALONE, not "every element atomic": a binding NAME is by grammar ALWAYS
 *  a bare symbol (R2a mandates a symbol at every even/name position) — it can never legitimately
 *  be a compound expression. The two surfaces differ ONLY in whether that name sits bare at the
 *  top of the slot (whole-list) or wrapped in its own pair-sublist (per-element), so the first
 *  element's shape — atomish vs. structural — is a total discriminator. Testing every element
 *  (names AND values) is the wrong rule: a single compound VALUE (`[a 1 b (+ 1 2)]` — a call, a
 *  `(lambda …)`, a nested `(let …)`; the everyday Clojure idiom of computing a binding from a
 *  prior one) must never mis-route the whole slot to the per-element branch and silently drop
 *  every real bare-atom name. */
function collectLetBindingNames(bindingsNode: SchemeValue | undefined, acc: WalkAccumulator): void {
  const items = bindingElements(bindingsNode);
  if (items.length === 0) return;
  const wholeList = !isStructural(items[0]); // atomish first element (a name) → whole-list; structural → per-element
  if (wholeList) {
    for (let i = 0; i < items.length; i += 2) {
      const name = symbolName(items[i]);
      if (name !== undefined) acc.localBindings.add(name);
    }
    return;
  }
  for (const el of items) {
    const subItems = bindingElements(el);
    const name = symbolName(subItems[0]);
    if (name !== undefined) acc.localBindings.add(name);
  }
}

/** Recurse into a let-family form's BINDINGS-SLOT VALUE expressions ONLY — never the raw
 *  `(name value)` pair treated as a freestanding form. Mirrors `collectLetBindingNames`'s OWN
 *  first-element shape test (whole-list vs. per-element) IN LOCKSTEP, so the two functions always
 *  agree on which elements are "names" versus "values" for the same input — the two must never
 *  disagree about the very split they exist to compute.
 *
 *  WHY NOT A BLANKET RECURSION: recursing into every child of a let-family form — including the
 *  bindings-list container itself, and with it each raw `(name value)` pair — would re-dispatch a
 *  pair whose NAME happens to equal a scope keyword (`let`/`let*`/`letrec`/`letrec*`/`lambda`/
 *  `define`) as if it were a fresh form of that kind, misreading the VALUE as phantom
 *  parameters/loop-names/bindings. `walk`'s LET_FORMS branch instead recurses into binding VALUES
 *  (this function) and BODY forms explicitly, never falling through to a blanket recursion over
 *  the raw bindings-list container. Values still need walking — a lambda genuinely nested inside
 *  a binding's value, or a trigger word used there, must still be found — just not by
 *  re-interpreting the NAME slot as a dispatchable head. */
function walkLetBindingValues(
  bindingsNode: SchemeValue | undefined,
  depth: number,
  acc: WalkAccumulator,
  seen: Set<object>,
): void {
  const items = bindingElements(bindingsNode);
  if (items.length === 0) return;
  const wholeList = !isStructural(items[0]); // IDENTICAL discriminator to collectLetBindingNames — keep in lockstep
  if (wholeList) {
    // Whole-list (Clojure) surface: values sit at the ODD indices (names at the even ones,
    // matching `collectLetBindingNames`'s own indexing exactly).
    for (let i = 1; i < items.length; i += 2) walk(items[i], depth + 1, acc, seen);
    return;
  }
  for (const el of items) {
    const subItems = bindingElements(el);
    // Per-element (Racket/classic) pair: everything AFTER the first child (the name) is value —
    // almost always exactly one value expression, but walking every remaining child is exact
    // even for a malformed multi-value pair.
    for (let i = 1; i < subItems.length; i++) walk(subItems[i], depth + 1, acc, seen);
  }
}

/** One recursive pass over a statement's parsed form. A symbol is checked against both trigger
 *  families (never a string, never a comment — comments never materialize as a `SchemeValue` at
 *  all, so they can never trigger a false positive); a structural node is checked for a binding-
 *  introducing shape (lambda / let-family / a NESTED define) before recursing into ALL of its
 *  children regardless — the blanket recursion is what reaches a lambda nested inside a
 *  binding's own VALUE (e.g. `(letrec ((f (lambda (n) n))) (f))`'s `n`), and is also what lets a
 *  trigger word used purely as quoted DATA still register (never specifically excluded) —
 *  over-inclusive is the deliberately safe direction here, matching "like-for-like" scanning.
 *
 *  `seen` is `walk`'s OWN cross-call cycle guard (module header): a structural node is marked the
 *  first time `walk` itself descends into it, and a re-encountered node (only possible via a
 *  genuinely circular/shared datum-label structure — real, non-shared parses never repeat a node
 *  identity) short-circuits rather than re-descending. This is safe even for a legitimately
 *  SHARED (non-cyclic) node: since it's the literal same object, walking it twice would collect
 *  the identical set of facts both times, so skipping the repeat loses nothing observable while
 *  guaranteeing termination on an actual cycle.
 *
 *  `depth` starts at 1 for the statement's own root form — matching scope-scan.ts's token-walk
 *  convention exactly, so a NESTED `(define ...)` first becomes eligible at `depth > 1`; the
 *  statement's OWN top-level define (depth 1) is deliberately excluded here — that's
 *  {@link defineShapeOf}'s job, a separate mechanism (matching `topLevelDefineName`'s current,
 *  separate treatment from `scanLocalBindings`). A function-form nested define's OWN parameter
 *  list (e.g. `(define (g x) ...)` nested inside a let body) is NOT walked as params here either
 *  — only its name is captured — reproducing scope-scan.ts's existing behavior exactly (only an
 *  explicit `lambda` gets parameter extraction; a nested function-define does not). */
function walk(node: SchemeValue | undefined, depth: number, acc: WalkAccumulator, seen: Set<object>): void {
  if (node === undefined) return;

  const name = symbolName(node);
  if (name !== undefined) {
    if (COLLECTION_SYMBOLS.has(name)) acc.usesCollectionOps = true;
    if (STRING_TRIGGER.test(name)) acc.usesStringOps = true;
    return;
  }

  if (!isStructural(node)) return; // AString/ACharacter/numbers/booleans/procedures/… — inert leaves
  if (seen.has(node)) return; // cycle/shared-node guard — see doc above
  seen.add(node);

  if (node instanceof AVector) {
    for (const el of node.__vector__) walk(el, depth + 1, acc, seen);
    return;
  }
  if (node instanceof ADict) {
    for (const el of node.literalForms ?? []) walk(el, depth + 1, acc, seen);
    return;
  }
  if (node instanceof ANil) return; // the empty list — nothing to walk

  // node instanceof APair from here.
  const head = node.car as SchemeValue | undefined;
  const headName = symbolName(head);
  const { items: rest } = spineItems(node.cdr as SchemeValue | undefined);

  if (headName === "lambda") {
    collectParamNames(rest[0], acc);
  } else if (headName !== undefined && LET_FORMS.has(headName)) {
    let idx = 0;
    const maybeLoopName = symbolName(rest[0]);
    if (maybeLoopName !== undefined) {
      acc.localBindings.add(maybeLoopName); // named let — the loop name is itself local
      idx = 1;
    }
    const bindingsNode = rest[idx];
    collectLetBindingNames(bindingsNode, acc);
    // Recurse into binding VALUES and the body explicitly — NEVER a generic blanket recursion
    // over the raw bindings-list container (no-secrets/no-secrets false-flags the backticked
    // function-name possessive on the next line as high-entropy; it's a function-name reference,
    // not a secret):
    // eslint-disable-next-line no-secrets/no-secrets
    // see `walkLetBindingValues`'s doc for the exact bug this avoids: a binding named
    // `let`/`lambda`/etc. getting its own value misread as a fresh form of that kind).
    walkLetBindingValues(bindingsNode, depth, acc, seen);
    for (let i = idx + 1; i < rest.length; i++) walk(rest[i], depth + 1, acc, seen); // the body
    return;
  } else if (headName === "define" && depth > 1) {
    const nameNode = rest[0];
    const asName = symbolName(nameNode);
    if (asName !== undefined) {
      acc.localBindings.add(asName);
    } else if (nameNode instanceof APair) {
      const fnHead = symbolName(nameNode.car as SchemeValue | undefined);
      if (fnHead !== undefined) acc.localBindings.add(fnHead);
    }
  }

  walk(head, depth + 1, acc, seen);
  for (const child of rest) walk(child, depth + 1, acc, seen);
}

/** Extract the shape of a top-level `(define ...)` form.
 *
 *  Returns whether it looks like a define at all, and if so the defined name (variable form
 *  or function head). This is separate from "isDefine" flag vs name extraction. */
function defineShapeOf(root: SchemeValue): { isDefine: boolean; definedName: string | undefined } {
  if (!(root instanceof APair)) return { isDefine: false, definedName: undefined };
  const headName = symbolName(root.car as SchemeValue | undefined);
  if (headName !== "define") return { isDefine: false, definedName: undefined };
  const { items: rest } = spineItems(root.cdr as SchemeValue | undefined);
  const second = rest[0];
  const asName = symbolName(second);
  if (asName !== undefined) return { isDefine: true, definedName: asName };
  if (second instanceof APair) {
    const fnHead = symbolName(second.car as SchemeValue | undefined);
    if (fnHead !== undefined) return { isDefine: true, definedName: fnHead };
  }
  return { isDefine: true, definedName: undefined }; // e.g. `(define)`, `(define () body)`
}

/**
 * ONE real parse's worth of facts for a single top-level scheme statement, deriving every fact
 * `topLevelDefineName` (manifold-tool.ts), `scanLocalBindings` (scope-scan.ts), and
 * `competence.scanSuccess` (competence.ts) currently re-derive with three independent
 * regex/tokenizer scans. `form` is the ALREADY-PARSED top-level form — the exact `SchemeValue`
 * arrival's real reader produced for one statement (never source text; this module does no
 * parsing of its own — see module header). `undefined` (an empty/comment-only source, which
 * `parse()` yields zero forms for) returns {@link EMPTY_FACTS} rather than throwing.
 *
 * Takes exactly ONE form — there is no array/multi-form overload. Every real caller (the syntax-
 * gated statement loop in runner.ts) always has exactly one form per statement to analyze;
 * keeping a multi-form-fold path alive would be dead code kept alive purely to dodge migrating
 * old tests, which is itself exactly the kind of shortcut this module's rework exists to remove.
 */
export function analyzeStatement(form: SchemeValue | undefined): StatementFacts {
  if (form === undefined) return EMPTY_FACTS;

  const acc: WalkAccumulator = { usesCollectionOps: false, usesStringOps: false, localBindings: new Set() };
  const seen = new Set<object>();
  walk(form, 1, acc, seen);

  const { isDefine, definedName } = defineShapeOf(form);
  return {
    isDefine,
    definedName,
    usesCollectionOps: acc.usesCollectionOps,
    usesStringOps: acc.usesStringOps,
    localBindings: [...acc.localBindings],
  };
}
