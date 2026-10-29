/**
 * `meta-reactivity/*` list operators. The bag clock is the watchdog tool.
 * `self/notify` and MCP jobs stay with the host that admits them.
 *
 * Arrival's record `inputRest` is all-kwargs (`collectKwargsObject` even-pairs).
 * `(added :identity :id comments)` is a keyword pair plus a trailing positional
 * — that binder cannot express it. Native + a mixed scan is the surface.
 */
import { EnvCapability, type CallCtx, type SchemeValue } from "@here.build/arrival";
import { ABool, ASymbol } from "@here.build/arrival/reflect-internals";
import invariant from "tiny-invariant";
import { z } from "zod";

import { accessKey, type AccessKeyOf } from "./access-key.js";
import { WatchBaseline } from "./baseline.js";
import { diffLists, identifyItems, listItems, schemeList, type ListDiff } from "./diff.js";

/**
 * One baseline per job. Arrival mints a RunContext per form and disposes it
 * with the form; the resource factory returns this same instance, so a period
 * survives the tick. No asyncDispose: that dispose would wipe the period.
 */
const baselines = new WeakMap<object, WatchBaseline>();

export function baselineOf(job: object): WatchBaseline {
  const existing = baselines.get(job);
  if (existing !== undefined) return existing;
  const created = new WatchBaseline();
  baselines.set(job, created);
  return created;
}

function isJob(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isKeyOf(value: unknown): value is AccessKeyOf {
  return typeof value === "function";
}

function begin(job: object): void {
  baselineOf(job).resetPeriod();
}

function abandon(job: object): void {
  baselineOf(job).abandon();
}

function commit(job: object): { readonly done: boolean; readonly result: SchemeValue | undefined } {
  const baseline = baselineOf(job);
  baseline.commit();
  return { done: baseline.doneRequested, result: baseline.doneResult };
}

function keywordName(value: unknown): string | undefined {
  if (!(value instanceof ASymbol)) return undefined;
  if (typeof value["arrival/tagless-final/apply"] !== "function") return undefined;
  return String(value.valueOf()).replace(/^:/, "");
}

function parseListAndIdentity(args: readonly SchemeValue[]): {
  list: SchemeValue;
  identity: SchemeValue | undefined;
} {
  let list: SchemeValue | undefined;
  let identity: SchemeValue | undefined;
  for (let i = 0; i < args.length;) {
    const name = keywordName(args[i]);
    if (name !== undefined) {
      invariant(i + 1 < args.length, "meta-reactivity: dangling keyword");
      invariant(name === "identity", `meta-reactivity: unknown keyword :${name}`);
      invariant(identity === undefined, "meta-reactivity: duplicate :identity");
      identity = args[i + 1];
      i += 2;
      continue;
    }
    invariant(list === undefined, "meta-reactivity: expected one list argument");
    list = args[i];
    i += 1;
  }
  invariant(list !== undefined, "meta-reactivity: expected one list argument");
  return { list, identity };
}

function schemeHolds(value: unknown): boolean {
  if (value === false || value === null) return false;
  if (value instanceof ABool) return value.value === true;
  return true;
}

type Activation = CallCtx & {
  readonly configuration: { readonly keyOf?: AccessKeyOf };
  readonly resources: WatchBaseline;
};

async function observeDiff(ctx: Activation, args: readonly SchemeValue[]): Promise<ListDiff> {
  const baseline = ctx.resources;
  invariant(baseline instanceof WatchBaseline, "meta-reactivity: baseline is not configured");
  const { list, identity } = parseListAndIdentity(args);
  const key = accessKey(list, ctx.configuration.keyOf);
  const nextItems = listItems(ctx.runCtx, list);
  const prevItems = baseline.peek(key);
  baseline.observe(key, nextItems);
  const next = await identifyItems(nextItems, identity, ctx);
  const prev = prevItems === undefined ? undefined : await identifyItems(prevItems, identity, ctx);
  return diffLists(prev, next);
}

export const metaReactivityCapability = Object.assign(
  EnvCapability.define("meta-reactivity", {
    configuration: {
      job: z.custom<object>(isJob),
      keyOf: z.custom<AccessKeyOf>(isKeyOf).optional(),
    },
    resources: (config) => {
      invariant(isJob(config.job), "meta-reactivity: job is not configured");
      return baselineOf(config.job);
    },
    symbols: (symbol, sz) => ({
      "meta-reactivity/added": symbol.native`meta-reactivity/added: items whose identity is new at this access`(
        {
          input: [],
          inputRest: sz.schemeValue,
          output: [sz.schemeValue],
          provenance: "pipe",
        },
        async function (...args: SchemeValue[]) {
          const diff = await observeDiff(this, args);
          return schemeList(this.runCtx, diff.added);
        },
      ),
      "meta-reactivity/removed": symbol.native`meta-reactivity/removed: items whose identity left this access`(
        {
          input: [],
          inputRest: sz.schemeValue,
          output: [sz.schemeValue],
          provenance: "pipe",
        },
        async function (...args: SchemeValue[]) {
          const diff = await observeDiff(this, args);
          return schemeList(this.runCtx, diff.removed);
        },
      ),
      "meta-reactivity/changed":
        symbol.native`meta-reactivity/changed: retained identities whose item changed; (new old) pairs`(
          {
            input: [],
            inputRest: sz.schemeValue,
            output: [sz.schemeValue],
            provenance: "pipe",
          },
          async function (...args: SchemeValue[]) {
            const diff = await observeDiff(this, args);
            const pairs = diff.changed.map(([next, prev]) => schemeList(this.runCtx, [next, prev]));
            return schemeList(this.runCtx, pairs);
          },
        ),
      "meta-reactivity/done-condition":
        symbol.native`meta-reactivity/done-condition: stop the clock; optional result is the bag outcome`(
          {
            input: [sz.schemeValue, sz.schemeValue.optional()],
            output: [sz.schemeValue],
            provenance: "pipe",
          },
          function (pred: SchemeValue, result?: SchemeValue) {
            const baseline = this.resources;
            invariant(baseline instanceof WatchBaseline, "meta-reactivity: baseline is not configured");
            const holds = schemeHolds(pred);
            baseline.noteDone(holds, holds ? result : undefined);
            return result === undefined ? pred : result;
          },
        ),
    }),
  }),
  { begin, abandon, commit },
);
