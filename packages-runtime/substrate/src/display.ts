// display.ts — the `display` affordance, HOST-SIDE ONLY.
//
// ─── WHY THIS IS HERE AND NOT IN ARRIVAL ────────────────────────────────────────────────────
//
// Arrival has no `display`, and must not: ports and IO are omitted BY DESIGN. It is a pure
// inference plane, and an ambient write has no value-construction site for provenance — a value
// that gets "printed" has no derivation the trace can slice. That law is not bending, and this
// file does not bend it. Nothing here writes anywhere; `display` returns its argument.
//
// ─── WHY IT EXISTS ANYWAY ───────────────────────────────────────────────────────────────────
//
// A model writes `(display x)` constantly. It is the natural Scheme spelling of "show me this" —
// a reflex, not a request for IO. In the 89-task corpus it cost a hard door and a wasted round on
// 32% OF TASKS, and the model would then try `(display …)` again, or fall back to bare `x`, or —
// in the trajectory that made this measurable — burn its rounds and quit.
//
// The door was correct and useless. It refused the SPELLING while the INTENT was perfectly
// serviceable: the model wants the value. So the HOST offers the verb, and the language stays pure.
// That is the whole shape of this codebase's design — take materialization away from the caller,
// keep only their intent.
//
// ─── THE SEMANTICS ──────────────────────────────────────────────────────────────────────────
//
//   TOP-LEVEL  `(display X)`      → PASS-THROUGH. The wrap is stripped from the AST before eval, so
//                                   the statement simply evaluates X and its value IS the result.
//                                   Nothing extra is rendered: the model asked to see X, and X is
//                                   the answer. A `#| … |#` echo beside it would be noise.
//
//   NESTED     `(f (display X))`  → IDENTITY + SIDE EFFECT. `display` returns X untouched, so
//                                   composition is unaffected, and records what it saw. The runner
//                                   renders it after the statement's own result:
//
//                                       #| (display (list 1 2 3)):  (1 2 3) |#
//
//                                   ...carrying the ORIGINAL EXPRESSION, because "(1 2 3)" alone
//                                   does not tell the model WHICH display it came from when several
//                                   fire in one statement.
//
// The nested rewrite injects each call's own source text as a second argument — the evaluated value
// alone cannot recover it, and matching displays to values by walking the AST afterwards is UNSOUND:
// `(if c (display a) (display b))` has two display forms and exactly one firing, so any positional
// zip silently misattributes.

import { type SchemeValue, z, symbol, type CallCtx } from "@here.build/arrival";
import type { SymbolDeclaration } from "@here.build/arrival/capability";
// `writeForm` is the SOURCE writer (provenance/slice.ts) — it renders a parsed form back to the
// text a human/model wrote. NOT `toSExprString`, which is the VALUE printer: that renders the
// same form as DATA (`(list display (list "*" 2 3))`) instead of as code (`(display (* 2 3))`),
// which would echo a spelling the model never typed and could not paste back.
import { writeForm } from "@here.build/arrival/provenance";
import { APair, ASymbol, AString, nil } from "@here.build/arrival/reflect-internals";

/** The name the MODEL writes. Never survives to evaluation — every call form is rewritten below, so
 *  arrival's own `notImplemented` door for `display` is untouched and still fires for the residual
 *  case (a bare `display` used as a VALUE, e.g. `(map display xs)`), where it correctly teaches that
 *  there is no IO surface. We do not shadow the door; we make the ordinary spelling unnecessary. */
export const DISPLAY = "display";

/** True when a top-level form is a `(display X)` the rewrite unwraps to X — the 1-argument shape.
 *  `(display)` with no args, or extra args, is NOT unwrapped (it falls to the door), so this is
 *  false there. Callers use it to attach a note to exactly the statements that were unwrapped. */
export function isTopLevelDisplay(form: SchemeValue): boolean {
  return isDisplayCall(form) && displayArg(form) !== undefined;
}

/** The internal verb the rewrite targets. The model never writes it; nothing collides with it. */
export const DISPLAY_INTERNAL = "__mcp-display";

/** Is this form a `(display …)` call? */
function isDisplayCall(form: SchemeValue): form is APair<SchemeValue, SchemeValue> {
  return form instanceof APair && form.car instanceof ASymbol && String(form.car.valueOf()) === DISPLAY;
}

/** `(display X)` → its single argument X, or `undefined` when the call is not the 1-argument shape
 *  we know how to unwrap (`(display)` with no args, or extra args — leave those alone rather than
 *  guess). */
function displayArg(form: APair<SchemeValue, SchemeValue>): SchemeValue | undefined {
  const rest = form.cdr;
  if (!(rest instanceof APair)) return undefined; // (display) — no argument
  if (rest.cdr instanceof APair) return undefined; // (display a b …) — not our shape
  return rest.car;
}

/**
 * Rewrite ONE top-level form for the MCP runner.
 *
 *  • If the form IS `(display X)`, return X — the wrap is gone, the statement evaluates to X's
 *    value, and the model's intent ("show me X") is satisfied by the answer itself.
 *  • Every NESTED `(display X)` becomes `(display X "<original source>")`, so the bound verb can
 *    report which call produced which value.
 *
 * Structure-sharing: a subtree with no `display` in it is returned BY IDENTITY, so the common case
 * (no display anywhere) allocates nothing and the original parsed form — with its source locations
 * and provenance intact — flows through untouched.
 */
export function stripTopLevelDisplay(form: SchemeValue): SchemeValue {
  if (isDisplayCall(form)) {
    const arg = displayArg(form);
    // Unwrap, and keep rewriting INSIDE the argument — `(display (f (display y)))` is legal, and the
    // inner one is genuinely nested.
    if (arg !== undefined) return annotateNestedDisplays(arg);
  }
  return annotateNestedDisplays(form);
}

/** Rewrite every `(display X)` in a subtree to `(display X "<src>")`. Identity when there is none. */
function annotateNestedDisplays(form: SchemeValue): SchemeValue {
  if (!(form instanceof APair)) return form;

  if (isDisplayCall(form)) {
    const arg = displayArg(form);
    if (arg !== undefined) {
      // Capture the source of THIS call before rewriting its argument, so the echo shows what the
      // model actually wrote.
      const src = writeForm(form);
      const inner = annotateNestedDisplays(arg);
      return new APair(
        new ASymbol(DISPLAY_INTERNAL),
        new APair(inner, new APair(new AString(src), nil)),
      ) as SchemeValue;
    }
    // A shape we do not understand: leave it exactly as written and let it fail honestly.
    return form;
  }

  const car = annotateNestedDisplays(form.car);
  const cdr = annotateNestedDisplays(form.cdr);
  if (car === form.car && cdr === form.cdr) return form; // nothing changed — share the subtree
  return new APair(car, cdr) as SchemeValue;
}

/**
 * The bound verb: IDENTITY + a side effect. It returns its argument untouched — so
 * `(f (display x))` behaves exactly as `(f x)` — and records what it saw on the run's display
 * channel (`RunContext.display`, the same per-run seam `notes`/`cache`/`effects` ride, so one run's
 * display can never surface in another).
 *
 * It writes NOTHING. There is no IO here and there is no port. The value flows on; the runner
 * renders the echo beside the answer afterwards. Arrival's purity law is intact — a host affordance,
 * not a language feature.
 */
export function displaySymbol(): SymbolDeclaration {
  return symbol.native`${DISPLAY_INTERNAL}: identity — records its argument for the host to echo`(
    { input: [z.schemeValue, z.string], output: [z.schemeValue] },
    function (this: CallCtx, value, src) {
      this.runCtx.display?.push({ src: String(src.valueOf()), value });
      return value;
    },
  );
}
