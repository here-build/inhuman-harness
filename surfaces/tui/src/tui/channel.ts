/**
 * Worker-thread seam. Paint lane is paint_*; host is attach lifecycle.
 * HELD_KEYS: do not replay input_events into the new session — those
 * keys belonged to the dying seat.
 */
import type { BoxBusUpMessage } from "@inhuman.tools/quickdraw/runtime";

import type { PaintDownMessage } from "./paint-transport.js";
import type { WorkerBoot } from "../schemas/worker-boot.js";

export type WorkerToHost =
  | { readonly lane: "paint"; readonly batch: readonly PaintDownMessage[] }
  | { readonly lane: "host"; readonly kind: "attached" | "failed"; readonly reason?: string }
  | { readonly lane: "host"; readonly kind: "title"; readonly text: string }
  | { readonly lane: "host"; readonly kind: "phase"; readonly text: string }
  | { readonly lane: "host"; readonly kind: "quit" }
  | { readonly lane: "host"; readonly kind: "resident"; readonly resident: boolean }
  | {
      readonly lane: "host";
      readonly kind: "replace";
      readonly path: string;
      readonly draft?: string;
      readonly sessionId?: string;
    };

export type HostToWorker =
  { readonly lane: "paint"; readonly message: BoxBusUpMessage } | { readonly lane: "host"; readonly kind: "shutdown" };

export function tuiReplaceBoot(
  kernel: string,
  message: { readonly path: string; readonly draft?: string; readonly sessionId?: string },
  cwd: string,
  geometry?: { readonly cols: number; readonly rows: number },
): WorkerBoot {
  const path = message.path === "" ? cwd : message.path;
  const sessionId = message.sessionId?.trim() ?? "";
  return {
    kernel,
    path,
    ...(message.draft != null && message.draft !== "" ? { draft: message.draft } : {}),
    ...(sessionId === "" ? {} : { sessionId, restore: true }),
    ...(geometry != null && geometry.cols > 0 && geometry.rows > 0 ? { cols: geometry.cols, rows: geometry.rows } : {}),
  };
}

export function tuiBootGeometry(
  boot: Pick<WorkerBoot, "cols" | "rows">,
  pending: readonly HostToWorker[],
): { cols: number; rows: number } {
  let cols = boot.cols ?? 80;
  let rows = boot.rows ?? 24;
  for (const message of pending) {
    if (message.lane !== "paint" || message.message.kind !== "resize") continue;
    cols = message.message.cols;
    rows = message.message.rows;
  }
  return { cols, rows };
}

/** see preamble HELD_KEYS, CHANGE ONLY. */
export function tuiWorkerReplay(message: HostToWorker): boolean {
  return !(message.lane === "paint" && message.message.kind === "input_events");
}
