/**
 * Kind of a Scheme program from the host calls in its reader forms.
 *
 * Arrival's `parse` is async (`reader/parse.ts`), so a computed cannot call
 * it. {@link programKind} is the decision. {@link programKindNow} stays a
 * workflow until that promise settles.
 *
 * Every free host call counts, nested ones included. One action kind is that
 * kind however many calls there are. Mixed kinds are a workflow. No call,
 * or a reader error, is a workflow.
 *
 * `quote` / quasiquote data are not calls. Unquote is. The syntax set is
 * Arrival's `SPECIAL_FORMS` (`eval/evaluator.ts`): a new kernel form counted
 * as a call turns an agent program into a workflow. Names bound by
 * `define` / `let` / `lambda` are not host calls. Macros are not expanded.
 *
 * A command is a catalog tool. Catalog tools bind under their wire name; a
 * name in Arrival's own roster, or any kebab-case or namespaced helper, is
 * Scheme, not a tool.
 */
import { parse, type EnvCapability, type SchemeValue } from "@here.build/arrival";
import { BASE_ROSTER } from "@here.build/arrival/lsp-internals";
import { ADict, APair, ASymbol, AVector } from "@here.build/arrival/reflect-internals";
import type { JobKind } from "@inhuman.tools/plexus-expectations";
import { observable, runInAction } from "mobx";

type ActionKind = "command" | "agent" | "bot";

type Binding = {
  readonly name: string;
  readonly init: SchemeValue;
  readonly step: SchemeValue | undefined;
};

/** Observable so a reader of {@link programKindNow} recomputes when its parse lands. */
const decisions = observable.map<string, JobKind>(undefined, { deep: false });
const pending = new Map<string, Promise<JobKind>>();
/** Oldest decision goes first; a forgotten one re-reads. */
const DECISION_LIMIT = 512;

/** Wire tool names. A catalog tool never spells itself kebab-case or namespaced. */
const WIRE_NAME = /^[a-z]\w*$/i;
const BUILTINS = rosterNames(BASE_ROSTER);

const SYNTAX = new Set([
  "if",
  "begin",
  "quote",
  "quasiquote",
  "define",
  "define-macro",
  "lambda",
  "let",
  "let*",
  "letrec",
  "letrec*",
  "and",
  "or",
  "cond",
  "case",
  "when",
  "unless",
  "do",
  "while",
  "try",
]);

export function programKind(expr: string): Promise<JobKind> {
  const hit = decisions.get(expr);
  if (hit !== undefined) return Promise.resolve(hit);
  const inflight = pending.get(expr);
  if (inflight !== undefined) return inflight;
  const promise = settle(expr);
  pending.set(expr, promise);
  return promise;
}

/** Settled decision for `expr`. Workflow while {@link programKind} is still reading. */
export function programKindNow(expr: string): JobKind {
  return decisions.get(expr) ?? "workflow";
}

async function settle(expr: string): Promise<JobKind> {
  let kind: JobKind;
  try {
    kind = kindOf(await parse(expr));
  } catch {
    kind = "workflow";
  }
  runInAction(() => {
    decisions.set(expr, kind);
    if (decisions.size > DECISION_LIMIT) decisions.delete(decisions.keys().next().value!);
  });
  pending.delete(expr);
  return kind;
}

function rosterNames(roster: readonly EnvCapability[]): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<EnvCapability>();
  const walk = (capability: EnvCapability): void => {
    if (seen.has(capability)) return;
    seen.add(capability);
    for (const dep of capability.deps ?? []) walk(dep);
    for (const name of Object.keys(capability.spec.symbols ?? {})) names.add(name);
  };
  for (const capability of roster) walk(capability);
  return names;
}

function kindOf(forms: readonly SchemeValue[]): JobKind {
  const kinds = new Set<ActionKind>();
  const seen = new WeakSet<object>();
  const env = new Set<string>();
  for (const form of forms) visit(form, env, kinds, seen);
  return onlyKind(kinds);
}

function onlyKind(kinds: ReadonlySet<ActionKind>): JobKind {
  if (kinds.size !== 1) return "workflow";
  if (kinds.has("agent")) return "agent";
  if (kinds.has("bot")) return "bot";
  return "command";
}

function actionOf(name: string): ActionKind | undefined {
  if (name.startsWith("agent/")) return "agent";
  if (name.startsWith("bot/")) return "bot";
  if (name === "mcp/call") return "command";
  // `car`, `cadr`, … are kernel accessors no roster frame binds.
  if (!WIRE_NAME.test(name) || BUILTINS.has(name) || /^c[ad]+r$/.test(name)) return undefined;
  return "command";
}

function record(name: string, env: ReadonlySet<string>, kinds: Set<ActionKind>): void {
  if (name.startsWith(":") || env.has(name)) return;
  const action = actionOf(name);
  if (action !== undefined) kinds.add(action);
}

function visit(node: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (seen.has(node)) return;
  seen.add(node);
  const form = lowered(node);
  if (form !== node) {
    if (seen.has(form)) return;
    seen.add(form);
  }
  if (!(form instanceof APair)) return;
  const name = symbolName(form.car);
  if (name === undefined) {
    visit(form.car, env, kinds, seen);
    visitOperands(form.cdr, env, kinds, seen);
    return;
  }
  if (SYNTAX.has(name)) {
    visitSyntax(name, form.cdr, env, kinds, seen);
    return;
  }
  record(name, env, kinds);
  visitOperands(form.cdr, env, kinds, seen);
}

function visitSyntax(
  name: string,
  rest: SchemeValue,
  env: Set<string>,
  kinds: Set<ActionKind>,
  seen: WeakSet<object>,
): void {
  switch (name) {
    case "quote":
      return;
    case "quasiquote": {
      const body = first(rest);
      if (body !== undefined) visitQuasiquote(body, env, kinds, seen, 1);
      return;
    }
    case "lambda":
      visitLambda(rest, env, kinds, seen);
      return;
    case "define":
    case "define-macro":
      visitDefine(rest, env, kinds, seen);
      return;
    case "let":
    case "let*":
    case "letrec":
    case "letrec*":
      visitLet(name, rest, env, kinds, seen);
      return;
    case "cond":
      visitCond(rest, env, kinds, seen);
      return;
    case "case":
      visitCase(rest, env, kinds, seen);
      return;
    case "do":
      visitDo(rest, env, kinds, seen);
      return;
    case "try":
      visitTry(rest, env, kinds, seen);
      return;
    default:
      visitOperands(rest, env, kinds, seen);
  }
}

function visitLambda(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (!(rest instanceof APair)) return;
  visitOperands(rest.cdr, nested(env, formalsOf(rest.car)), kinds, seen);
}

function visitDefine(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (!(rest instanceof APair)) return;
  const firstForm = rest.car;
  if (firstForm instanceof APair) {
    const name = symbolName(firstForm.car);
    if (name === undefined) return;
    env.add(name);
    visitOperands(rest.cdr, nested(env, formalsOf(firstForm.cdr)), kinds, seen);
    return;
  }
  const name = symbolName(firstForm);
  if (name === undefined) return;
  env.add(name);
  const value = first(rest.cdr);
  if (value !== undefined) visit(value, env, kinds, seen);
}

function visitLet(
  form: string,
  rest: SchemeValue,
  env: Set<string>,
  kinds: Set<ActionKind>,
  seen: WeakSet<object>,
): void {
  if (!(rest instanceof APair)) return;
  let bindingsNode = rest.car;
  let body = rest.cdr;
  const names: string[] = [];
  if (form === "let" && rest.car instanceof ASymbol) {
    const loop = symbolName(rest.car);
    if (loop !== undefined) names.push(loop);
    if (!(rest.cdr instanceof APair)) return;
    bindingsNode = rest.cdr.car;
    body = rest.cdr.cdr;
  }
  const bindings = bindingsOf(bindingsNode);
  for (const binding of bindings) names.push(binding.name);
  if (form === "let*") {
    let scope = env;
    for (const binding of bindings) {
      visit(binding.init, scope, kinds, seen);
      scope = nested(scope, [binding.name]);
    }
    visitOperands(body, scope, kinds, seen);
    return;
  }
  const initEnv = form === "let" ? env : nested(env, names);
  for (const binding of bindings) visit(binding.init, initEnv, kinds, seen);
  visitOperands(body, nested(env, names), kinds, seen);
}

function visitCond(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  each(rest, seen, (clause) => {
    const parts = elements(clause);
    if (parts === undefined || parts.length === 0) return;
    const test = parts[0];
    if (symbolName(test) !== "else") visit(test, env, kinds, seen);
    visitTail(parts.slice(1), env, kinds, seen);
  });
}

function visitCase(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (!(rest instanceof APair)) return;
  visit(rest.car, env, kinds, seen);
  each(rest.cdr, seen, (clause) => {
    const parts = elements(clause);
    if (parts === undefined) return;
    visitTail(parts.slice(1), env, kinds, seen);
  });
}

function visitDo(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (!(rest instanceof APair)) return;
  const bindings = bindingsOf(rest.car);
  for (const binding of bindings) visit(binding.init, env, kinds, seen);
  const scope = nested(
    env,
    bindings.map((binding) => binding.name),
  );
  for (const binding of bindings) {
    if (binding.step !== undefined) visit(binding.step, scope, kinds, seen);
  }
  if (!(rest.cdr instanceof APair)) return;
  const clause = elements(rest.cdr.car);
  if (clause !== undefined && clause.length > 0) {
    visit(clause[0], scope, kinds, seen);
    visitTail(clause.slice(1), scope, kinds, seen);
  }
  visitOperands(rest.cdr.cdr, scope, kinds, seen);
}

function visitTry(rest: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  if (!(rest instanceof APair)) return;
  visit(rest.car, env, kinds, seen);
  each(rest.cdr, seen, (clause) => {
    if (!(clause instanceof APair)) return;
    const head = symbolName(clause.car);
    if (head === "catch" && clause.cdr instanceof APair) {
      visitOperands(clause.cdr.cdr, nested(env, formalsOf(clause.cdr.car)), kinds, seen);
      return;
    }
    if (head === "finally") visitOperands(clause.cdr, env, kinds, seen);
  });
}

function visitTail(
  exprs: readonly SchemeValue[],
  env: Set<string>,
  kinds: Set<ActionKind>,
  seen: WeakSet<object>,
): void {
  if (symbolName(exprs[0]) === "=>") {
    if (exprs.length >= 2) visitApplied(exprs[1], env, kinds, seen);
    return;
  }
  for (const expr of exprs) visit(expr, env, kinds, seen);
}

function visitApplied(node: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  const name = symbolName(node);
  if (name === undefined) {
    visit(node, env, kinds, seen);
    return;
  }
  record(name, env, kinds);
}

function visitQuasiquote(
  node: SchemeValue,
  env: Set<string>,
  kinds: Set<ActionKind>,
  seen: WeakSet<object>,
  level: number,
): void {
  if (seen.has(node)) return;
  seen.add(node);
  if (node instanceof AVector) {
    for (const el of node.__vector__) visitQuasiquote(el, env, kinds, seen, level);
    return;
  }
  if (ADict.isDictLiteral(node)) {
    for (const el of node.literalForms) visitQuasiquote(el, env, kinds, seen, level);
    return;
  }
  if (!(node instanceof APair)) return;
  const name = symbolName(node.car);
  if (name === "quasiquote") {
    const body = first(node.cdr);
    if (body !== undefined) visitQuasiquote(body, env, kinds, seen, level + 1);
    return;
  }
  if (name === "unquote" || name === "unquote-splicing") {
    const body = first(node.cdr);
    if (body === undefined) return;
    if (level === 1) visit(body, env, kinds, seen);
    else visitQuasiquote(body, env, kinds, seen, level - 1);
    return;
  }
  visitQuasiquote(node.car, env, kinds, seen, level);
  visitQuasiquote(node.cdr, env, kinds, seen, level);
}

function visitOperands(node: SchemeValue, env: Set<string>, kinds: Set<ActionKind>, seen: WeakSet<object>): void {
  each(node, seen, (car) => visit(car, env, kinds, seen));
}

function each(node: SchemeValue, seen: WeakSet<object>, visitCar: (car: SchemeValue) => void): void {
  let cursor = node;
  while (cursor instanceof APair) {
    if (seen.has(cursor)) return;
    seen.add(cursor);
    visitCar(cursor.car);
    cursor = cursor.cdr;
  }
}

function lowered(node: SchemeValue): SchemeValue {
  if (!(node instanceof AVector) && !ADict.isDictLiteral(node)) return node;
  const form = node["arrival/tagless-final/lower"]();
  return form instanceof APair ? form : node;
}

function bindingsOf(node: SchemeValue): Binding[] {
  if (node instanceof AVector && node.evalElements) return paired(node.__vector__);
  const out: Binding[] = [];
  const spine = new WeakSet<object>();
  let cursor = node;
  while (cursor instanceof APair) {
    if (spine.has(cursor)) break;
    spine.add(cursor);
    const item = cursor.car;
    const one =
      item instanceof AVector && item.evalElements
        ? bindingFrom(item.__vector__)
        : item instanceof APair
          ? bindingFrom(elements(item) ?? [])
          : undefined;
    if (one !== undefined) out.push(one);
    cursor = cursor.cdr;
  }
  return out;
}

function paired(els: readonly SchemeValue[]): Binding[] {
  const out: Binding[] = [];
  for (let i = 0; i + 1 < els.length; i += 2) {
    const name = symbolName(els[i]);
    const init = els[i + 1];
    if (name !== undefined) out.push({ name, init, step: undefined });
  }
  return out;
}

function bindingFrom(els: readonly SchemeValue[]): Binding | undefined {
  if (els.length < 2) return undefined;
  const name = symbolName(els[0]);
  if (name === undefined) return undefined;
  return { name, init: els[1], step: els[2] };
}

function elements(node: SchemeValue): readonly SchemeValue[] | undefined {
  if (node instanceof AVector && node.evalElements) return node.__vector__;
  if (!(node instanceof APair)) return undefined;
  const out: SchemeValue[] = [];
  const spine = new WeakSet<object>();
  let cursor: SchemeValue = node;
  while (cursor instanceof APair) {
    if (spine.has(cursor)) break;
    spine.add(cursor);
    out.push(cursor.car);
    cursor = cursor.cdr;
  }
  return out;
}

function formalsOf(node: SchemeValue): string[] {
  const names: string[] = [];
  let cursor = node;
  while (cursor instanceof APair) {
    const name = symbolName(cursor.car);
    if (name !== undefined) names.push(name);
    cursor = cursor.cdr;
  }
  const rest = symbolName(cursor);
  if (rest !== undefined) names.push(rest);
  return names;
}

function first(node: SchemeValue): SchemeValue | undefined {
  return node instanceof APair ? node.car : undefined;
}

function nested(env: ReadonlySet<string>, names: readonly string[]): Set<string> {
  const next = new Set(env);
  for (const name of names) next.add(name);
  return next;
}

function symbolName(value: SchemeValue | undefined): string | undefined {
  if (!(value instanceof ASymbol)) return undefined;
  const name = value.valueOf();
  return typeof name === "string" ? name : undefined;
}
