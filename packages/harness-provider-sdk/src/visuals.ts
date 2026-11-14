/**
 * Read seam for stored pictures. The session's picture store belongs to the
 * daemon; a provider that projects a turn onto its wire reads bytes through
 * here and never imports the store.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Bytes of one stored picture, or null when the id is unknown or unreadable. */
export type VisualReader = (sessionId: string, id: string) => Uint8Array | null;

let reader: VisualReader | null = null;
const readerContext = new AsyncLocalStorage<VisualReader>();

/** The host that owns the store binds it once at boot. `null` unbinds. */
export function bindVisualReader(read: VisualReader | null): void {
  reader = read;
}

/** Binds a visual reader scoped to the current async execution context (used by multi-kernel hosts). */
export function runWithVisualReader<T>(read: VisualReader, fn: () => T): T {
  return readerContext.run(read, fn);
}

/** Null while nothing is bound, so a wire projection names the picture as omitted. */
export function readVisual(sessionId: string, id: string): Uint8Array | null {
  const active = readerContext.getStore() ?? reader;
  return active === null ? null : active(sessionId, id);
}
