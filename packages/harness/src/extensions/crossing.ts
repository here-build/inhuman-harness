/**
 * Host values ↔ Arrival. Detached `toJS` lambdas already return plain JS.
 * Lists go back in as pairs so `first` / `rest` keep working; JS arrays are vectors.
 */
import { isSchemeValue, jsToScheme, toJS as schemeToJs, type SchemeValue } from "@here.build/arrival";
import { CONSTANT_CTX } from "@here.build/arrival/host-internals";
import { ADict, APair, AString, ASymbol, nil, schemeFalse, schemeTrue } from "@here.build/arrival/reflect-internals";

import { PluginSurfaceError } from "./surface-error.js";
import { Dict, Marked, Proc, Refusal, Sym, toJS as hostPlain, type Frame, type Val } from "./value.js";

const TAG = "%plugin-surface";

const DUMMY_FRAME: Frame = {
  bindings: new Map(),
  parent: null,
  ctx: null as never,
};

export function unwrapBehaviorError(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (
    current instanceof Error &&
    current.name === "ForeignThrowError" &&
    current.cause instanceof Error &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

export function plain(value: unknown): unknown {
  return isSchemeValue(value) ? schemeToJs(value as SchemeValue) : value;
}

export function jsToVal(value: unknown): Val {
  if (isSchemeValue(value)) return jsToVal(schemeToJs(value as SchemeValue));
  if (value == null) return false;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    return new Proc(
      "crossed",
      (args) => {
        const out = fn(...args.map((arg) => hostPlain(arg)));
        PluginSurfaceError.invariant(!(out instanceof Promise), "crossed procedure is pending");
        return jsToVal(out);
      },
      fn,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => jsToVal(entry));
  if (isPlainObject(value)) {
    const tag = value[TAG];
    if (tag === "refusal" && typeof value.message === "string") {
      return new Refusal(value.message);
    }
    if (tag === "marked" && Array.isArray(value.marks)) {
      return new Marked(jsToVal(value.value), value.marks.map(String));
    }
    const entries: Record<string, Val> = {};
    for (const [key, entry] of Object.entries(value)) {
      entries[key] = jsToVal(entry);
    }
    return new Dict(entries);
  }
  PluginSurfaceError.invariant(false, "value did not cross");
}

export function valToScheme(value: Val): SchemeValue | ((...args: unknown[]) => unknown) {
  if (value === false) return schemeFalse;
  if (value === true) return schemeTrue;
  if (typeof value === "number") {
    return jsToScheme(CONSTANT_CTX, value) as SchemeValue;
  }
  if (typeof value === "string") return new AString(value);
  if (value instanceof Sym) return new ASymbol(value.name);
  if (value instanceof Refusal) {
    return dictScheme({ [TAG]: "refusal", message: value.message });
  }
  if (value instanceof Marked) {
    return dictScheme({
      [TAG]: "marked",
      value: value.value,
      marks: [...value.marks],
    });
  }
  if (value instanceof Dict) return dictScheme(value.entries);
  if (value instanceof Proc) return procHost(value);
  if (Array.isArray(value)) return listScheme(value);
  PluginSurfaceError.invariant(false, "value did not cross");
}

export function sliceForm(text: string, offset: number): string {
  let index = offset;
  while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
  const start = index;
  if (text[index] !== "(") {
    while (index < text.length && !/[\s()]/.test(text[index] ?? "")) index += 1;
    return text.slice(start, index);
  }
  let depth = 0;
  let quote = false;
  let escape = false;
  for (; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === ";") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return text.slice(start);
}

function dictScheme(entries: Readonly<Record<string, Val>>): ADict {
  const pairs: Array<readonly [AString, SchemeValue]> = [];
  for (const [key, entry] of Object.entries(entries)) {
    pairs.push([new AString(key), dataScheme(entry)]);
  }
  return new ADict(pairs);
}

function listScheme(values: readonly Val[]): SchemeValue {
  let tail: SchemeValue = nil;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    tail = new APair(dataScheme(values[index] ?? false), tail);
  }
  return tail;
}

function dataScheme(value: Val): SchemeValue {
  const scheme = valToScheme(value);
  PluginSurfaceError.invariant(typeof scheme !== "function", "procedure is not data");
  return scheme;
}

function procHost(proc: Proc): (...args: unknown[]) => unknown {
  if (proc.hostFn != null) return proc.hostFn;
  return (...args: unknown[]) => {
    const result = proc.call(
      args.map((arg) => jsToVal(arg)),
      new Map(),
      DUMMY_FRAME,
    );
    return valToScheme(result);
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
