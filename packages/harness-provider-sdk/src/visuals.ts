/**
 * Read seam for stored pictures. The session's picture store belongs to the
 * daemon; a provider that projects a turn onto its wire reads bytes through
 * here and never imports the store.
 */

/** Bytes of one stored picture, or null when the id is unknown or unreadable. */
export type VisualReader = (sessionId: string, id: string) => Uint8Array | null;

let reader: VisualReader | null = null;

/** The host that owns the store binds it once at boot. `null` unbinds. */
export function bindVisualReader(read: VisualReader | null): void {
  reader = read;
}

/** Null while nothing is bound, so a wire projection names the picture as omitted. */
export function readVisual(sessionId: string, id: string): Uint8Array | null {
  return reader === null ? null : reader(sessionId, id);
}
