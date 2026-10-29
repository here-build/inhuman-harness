/**
 * BoxMailbox → PaintSnapshot adapter.
 * Outside frame.ts so the pure frame module never imports box-bus vocabulary.
 */
import type { BoxMailbox } from "./box_bus.js";
import type { PaintSnapshot } from "./frame.js";

/** Project Seam C mailbox into the paint port. Pure; no capture of gen. */
export function paintSnapshotFromMailbox(mailbox: BoxMailbox): PaintSnapshot {
  return {
    tree: mailbox.tree,
    getBox: (id) => mailbox.boxes.get(id),
  };
}
