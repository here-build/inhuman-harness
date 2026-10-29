/** Bytes per `btoa` call; a multiple of 3, so chunks join without padding. */
const CHUNK = 3 * 8192;

export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += CHUNK) {
    out += btoa(String.fromCodePoint.apply(null, bytes.subarray(at, at + CHUNK) as unknown as number[]));
  }
  return out;
}

/** Records of a big-endian u32 length and that many bytes. A torn tail (killed mid-write) is ignored. */
export function parseLog(log: Uint8Array): Uint8Array[] {
  const view = new DataView(log.buffer, log.byteOffset, log.byteLength);
  const records: Uint8Array[] = [];
  let at = 0;
  while (at + 4 <= log.length) {
    const length = view.getUint32(at, false);
    if (at + 4 + length > log.length) break;
    records.push(log.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return records;
}

export function fromBase64(text: string): Uint8Array {
  const out = new Uint8Array(
    Math.floor((text.length * 3) / 4) - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0),
  );
  let at = 0;
  // A multiple of 4 characters per slice, so each decodes to whole bytes.
  for (let from = 0; from < text.length; from += 32768) {
    const binary = atob(text.slice(from, from + 32768));
    for (let i = 0; i < binary.length; i++) out[at++] = binary.charCodeAt(i);
  }
  return out;
}
