/**
 * Identity is a view over a stored item list. `equal?` is the value's
 * `arrival/tagless-final/equals` (Arrival's one structuralEqual).
 *
 * NOT X — fails because Y:
 * - Default identity is position, not `eq?` of the box — boxes are new every period.
 * - An identity change is remove+add, not `changed` — `changed` is same id, different item.
 * - First snapshot (no baseline) is an empty delta — establishing the baseline is not `added`.
 * - Duplicate identities in one snapshot are an error — silent merge drops an item.
 */
import { jsToScheme, toJS, type CallCtx, type SchemeValue } from "@here.build/arrival";
import { is_applyable } from "@here.build/arrival/host-internals";
import { ANil, APair, AValue, nil } from "@here.build/arrival/reflect-internals";
import invariant from "tiny-invariant";

export type Identified =
  | { readonly kind: "position"; readonly index: number; readonly item: SchemeValue }
  | { readonly kind: "value"; readonly id: SchemeValue; readonly item: SchemeValue };

export type ListDiff = {
  readonly added: SchemeValue[];
  readonly removed: SchemeValue[];
  readonly changed: Array<readonly [next: SchemeValue, prev: SchemeValue]>;
};

const EMPTY_DIFF: ListDiff = { added: [], removed: [], changed: [] };

export function schemeEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof AValue) return a["arrival/tagless-final/equals"](b);
  if (b instanceof AValue) return b["arrival/tagless-final/equals"](a);
  return false;
}

export function sameIdentity(a: Identified, b: Identified): boolean {
  if (a.kind === "position" && b.kind === "position") return a.index === b.index;
  if (a.kind === "value" && b.kind === "value") return schemeEqual(a.id, b.id);
  return false;
}

export function assertUniqueIdentities(items: readonly Identified[]): void {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (sameIdentity(items[i]!, items[j]!)) {
        throw new Error("meta-reactivity: duplicate identity");
      }
    }
  }
}

function isBorrowedJsArray(value: unknown): boolean {
  return value instanceof AValue && Array.isArray((value as { source?: unknown }).source);
}

function asJsArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (value instanceof ANil || value instanceof APair || isBorrowedJsArray(value)) {
    const js = toJS(value as SchemeValue);
    if (Array.isArray(js)) return [...js];
  }
  throw new Error("meta-reactivity: expected a proper list");
}

export function listItems(runCtx: CallCtx["runCtx"], value: unknown): SchemeValue[] {
  // toJS of a pair is an egress array; keyword accessors door on raw JS (no get
  // term). jsToScheme re-admits the original box; MCP rows become AJSObject.
  return asJsArray(value).map((item) => (item instanceof AValue ? (item as SchemeValue) : jsToScheme(runCtx, item)));
}

export function schemeList(runCtx: CallCtx["runCtx"], items: unknown): SchemeValue {
  const boxed = listItems(runCtx, items);
  return boxed.length === 0 ? nil : APair.fromArray(runCtx, boxed, false);
}

function applyIdentity(identity: SchemeValue, item: SchemeValue, callCtx: CallCtx): unknown {
  invariant(is_applyable(identity), "meta-reactivity: :identity must be callable");
  return identity["arrival/tagless-final/apply"]([item], callCtx);
}

export async function identifyItems(
  items: readonly SchemeValue[],
  identity: SchemeValue | undefined,
  callCtx: CallCtx,
): Promise<Identified[]> {
  if (identity === undefined) {
    return items.map((item, index) => ({ kind: "position", index, item }));
  }
  const out: Identified[] = [];
  for (const item of items) {
    const id = (await applyIdentity(identity, item, callCtx)) as SchemeValue;
    out.push({ kind: "value", id, item });
  }
  assertUniqueIdentities(out);
  return out;
}

export function diffLists(prev: readonly Identified[] | undefined, next: readonly Identified[]): ListDiff {
  assertUniqueIdentities(next);
  if (prev === undefined) return EMPTY_DIFF;
  assertUniqueIdentities(prev);
  const added = next.filter((n) => !prev.some((p) => sameIdentity(p, n))).map((n) => n.item);
  const removed = prev.filter((p) => !next.some((n) => sameIdentity(p, n))).map((p) => p.item);
  const changed: Array<readonly [SchemeValue, SchemeValue]> = [];
  for (const n of next) {
    const p = prev.find((x) => sameIdentity(x, n));
    if (p !== undefined && !schemeEqual(n.item, p.item)) changed.push([n.item, p.item]);
  }
  return { added, removed, changed };
}
