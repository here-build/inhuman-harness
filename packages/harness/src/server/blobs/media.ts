/**
 * Media type of a blob whose bucket records none. The directory bucket keeps bytes only, so the daemon
 * decides at the door whether a body is text a shell can paint or bytes it can only carry.
 */
import { isUtf8 } from "node:buffer";

/** Valid UTF-8 without NUL bytes. */
export function isTextBytes(bytes: Uint8Array): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/**
 * The body as text, or null when it is not text. A byte-order mark stays in the text, so the text is the
 * exact string that was stored.
 */
export function utf8TextOf(bytes: Uint8Array): string | null {
  if (!isTextBytes(bytes)) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

export function blobMimeOf(bytes: Uint8Array): string {
  return isTextBytes(bytes) ? "text/plain" : "application/octet-stream";
}
