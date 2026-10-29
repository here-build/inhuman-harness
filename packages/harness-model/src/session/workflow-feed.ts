/**
 * The wire of a workflow graph: SSE frames, and the JSON patches between graphs.
 * The daemon diffs each tick's graph against the last it sent; the client applies
 * the patches to the snapshot a run opened with. The graph is append-mostly, so
 * an index-wise diff stays small and needs no move detection.
 */

/** RFC 6902, the subset a diff of plain JSON needs. Paths are JSON pointers. */
export type JsonPatchOp =
  | { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string };

/** One SSE event. A run (gen) opens with a snapshot; patches follow in seq order. */
export type WorkflowFrame =
  | {
      readonly kind: "snapshot";
      readonly gen: number;
      readonly seq: number;
      readonly graph: unknown;
      readonly done: boolean;
    }
  | {
      readonly kind: "patch";
      readonly gen: number;
      readonly seq: number;
      readonly ops: readonly JsonPatchOp[];
      readonly done: boolean;
    };

type Json = Record<string, unknown> | readonly unknown[];

const isContainer = (value: unknown): value is Json => typeof value === "object" && value !== null;

const escapeKey = (key: string): string => key.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapeKey = (key: string): string => key.replaceAll("~1", "/").replaceAll("~0", "~");

/** Ops that turn `prev` into `next`. Arrays by index, objects by key; equal subtrees emit nothing. */
export function diffJson(prev: unknown, next: unknown): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  walk(prev, next, "", ops);
  return ops;
}

function walk(prev: unknown, next: unknown, path: string, ops: JsonPatchOp[]): void {
  if (Object.is(prev, next)) return;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const shared = Math.min(prev.length, next.length);
    for (let at = 0; at < shared; at += 1) walk(prev[at], next[at], `${path}/${at}`, ops);
    for (let at = shared; at < next.length; at += 1) ops.push({ op: "add", path: `${path}/${at}`, value: next[at] });
    // From the end, so each remaining index still names what it did.
    for (let at = prev.length - 1; at >= next.length; at -= 1) ops.push({ op: "remove", path: `${path}/${at}` });
    return;
  }
  if (isContainer(prev) && isContainer(next) && !Array.isArray(prev) && !Array.isArray(next)) {
    const before = prev as Record<string, unknown>;
    const after = next as Record<string, unknown>;
    for (const key of Object.keys(after)) {
      const at = `${path}/${escapeKey(key)}`;
      if (Object.hasOwn(before, key)) walk(before[key], after[key], at, ops);
      else ops.push({ op: "add", path: at, value: after[key] });
    }
    for (const key of Object.keys(before)) {
      if (!Object.hasOwn(after, key)) ops.push({ op: "remove", path: `${path}/${escapeKey(key)}` });
    }
    return;
  }
  ops.push({ op: "replace", path, value: next });
}

/** A new document with `ops` applied in order. Subtrees the ops do not touch are shared with `doc`. */
export function applyJsonPatch(doc: unknown, ops: readonly JsonPatchOp[]): unknown {
  let out = doc;
  for (const op of ops) {
    const segments = op.path === "" ? [] : op.path.slice(1).split("/").map(unescapeKey);
    out = apply(out, segments, 0, op);
  }
  return out;
}

function apply(node: unknown, segments: readonly string[], depth: number, op: JsonPatchOp): unknown {
  if (depth === segments.length) {
    if (op.op === "remove") throw new Error("json patch: cannot remove the root");
    return op.value;
  }
  const segment = segments[depth] as string;
  const last = depth === segments.length - 1;
  if (Array.isArray(node)) {
    const copy = [...node];
    const at = segment === "-" ? copy.length : Number(segment);
    if (!Number.isInteger(at) || at < 0 || at > copy.length) throw new Error(`json patch: no index ${op.path}`);
    if (!last) copy[at] = apply(copy[at], segments, depth + 1, op);
    else if (op.op === "remove") copy.splice(at, 1);
    else if (op.op === "add") copy.splice(at, 0, op.value);
    else copy[at] = op.value;
    return copy;
  }
  if (isContainer(node)) {
    const copy = { ...node } as Record<string, unknown>;
    if (!last) copy[segment] = apply(copy[segment], segments, depth + 1, op);
    else if (op.op === "remove") delete copy[segment];
    else copy[segment] = op.value;
    return copy;
  }
  throw new Error(`json patch: nothing at ${op.path}`);
}
