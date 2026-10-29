/**
 * scheme_watch reachability: a done-condition the tick can actually run.
 * Quoted / lambda-only mentions do not stop the watch.
 * Token/schema live in harness-model; this file is the Arrival reachability walk.
 */
import { ANil, type SchemeValue } from "@here.build/arrival";
import { ABool, APair, ASymbol, AVector } from "@here.build/arrival/reflect-internals";
import { DONE_CONDITION } from "@inhuman.tools/harness-model";

const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

function carOf(pair: APair<SchemeValue, SchemeValue>): SchemeValue {
  return pair.car as SchemeValue;
}

function cdrOf(pair: APair<SchemeValue, SchemeValue>): SchemeValue | undefined {
  return pair.cdr as SchemeValue | undefined;
}

function symbolName(node: SchemeValue | undefined): string | undefined {
  return node instanceof ASymbol && typeof node.__name__ === "string" ? node.__name__ : undefined;
}

function spine(node: SchemeValue | undefined): SchemeValue[] {
  const items: SchemeValue[] = [];
  const localSeen = new Set<object>();
  let cur: SchemeValue | undefined = node;
  while (cur instanceof APair) {
    if (localSeen.has(cur)) return items;
    localSeen.add(cur);
    items.push(carOf(cur));
    cur = cdrOf(cur);
  }
  return items;
}

function isFalse(node: SchemeValue | undefined): boolean {
  return node instanceof ABool && node.value === false;
}

function isTrue(node: SchemeValue | undefined): boolean {
  return node instanceof ABool && node.value === true;
}

/** True when `(meta-reactivity/done-condition …)` can run if the tick starts. */
export function reachableDoneCondition(forms: readonly SchemeValue[]): boolean {
  const seen = new Set<object>();
  return forms.some((form) => reachable(form, seen));
}

function reachable(node: SchemeValue | undefined, seen: Set<object>): boolean {
  if (node === undefined || node instanceof ANil) return false;
  if (node instanceof AVector) return node.__vector__.some((el) => reachable(el, seen));
  if (!(node instanceof APair)) return false;
  if (seen.has(node)) return false;
  seen.add(node);

  const items = [carOf(node), ...spine(cdrOf(node))];
  const head = items[0];
  const rest = items.slice(1);
  const headName = symbolName(head);

  if (headName === DONE_CONDITION) return true;
  if (headName === "quote") return false;
  if (headName === "quasiquote") return rest.some((el) => unquoteReachable(el, seen));
  if (headName === "lambda" || headName === "λ") return false;

  if (headName === "if") {
    const [pred, then, els] = rest;
    if (reachable(pred, seen)) return true;
    if (isFalse(pred)) return reachable(els, seen);
    if (isTrue(pred)) return reachable(then, seen);
    return reachable(then, seen) || reachable(els, seen);
  }

  if (headName === "when") {
    const [pred, ...body] = rest;
    if (reachable(pred, seen)) return true;
    return isFalse(pred) ? false : body.some((el) => reachable(el, seen));
  }
  if (headName === "unless") {
    const [pred, ...body] = rest;
    if (reachable(pred, seen)) return true;
    return isTrue(pred) ? false : body.some((el) => reachable(el, seen));
  }

  if (headName === "cond") {
    for (const clause of rest) {
      if (!(clause instanceof APair)) continue;
      const parts = [carOf(clause), ...spine(cdrOf(clause))];
      const pred = parts[0];
      const body = parts.slice(1);
      if (symbolName(pred) === "else" || isTrue(pred)) {
        return body.some((el) => reachable(el, seen));
      }
      if (reachable(pred, seen)) return true;
      if (!isFalse(pred) && body.some((el) => reachable(el, seen))) return true;
    }
    return false;
  }

  if (headName !== undefined && LET_FORMS.has(headName)) {
    let idx = 0;
    if (symbolName(rest[0]) !== undefined) idx = 1;
    if (bindingValuesReachable(rest[idx], seen)) return true;
    return rest.slice(idx + 1).some((el) => reachable(el, seen));
  }

  if (headName === "define") {
    const slot = rest[0];
    if (slot instanceof APair) return false;
    return rest.slice(1).some((el) => reachable(el, seen));
  }

  if (headName === "set!") return reachable(rest[1], seen);

  if (head instanceof APair) {
    const op = symbolName(carOf(head));
    if (op === "lambda" || op === "λ") {
      const lam = spine(cdrOf(head));
      if (lam.slice(1).some((el) => reachable(el, seen))) return true;
    }
  }

  return items.some((el) => reachable(el, seen));
}

function unquoteReachable(node: SchemeValue | undefined, seen: Set<object>): boolean {
  if (node instanceof AVector) return node.__vector__.some((el) => unquoteReachable(el, seen));
  if (!(node instanceof APair)) return false;
  const name = symbolName(carOf(node));
  if (name === "unquote" || name === "unquote-splicing") {
    return spine(cdrOf(node)).some((el) => reachable(el, seen));
  }
  return [carOf(node), ...spine(cdrOf(node))].some((el) => unquoteReachable(el, seen));
}

function bindingValuesReachable(bindings: SchemeValue | undefined, seen: Set<object>): boolean {
  const els = bindings instanceof AVector ? [...bindings.__vector__] : spine(bindings);
  for (const el of els) {
    if (!(el instanceof APair)) continue;
    const parts = [carOf(el), ...spine(cdrOf(el))];
    if (parts.slice(1).some((part) => reachable(part, seen))) return true;
  }
  return false;
}
