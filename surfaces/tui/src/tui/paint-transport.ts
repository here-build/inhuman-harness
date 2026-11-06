/**
 * paint_init + sequenced paint_patch. Worker accumulates MST onPatch into one
 * microtask batch. Host applyPatch is one MobX action. Protocol faults are
 * fatal; valid structural patches are transported without heuristic rejection.
 *
 * Growing strings (speech, live receipts) travel as `splice` so a token does
 * not recopy the whole prefix. The reader expands each splice to an MST
 * replace against the replica's current value.
 */
import { trace } from "@inhuman.tools/harness-diagnostics";
import { runInAction } from "mobx";
import { applyPatch, destroy, getSnapshot, type IJsonPatch, onPatch, protect } from "mobx-state-tree";

import { type PaintRootSnapshot, RootPaint, type RootPaintInstance } from "./paint-dom.js";

export type PaintSplicePatch = {
  readonly op: "splice";
  readonly path: string;
  readonly from: number;
  readonly deleteCount: number;
  readonly insert: string;
};

export type PaintPatch = IJsonPatch | PaintSplicePatch;

export type PaintDownMessage =
  | {
      readonly kind: "paint_init";
      readonly epoch: string;
      readonly snapshot: PaintRootSnapshot;
    }
  | {
      readonly kind: "paint_patch";
      readonly epoch: string;
      readonly seq: number;
      readonly patches: readonly PaintPatch[];
    };

export type PaintProtocolCode = "patch_before_init" | "seq_gap" | "epoch_mismatch" | "apply_failed";

export class PaintProtocolError extends Error {
  readonly code: PaintProtocolCode;
  constructor(code: PaintProtocolCode, message: string) {
    super(message);
    this.name = "PaintProtocolError";
    this.code = code;
  }
}

export type PaintWriter = {
  readonly epoch: string;
  attach(root: RootPaintInstance): void;
  flush(): void;
  close(mode: "flush" | "discard"): void;
  dispose(): void;
};

export function createPaintWriter(epoch: string, post: (message: PaintDownMessage) => void): PaintWriter {
  let root: RootPaintInstance | null = null;
  let queued: PaintPatch[] = [];
  let scheduled = false;
  let seq = 0;
  let open = true;
  let detachPatch: (() => void) | null = null;
  const flush = (): void => {
    scheduled = false;
    if (!open || queued.length === 0) {
      queued = [];
      return;
    }
    const patches = queued;
    queued = [];
    seq += 1;
    if (patches.length > 40) trace("harness:paint", `patch seq=${seq} n=${patches.length}`);
    post({ kind: "paint_patch", epoch, seq, patches });
  };

  return {
    epoch,
    attach(next) {
      if (root !== null) {
        throw new Error("paint writer already attached");
      }
      root = next;
      detachPatch = onPatch(next, (patch, reversePatch) => {
        if (!open) return;
        enqueuePatch(queued, compressReplace(patch, reversePatch));
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(flush);
      });
      post({
        kind: "paint_init",
        epoch,
        snapshot: getSnapshot(next) as PaintRootSnapshot,
      });
    },
    flush,
    close(mode) {
      if (!open) return;
      if (mode === "flush") flush();
      else queued = [];
      open = false;
      scheduled = false;
    },
    dispose() {
      this.close("discard");
      detachPatch?.();
      detachPatch = null;
      root = null;
    },
  };
}

export type PaintReader = {
  readonly root: RootPaintInstance | null;
  readonly epoch: string | null;
  readonly seq: number;
  apply(message: PaintDownMessage): RootPaintInstance;
  dispose(): void;
};

export function createPaintReader(): PaintReader {
  let root: RootPaintInstance | null = null;
  let epoch: string | null = null;
  let seq = 0;

  const remount = (nextEpoch: string, snapshot: PaintRootSnapshot): RootPaintInstance => {
    if (root !== null) destroy(root);
    root = RootPaint.create(snapshot);
    protect(root);
    epoch = nextEpoch;
    seq = 0;
    return root;
  };

  return {
    get root() {
      return root;
    },
    get epoch() {
      return epoch;
    },
    get seq() {
      return seq;
    },
    apply(message) {
      if (message.kind === "paint_init") {
        return remount(message.epoch, message.snapshot);
      }
      if (root === null || epoch === null) {
        throw new PaintProtocolError("patch_before_init", "paint_patch before paint_init");
      }
      if (message.epoch !== epoch) {
        throw new PaintProtocolError("epoch_mismatch", `paint_patch epoch ${message.epoch} != ${epoch}`);
      }
      if (message.seq !== seq + 1) {
        throw new PaintProtocolError("seq_gap", `paint_patch seq ${message.seq} != ${seq + 1}`);
      }
      try {
        runInAction(() => {
          applyPaintPatches(root as RootPaintInstance, message.patches);
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new PaintProtocolError("apply_failed", detail);
      }
      seq = message.seq;
      return root;
    },
    dispose() {
      if (root !== null) destroy(root);
      root = null;
      epoch = null;
      seq = 0;
    },
  };
}

function compressReplace(patch: IJsonPatch, reversePatch: IJsonPatch): PaintPatch {
  if (patch.op !== "replace" || typeof patch.value !== "string") return patch;
  const old = reversePatch.value;
  if (typeof old !== "string") return patch;
  if (patch.value.startsWith(old)) {
    return {
      op: "splice",
      path: patch.path,
      from: old.length,
      deleteCount: 0,
      insert: patch.value.slice(old.length),
    };
  }
  if (old.startsWith(patch.value)) {
    return {
      op: "splice",
      path: patch.path,
      from: patch.value.length,
      deleteCount: old.length - patch.value.length,
      insert: "",
    };
  }
  return patch;
}

function enqueuePatch(queued: PaintPatch[], next: PaintPatch): void {
  const last = queued.at(-1);
  if (
    last?.op === "splice" &&
    next.op === "splice" &&
    last.path === next.path &&
    last.deleteCount === 0 &&
    next.deleteCount === 0 &&
    last.from + last.insert.length === next.from
  ) {
    queued[queued.length - 1] = { ...last, insert: last.insert + next.insert };
    return;
  }
  queued.push(next);
}

function isSplice(patch: PaintPatch): patch is PaintSplicePatch {
  return patch.op === "splice";
}

function valueAtPath(root: object, path: string): unknown {
  let cur: unknown = root;
  for (const part of path.split("/")) {
    if (part === "") continue;
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function expandSplice(root: object, patch: PaintSplicePatch): IJsonPatch {
  const current = valueAtPath(root, patch.path);
  const text = typeof current === "string" ? current : "";
  return {
    op: "replace",
    path: patch.path,
    value: text.slice(0, patch.from) + patch.insert + text.slice(patch.from + patch.deleteCount),
  };
}

function applyPaintPatches(root: RootPaintInstance, patches: readonly PaintPatch[]): void {
  for (const patch of patches) {
    applyPatch(root, isSplice(patch) ? expandSplice(root, patch) : patch);
  }
}
