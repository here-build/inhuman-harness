/**
 * Behavior is an Arrival capability, not a second interpreter.
 *
 * Author-facing names are macros. Each expands to a contour native, and the
 * native `toJS`s handler lambdas outside a Rosetta region so the wrapper stays
 * detached after load. A JS callback passed into that wrapper is reverse
 * Rosetta. The live call context rides AsyncLocalStorage: a detached call
 * uses Arrival's constant run, which has no capability configuration.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import {
  EnvCapability,
  exec,
  isSchemeValue,
  jsToScheme,
  LexicalScope,
  parse,
  toJS as schemeToJs,
  type SchemeValue,
} from "@here.build/arrival";
import { schemaCapability } from "@here.build/arrival/capabilities/schema";
import { CONSTANT_CTX } from "@here.build/arrival/host-internals";
import { APair, AString, ASymbol, nil, schemeFalse } from "@here.build/arrival/reflect-internals";
import { isOptionalTag, stripOptionalSuffix, tagToJsonSchema } from "@here.build/arrival/schema-tag";

import { jsToVal, plain, sliceForm, valToScheme } from "./crossing.js";
import { PluginSurfaceError } from "./surface-error.js";
import { Dict, Lambda, Refusal, SchemaV, asString, type Ctx, type Frame, type Val } from "./value.js";

export const behaviorAls = new AsyncLocalStorage<Ctx>();

const sourceText = new WeakMap<object, string>();

export function stampForms(forms: readonly unknown[], text: string): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    sourceText.set(value, text);
    if (value instanceof APair) {
      walk(value.car);
      walk(value.cdr);
    }
  };
  for (const form of forms) walk(form);
}

export function behaviorPrelude(names: readonly string[]): string {
  const lines = ["(define configuration (behavior/configuration))"];
  for (const name of names) {
    PluginSurfaceError.invariant(/^[\w!$%&*+./:<=>?^~-]+$/u.test(name), `unbound ${name}`);
    lines.push(`(define (${name} . args) (behavior/env-call ${JSON.stringify(name)} args))`);
  }
  return lines.join("\n");
}

export const behaviorCapability = EnvCapability.define("behavior", {
  /** Arrival s/* tagged lists. Input and output schemas are that vocabulary. */
  deps: [schemaCapability],
  symbols: (symbol, sz) => ({
    "define/tool": symbol.macro`define/tool`((code) => expandTool(itemsOf(code))),
    "define/reducer": symbol.macro`define/reducer`((code) => expandReducer(itemsOf(code))),
    "define/method": symbol.macro`define/method`((code) => expandMethod(itemsOf(code))),
    "hook/round": symbol.macro`hook/round`((code) => expandHook(itemsOf(code))),
    "call/method": symbol.macro`call/method`((code) => expandCall(itemsOf(code))),
    "self/notify": symbol.macro`self/notify`((code) => expandNotify(itemsOf(code))),
    "exam/capture": symbol.macro`exam/capture`((code) =>
      expandUnary("behavior/exam-capture", itemsOf(code), "exam/capture"),
    ),
    "exam/apply": symbol.macro`exam/apply`((code) => expandUnary("behavior/exam-apply", itemsOf(code), "exam/apply")),
    "state/propose": symbol.macro`state/propose`((code) =>
      expandUnary("behavior/propose", itemsOf(code), "state/propose"),
    ),
    refuse: symbol.macro`refuse`((code) => expandUnary("behavior/refuse", itemsOf(code), "refuse")),
    "dict-put": symbol.macro`dict-put`((code) => {
      const items = itemsOf(code);
      PluginSurfaceError.invariant(items.length === 3, "dict-put");
      return formCall("behavior/dict-put", items);
    }),
    "behavior/configuration": symbol.native`behavior/configuration`({ input: [], output: [sz.schemeValue] }, () =>
      dataOf(registerCtx("configuration").config),
    ),
    "behavior/env-call": symbol.native`behavior/env-call`(
      { input: [sz.schemeValue, sz.schemeValue], output: [sz.schemeValue] },
      function (name: unknown, args: unknown) {
        const ctx = liveCtx("environment");
        const key = asString(jsToVal(plain(name)), "environment");
        const proc = ctx.environment.get(key);
        PluginSurfaceError.invariant(proc != null, `unbound ${key}`);
        const list = jsToVal(plain(args));
        const values = Array.isArray(list) ? list : [];
        return dataOf(proc.call(values, new Map(), frameOf(ctx)));
      },
    ),
    "behavior/register-tool": symbol.native`behavior/register-tool`(
      {
        input: Array.from({ length: 14 }, () => sz.schemeValue),
        output: [sz.boolean],
      },
      function (...args: unknown[]) {
        registerTool(args);
        return schemeFalse;
      },
    ),
    "behavior/register-hook": symbol.native`behavior/register-hook`(
      {
        input: Array.from({ length: 10 }, () => sz.schemeValue),
        output: [sz.boolean],
      },
      function (...args: unknown[]) {
        registerHook(args);
        return schemeFalse;
      },
    ),
    "behavior/register-reducer": symbol.native`behavior/register-reducer`(
      {
        input: Array.from({ length: 6 }, () => sz.schemeValue),
        output: [sz.boolean],
      },
      function (...args: unknown[]) {
        registerReducer(args);
        return schemeFalse;
      },
    ),
    "behavior/register-method": symbol.native`behavior/register-method`(
      {
        input: Array.from({ length: 7 }, () => sz.schemeValue),
        output: [sz.boolean],
      },
      function (...args: unknown[]) {
        registerMethod(args);
        return schemeFalse;
      },
    ),
    "behavior/exam-capture": symbol.native`behavior/exam-capture`(
      { input: [sz.schemeValue], output: [sz.schemeValue] },
      async function (program: unknown) {
        const source = asString(jsToVal(plain(program)), "exam program");
        return jsToScheme(this.runCtx, await captureExam(source));
      },
    ),
    "behavior/exam-call": symbol.native`behavior/exam-call`(
      { input: [sz.schemeValue, sz.schemeValue], output: [sz.schemeValue] },
      async function (name: unknown, args: unknown) {
        const ctx = liveCtx("exam/call");
        const key = typeof name === "string" ? name : asString(jsToVal(plain(name)), "exam binding");
        const proc = ctx.registry.environment.get(key);
        PluginSurfaceError.invariant(proc != null, `exam environment lacks ${key}`);
        const list = jsToVal(plain(args));
        const values = Array.isArray(list) ? list : [];
        const result = proc.call(values, new Map(), frameOf(ctx)) as Val | Promise<Val>;
        return dataOf(await result);
      },
    ),
    "behavior/exam-apply": symbol.native`behavior/exam-apply`(
      { input: [sz.schemeValue], output: [sz.schemeValue] },
      async function (source: unknown) {
        const text = asString(jsToVal(plain(source)), "exam lambda");
        return dataOf(await applyExam(text, liveCtx("exam/apply")));
      },
    ),
    "behavior/propose": symbol.native`behavior/propose`(
      { input: [sz.schemeValue], output: [sz.boolean] },
      function (action: unknown) {
        const ctx = liveCtx("state/propose");
        PluginSurfaceError.invariant(!(ctx.mode === "pure" || ctx.proposals == null), "reducer cannot propose");
        ctx.proposals.push(jsToVal(plain(action)));
        return schemeFalse;
      },
    ),
    "behavior/refuse": symbol.native`behavior/refuse`(
      { input: [sz.schemeValue], output: [sz.schemeValue] },
      function (message: unknown) {
        return dataOf(new Refusal(asString(jsToVal(plain(message)), "refuse")));
      },
    ),
    "behavior/call-method": symbol.native`behavior/call-method`(
      {
        input: [sz.schemeValue, sz.schemeValue, sz.schemeValue],
        output: [sz.schemeValue],
      },
      async function (receiver: unknown, method: unknown, kwargs: unknown) {
        const ctx = liveCtx("call/method");
        PluginSurfaceError.invariant(!(ctx.mode === "pure" || ctx.onMethod == null), "no method destination");
        const args = jsToVal(plain(kwargs));
        PluginSurfaceError.invariant(args instanceof Dict, "call/method keywords");
        return dataOf(
          await ctx.onMethod(
            nameOf(receiver, "receiver"),
            nameOf(method, "method"),
            new Map(Object.entries(args.entries)),
          ),
        );
      },
    ),
    "behavior/notify": symbol.native`behavior/notify`(
      {
        input: [sz.schemeValue, sz.schemeValue, sz.schemeValue],
        output: [sz.boolean],
      },
      function (count: unknown, first: unknown, second: unknown) {
        notify(count, first, second);
        return schemeFalse;
      },
    ),
    "behavior/dict-put": symbol.native`behavior/dict-put`(
      {
        input: [sz.schemeValue, sz.schemeValue, sz.schemeValue],
        output: [sz.schemeValue],
      },
      function (base: unknown, key: unknown, value: unknown) {
        const record = jsToVal(plain(base));
        PluginSurfaceError.invariant(record instanceof Dict, "dict-put");
        return dataOf(
          new Dict({
            ...record.entries,
            [asString(jsToVal(plain(key)), "key")]: jsToVal(plain(value)),
          }),
        );
      },
    ),
  }),
});

function registerCtx(what: string): Ctx {
  const ctx = behaviorAls.getStore();
  PluginSurfaceError.invariant(ctx?.mode === "register", `callback-time registration: ${what}`);
  return ctx;
}

function liveCtx(what: string): Ctx {
  const ctx = behaviorAls.getStore();
  PluginSurfaceError.invariant(ctx != null, `${what} outside a behavior run`);
  return ctx;
}

function itemsOf(value: unknown): unknown[] {
  const items: unknown[] = [];
  let cursor: unknown = value;
  while (cursor instanceof APair) {
    items.push(cursor.car);
    cursor = cursor.cdr;
  }
  PluginSurfaceError.invariant(cursor === nil, "improper list");
  return items;
}

function keywordOf(value: unknown): string | null {
  if (!(value instanceof ASymbol)) return null;
  const name = value.__name__;
  if (typeof name !== "string" || !name.startsWith(":")) return null;
  return name.slice(1);
}

function splitKeywords(
  forms: readonly unknown[],
  allowed: readonly string[],
): { positional: unknown[]; kw: Map<string, unknown> } {
  const positional: unknown[] = [];
  const kw = new Map<string, unknown>();
  for (let index = 0; index < forms.length; index += 1) {
    const key = keywordOf(forms[index]);
    if (key == null) {
      positional.push(forms[index]);
      continue;
    }
    PluginSurfaceError.invariant(allowed.includes(key), `unknown keyword :${key}`);
    const value = forms[index + 1];
    PluginSurfaceError.invariant(!(value == null || keywordOf(value) != null), `keyword :${key} needs a value`);
    PluginSurfaceError.invariant(!kw.has(key), `duplicate keyword :${key}`);
    kw.set(key, value);
    index += 1;
  }
  return { positional, kw };
}

function formCall(head: string, args: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  let tail: SchemeValue = nil;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    tail = new APair(args[index] as SchemeValue, tail);
  }
  return new APair(new ASymbol(head), tail);
}

function countForm(count: number): SchemeValue {
  return jsToScheme(CONSTANT_CTX, count) as SchemeValue;
}

function formSource(form: unknown): string {
  const text =
    (typeof form === "object" && form !== null ? sourceText.get(form) : undefined) ??
    behaviorAls.getStore()?.sourceText ??
    "";
  const offset = (form as { location?: { offset?: number } } | null)?.location?.offset;
  if (text === "" || typeof offset !== "number") return "";
  return sliceForm(text, offset);
}

function quotedSource(form: unknown): AString {
  return new AString(formSource(form));
}

function expandTool(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  registerCtx("define/tool");
  const { positional, kw } = splitKeywords(forms, [
    "description",
    "expose",
    "input",
    "handler",
    "class",
    "reentrant-depth",
    "triggers-react-loop",
    "is-side-channel",
    "representation",
    "question",
    "effect",
    "caption",
  ]);
  PluginSurfaceError.invariant(positional.length === 1, "define/tool needs a name");
  const handler = kw.get("handler");
  PluginSurfaceError.invariant(handler != null, "define/tool requires :handler");
  return formCall("behavior/register-tool", [
    positional[0],
    kw.get("description") ?? schemeFalse,
    kw.get("expose") ?? schemeFalse,
    kw.get("input") ?? schemeFalse,
    handler,
    kw.get("reentrant-depth") ?? schemeFalse,
    quotedSource(handler),
    kw.get("class") ?? schemeFalse,
    kw.has("triggers-react-loop") ? formCall("list", [kw.get("triggers-react-loop")]) : schemeFalse,
    kw.get("question") ?? schemeFalse,
    kw.get("effect") ?? schemeFalse,
    kw.get("caption") ?? schemeFalse,
    kw.get("representation") ?? schemeFalse,
    kw.get("is-side-channel") ?? schemeFalse,
  ]);
}

function expandHook(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  registerCtx("hook");
  const { positional, kw } = splitKeywords(forms, ["pre", "post", "post-fail", "reentrant-depth"]);
  PluginSurfaceError.invariant(
    kw.get("pre") != null || kw.get("post") != null || kw.get("post-fail") != null,
    "hook requires a position",
  );
  PluginSurfaceError.invariant(positional.length <= 1, "too many positional arguments");
  const pre = kw.get("pre");
  const post = kw.get("post");
  const postFail = kw.get("post-fail");
  return formCall("behavior/register-hook", [
    new AString("round"),
    positional[0] ?? formCall("list", []),
    pre ?? schemeFalse,
    pre == null ? schemeFalse : quotedSource(pre),
    post ?? schemeFalse,
    post == null ? schemeFalse : quotedSource(post),
    postFail ?? schemeFalse,
    postFail == null ? schemeFalse : quotedSource(postFail),
    kw.get("reentrant-depth") ?? schemeFalse,
  ]);
}

function expandReducer(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  registerCtx("define/reducer");
  const { positional, kw } = splitKeywords(forms, ["initial", "reduce", "host-only"]);
  PluginSurfaceError.invariant(positional.length <= 0, "define/reducer takes keywords");
  const initial = kw.get("initial");
  const reduce = kw.get("reduce");
  PluginSurfaceError.invariant(!(initial == null || reduce == null), "reducer requires :initial and :reduce");
  const hostOnly = kw.get("host-only");
  return formCall("behavior/register-reducer", [
    initial,
    quotedSource(initial),
    reduce,
    quotedSource(reduce),
    hostOnly ?? schemeFalse,
    hostOnly == null ? schemeFalse : quotedSource(hostOnly),
  ]);
}

function expandMethod(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  registerCtx("define/method");
  const { positional, kw } = splitKeywords(forms, ["kind", "input", "output", "handler", "reentrant-depth"]);
  PluginSurfaceError.invariant(positional.length === 1, "define/method needs a name");
  return formCall("behavior/register-method", [
    positional[0],
    kw.get("kind") ?? schemeFalse,
    kw.get("input") ?? schemeFalse,
    kw.get("output") ?? schemeFalse,
    kw.get("handler") ?? schemeFalse,
    kw.get("reentrant-depth") ?? schemeFalse,
    kw.get("handler") == null ? schemeFalse : quotedSource(kw.get("handler")),
  ]);
}

function expandCall(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  const { positional, kw } = splitKeywords(
    forms,
    forms.flatMap((item) => {
      const key = keywordOf(item);
      return key == null ? [] : [key];
    }),
  );
  PluginSurfaceError.invariant(positional.length === 2, "call/method");
  const dictArgs: unknown[] = [];
  for (const [key, value] of kw) {
    dictArgs.push(new ASymbol(`:${key}`), value);
  }
  return formCall("behavior/call-method", [positional[0], positional[1], formCall("dict", dictArgs)]);
}

function expandNotify(forms: readonly unknown[]): APair<SchemeValue, SchemeValue> {
  PluginSurfaceError.invariant(forms.length === 1 || forms.length === 2, "self/notify");
  return formCall("behavior/notify", [countForm(forms.length), forms[0], forms[1] ?? schemeFalse]);
}

/** Names the exam calls but does not close over. Validate binds them at apply. */
const STAMP_PORT = "tasks/write-completion-verdict";
const WORLD_PORTS = new Set([
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "fff_search",
  "shell",
  "agent/ask",
  "tool/call",
  "mcp/call",
]);
const EXAM_PORTS = new Set([...WORLD_PORTS, STAMP_PORT]);

/**
 * `buildWireframe` loops on `begin` and egresses only the last top-level form.
 * Flatten every begin and stitch one lambda so none of those forms are discarded.
 * The string is what the page stores and what `exam/apply` parses back.
 */
async function captureExam(source: string): Promise<string> {
  const { buildWireframe } = await import("@here.build/arrival/provenance");
  const parsed = await parse(source, "exam.scm");
  const forms = flattenExamForms((Array.isArray(parsed) ? parsed : [parsed]) as SchemeValue[]);
  PluginSurfaceError.invariant(forms.length > 0, "exam program is empty");
  const only = forms[0];
  if (forms.length === 1) return closedForm(buildWireframe, only);
  const params: string[] = [];
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const form of forms) {
    const part = splitLambda(closedForm(buildWireframe, form));
    for (const name of part.params) {
      if (seen.has(name)) continue;
      seen.add(name);
      params.push(name);
    }
    bodies.push(part.body);
  }
  return `(lambda (${params.join(" ")}) ${bodies.join(" ")})`;
}

type WireBuilder = typeof import("@here.build/arrival/provenance").buildWireframe;

function closedForm(buildWireframe: WireBuilder, form: SchemeValue): string {
  const wire = buildWireframe([form], {
    classifier: { roleOf: () => undefined },
    isBaseName: (name: string) => !EXAM_PORTS.has(name),
  });
  const out = wire.main.egress;
  PluginSurfaceError.invariant(out != null, "exam program has no value");
  const feeding = wire.main.wires.find((edge) => edge.consumer.node === out);
  PluginSurfaceError.invariant(feeding != null, "exam program has no lambda");
  return feeding.source;
}

function flattenExamForms(forms: readonly SchemeValue[]): SchemeValue[] {
  const out: SchemeValue[] = [];
  const walk = (form: SchemeValue): void => {
    if (!(form instanceof APair) || !(form.car instanceof ASymbol) || form.car.__name__ !== "begin") {
      out.push(form);
      return;
    }
    let cursor: unknown = form.cdr;
    while (cursor instanceof APair) {
      walk(cursor.car as SchemeValue);
      cursor = cursor.cdr;
    }
    PluginSurfaceError.invariant(cursor === nil, "improper list");
  };
  for (const form of forms) walk(form);
  return out;
}

function splitLambda(source: string): { params: string[]; body: string } {
  const matched = /^\(lambda \(([^)]*)\) ([\s\S]*)\)$/u.exec(source);
  PluginSurfaceError.invariant(matched != null, "exam program has no lambda");
  const raw = matched[1];
  return { params: raw === "" ? [] : raw.split(" "), body: matched[2] };
}

/** Parameter names of a captured `(lambda (name …) body)`, in order. */
function lambdaParams(source: string, form: SchemeValue): string[] {
  const items = itemsOf(form);
  const head = items[0];
  PluginSurfaceError.invariant(head instanceof ASymbol && head.__name__ === "lambda", "exam lambda is not a lambda");
  const params = items[1];
  return itemsOf(params).map((item) => {
    PluginSurfaceError.invariant(
      item instanceof ASymbol && typeof item.__name__ === "string",
      `exam lambda parameter in ${source}`,
    );
    return item.__name__;
  });
}

/**
 * Parse a stored exam lambda and run it. Every parameter is supplied from the
 * environment of this call. Nothing is closed over from the capture.
 */
async function applyExam(source: string, ctx: Ctx): Promise<Val> {
  const parsed = await parse(source, "exam-lambda.scm");
  const form = (Array.isArray(parsed) ? parsed[0] : parsed) as SchemeValue;
  const params = lambdaParams(source, form);
  const unbound = params.filter((name) => !ctx.registry.environment.has(name));
  PluginSurfaceError.invariant(unbound.length <= 0, `exam environment lacks ${unbound.join(", ")}`);
  const forms = await parse(`(${source} ${params.join(" ")})`, "exam-lambda.scm");
  const scope = LexicalScope.fresh("exam");
  const prelude = params
    .map((name) => `(define (${name} . args) (behavior/exam-call ${JSON.stringify(name)} args))`)
    .join("\n");
  return behaviorAls.run(ctx, async () => {
    await exec(prelude, { capabilities: [behaviorCapability], scope });
    const value = await exec("", {
      capabilities: [behaviorCapability],
      scope,
      program: { forms: forms as readonly SchemeValue[], source, strict: false },
    });
    const list = Array.isArray(value) ? value : [value];
    return jsToVal(list[list.length - 1]);
  });
}

function expandUnary(head: string, forms: readonly unknown[], what: string): APair<SchemeValue, SchemeValue> {
  PluginSurfaceError.invariant(forms.length === 1, `${what}`);
  return formCall(head, [forms[0]]);
}

function registerTool(args: readonly unknown[]): void {
  const ctx = registerCtx("define/tool");
  const [
    name,
    description,
    expose,
    input,
    handler,
    depth,
    source,
    toolClass,
    triggers,
    question,
    effect,
    caption,
    representation,
    sideChannel,
  ] = args;
  const id = token(name);
  PluginSurfaceError.invariant(id != null, "tool name must be a symbol");
  const exposeName = missing(expose) ? "procedure" : token(expose);
  PluginSurfaceError.invariant(
    exposeName === "procedure" || exposeName === "tool" || exposeName === "both",
    ":expose must be procedure, tool, or both",
  );
  const descriptionText = missing(description) ? "" : asString(jsToVal(plain(description)), "description");
  const schema = missing(input) ? null : schemaFrom(input, ":input");
  PluginSurfaceError.invariant(
    !((exposeName === "tool" || exposeName === "both") && (descriptionText.trim() === "" || schema == null)),
    "exposed tool requires :description and :input",
  );
  PluginSurfaceError.invariant(!ctx.registry.tools.has(id), `duplicate tool ${id}`);
  const className = missing(toolClass) ? "" : token(toolClass);
  PluginSurfaceError.invariant(className != null, ":class");
  const decl: import("./value.js").ToolDecl = {
    name: id,
    expose: exposeName,
    description: descriptionText,
    toolClass: className,
    question: faceOf(question),
    effect: faceOf(effect),
    caption: faceOf(caption),
    triggersReactLoop: triggersOf(triggers),
    isSideChannel: sideChannelOf(sideChannel),
    representation: representationOf(representation),
    input: schema,
    handler: asLambda(handler, "define/tool handler", textOf(source)),
    reentrantDepth: depthOf(depth),
    declarationId: `tool:${id}`,
  };
  ctx.registry.tools.set(id, decl);
}

function registerHook(args: readonly unknown[]): void {
  const ctx = registerCtx("hook");
  const [point, matchers, pre, preSource, post, postSource, postFail, postFailSource, depth] = args;
  const name = textOf(point);
  PluginSurfaceError.invariant(name === "round", `unknown hook ${name}`);
  const preLambda = optionalLambda(pre, ":pre", textOf(preSource));
  const postLambda = optionalLambda(post, ":post", textOf(postSource));
  const failLambda = optionalLambda(postFail, ":post-fail", textOf(postFailSource));
  PluginSurfaceError.invariant(
    preLambda != null || postLambda != null || failLambda != null,
    "hook requires a position",
  );
  ctx.registry.hooks.push({
    point: "round",
    matchers: missing(matchers) ? [] : stringList(matchers, "matchers"),
    pre: preLambda,
    post: postLambda,
    postFail: failLambda,
    reentrantDepth: depthOf(depth),
    declarationId: `hook:${name}:${ctx.registry.hooks.length}`,
  });
}

function registerReducer(args: readonly unknown[]): void {
  const ctx = registerCtx("define/reducer");
  PluginSurfaceError.invariant(ctx.registry.reducer == null, "multiple reducers");
  const [initial, initialSource, reduce, reduceSource, hostOnly, hostSource] = args;
  const host = missing(hostOnly) ? null : asLambda(hostOnly, ":host-only", textOf(hostSource));
  ctx.registry.reducer = {
    initial: asLambda(initial, ":initial", textOf(initialSource)),
    reduce: asLambda(reduce, ":reduce", textOf(reduceSource)),
    hostOnly: host,
  };
}

function registerMethod(args: readonly unknown[]): void {
  const ctx = registerCtx("define/method");
  const [name, kind, input, output, handler, depth, source] = args;
  const id = token(name);
  PluginSurfaceError.invariant(id != null, "method name");
  const kindName = token(kind);
  PluginSurfaceError.invariant(
    kindName === "query" || kindName === "mutation" || kindName === "command",
    "method :kind must be query or mutation",
  );
  PluginSurfaceError.invariant(
    !(missing(input) || missing(output) || missing(handler)),
    "method requires :input, :output, and :handler",
  );
  PluginSurfaceError.invariant(!ctx.registry.methods.has(id), `duplicate method ${id}`);
  const decl: import("./value.js").MethodDecl = {
    name: id,
    kind: kindName === "command" ? "mutation" : kindName,
    input: schemaFrom(input, ":input"),
    output: schemaFrom(output, ":output"),
    handler: asLambda(handler, "method handler", textOf(source)),
    reentrantDepth: depthOf(depth),
  };
  ctx.registry.methods.set(id, decl);
}

function notify(count: unknown, first: unknown, second: unknown): void {
  const ctx = liveCtx("self/notify");
  const arity = plain(count);
  if (arity === 1) {
    const message = jsToVal(plain(first));
    PluginSurfaceError.invariant(typeof message === "string", "self/notify message must be a string");
    ctx.originAtoms.push(message);
    ctx.notify?.("origin", message, ctx.boundary);
    return;
  }
  const mode = token(first);
  const message = jsToVal(plain(second));
  PluginSurfaceError.invariant(mode === "ambient" || mode === "activating", "self/notify mode");
  PluginSurfaceError.invariant(ctx.notify != null, "no notification destination");
  PluginSurfaceError.invariant(mode !== "activating" || ctx.boundary !== "turn-end", "activating at turn end");
  PluginSurfaceError.invariant(
    mode !== "activating" || (typeof message === "string" && message.trim() !== ""),
    "activating requires a message",
  );
  PluginSurfaceError.invariant(mode !== "activating" || !ctx.cancelled, "canceled work is not reactivated");
  ctx.notify(mode, typeof message === "string" ? message : "", ctx.boundary);
}

function schemaFrom(value: unknown, what: string): SchemaV {
  return schemaOfTag(plain(value), what);
}

function schemaOfTag(tag: unknown, what: string): SchemaV {
  if (isOptionalTag(tag)) {
    const inner = schemaOfTag(stripOptionalSuffix(tag), what);
    return new SchemaV(inner.json, inner.check, true);
  }
  if (typeof tag === "string") return scalarSchema(tag, what);
  PluginSurfaceError.invariant(Array.isArray(tag) && typeof tag[0] === "string", `${what} must be a schema`);
  const [kind, ...rest] = tag;
  if (kind === "object") {
    const fields: Record<string, SchemaV> = {};
    for (const field of rest) {
      PluginSurfaceError.invariant(
        Array.isArray(field) && (field.length === 2 || field.length === 3) && typeof field[0] === "string",
        `${what} must be a schema`,
      );
      fields[field[0]] = schemaOfTag(field[1], what);
    }
    const built = objectSchema(fields);
    return new SchemaV(tagToJsonSchema(tag), built.check);
  }
  if (kind === "array") {
    const element = rest[0];
    PluginSurfaceError.invariant(element !== undefined, `${what} must be a schema`);
    const item = schemaOfTag(element, what);
    return new SchemaV(tagToJsonSchema(tag), (value) => {
      if (!Array.isArray(value)) return "expected array";
      for (const entry of value) {
        const issue = item.check(entry);
        if (issue != null) return issue;
      }
      return null;
    });
  }
  if (kind === "enum") {
    return new SchemaV(tagToJsonSchema(tag), (value) => (rest.includes(value) ? null : "expected enum"));
  }
  PluginSurfaceError.invariant(false, `${what} must be a schema`);
}

function scalarSchema(tag: string, what: string): SchemaV {
  if (tag === "string") {
    return new SchemaV({ type: "string" }, (value) => (typeof value === "string" ? null : "expected string"));
  }
  if (tag === "number") {
    return new SchemaV({ type: "number" }, (value) => (typeof value === "number" ? null : "expected number"));
  }
  if (tag === "integer") {
    return new SchemaV({ type: "integer" }, (value) =>
      typeof value === "number" && Number.isInteger(value) ? null : "expected integer",
    );
  }
  if (tag === "boolean") {
    return new SchemaV({ type: "boolean" }, (value) => (typeof value === "boolean" ? null : "expected boolean"));
  }
  PluginSurfaceError.invariant(false, `${what} must be a schema`);
}

function objectSchema(fields: Readonly<Record<string, SchemaV>>): SchemaV {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.json]));
  const required = Object.entries(fields)
    .filter(([, field]) => !field.optional)
    .map(([key]) => key);
  const json = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  return new SchemaV(json, (value) => {
    if (!(value instanceof Dict)) return "expected object";
    for (const [key, schemaValue] of Object.entries(fields)) {
      if (!(key in value.entries)) {
        if (schemaValue.optional) continue;
        return `missing ${key}`;
      }
      const issue = schemaValue.check(value.entries[key] ?? false);
      if (issue != null) return issue;
    }
    for (const key of Object.keys(value.entries)) {
      if (!(key in fields)) return `unknown field ${key}`;
    }
    return null;
  });
}

function asLambda(value: unknown, what: string, source: string): Lambda {
  const fn = isSchemeValue(value) ? schemeToJs(value as SchemeValue) : value;
  PluginSurfaceError.invariant(typeof fn === "function", `${what} must be a lambda`);
  return new Lambda(fn as (...args: unknown[]) => Promise<unknown>, source);
}

function optionalLambda(value: unknown, what: string, source: string): Lambda | null {
  if (missing(value)) return null;
  return asLambda(value, what, source);
}

function missing(value: unknown): boolean {
  return value === schemeFalse || plain(value) === false;
}

function textOf(value: unknown): string {
  const crossed = plain(value);
  return typeof crossed === "string" ? crossed : "";
}

function token(value: unknown): string | null {
  if (value instanceof ASymbol && typeof value.__name__ === "string") {
    return value.__name__;
  }
  const crossed = plain(value);
  return typeof crossed === "string" ? crossed : null;
}

function nameOf(value: unknown, what: string): string {
  return token(value) ?? asString(jsToVal(plain(value)), what);
}

function depthOf(value: unknown): number {
  if (missing(value)) return 0;
  const number = plain(value);
  PluginSurfaceError.invariant(
    !(typeof number !== "number" || !Number.isInteger(number) || number < 0),
    ":reentrant-depth must be a finite nonnegative integer",
  );
  return number;
}

function faceOf(value: unknown): string | null {
  if (missing(value)) return null;
  const text = asString(jsToVal(plain(value)), "tape face").trim();
  PluginSurfaceError.invariant(text !== "", "tape face must be a non-empty string");
  return text;
}

function representationOf(value: unknown): "tool" | "symbol" | "both" {
  if (missing(value)) return "symbol";
  const name = token(value);
  if (name === "tool" || name === "symbol" || name === "both") return name;
  throw new PluginSurfaceError(":representation must be tool, symbol, or both");
}

function sideChannelOf(value: unknown): boolean {
  if (missing(value)) return false;
  PluginSurfaceError.invariant(plain(value) === true, ":is-side-channel must be #t or #f");
  return true;
}

function triggersOf(value: unknown): boolean {
  if (missing(value)) return true;
  const list = jsToVal(plain(value));
  const flag = Array.isArray(list) ? list[0] : undefined;
  PluginSurfaceError.invariant(typeof flag === "boolean", ":triggers-react-loop must be #t or #f");
  return flag;
}

function stringList(value: unknown, what: string): string[] {
  const list = jsToVal(plain(value));
  PluginSurfaceError.invariant(Array.isArray(list), `${what} must be a list of strings`);
  return list.map((item) => asString(item, what));
}

function dataOf(value: Val): SchemeValue {
  const scheme = valToScheme(value);
  PluginSurfaceError.invariant(typeof scheme !== "function", "procedure is not data");
  return scheme;
}

function frameOf(ctx: Ctx): Frame {
  return { bindings: new Map(), parent: null, ctx };
}
