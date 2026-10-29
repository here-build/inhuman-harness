/**
 * Hermes in this runtime has no Web Crypto object. Yjs reads `crypto` while
 * constructing a document, for the client id only.
 */
function fill(target: ArrayBufferView): ArrayBufferView {
  const view = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  for (let index = 0; index < view.length; index += 1) {
    view[index] = Math.floor(Math.random() * 256);
  }
  return target;
}

function randomUUID(): string {
  const nibbles = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  nibbles[12] = "4";
  const variant = (Number.parseInt(nibbles[16] ?? "0", 16) & 0x3) | 0x8;
  nibbles[16] = variant.toString(16);
  const hex = nibbles.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const host: { crypto?: Crypto } = globalThis;
if (host.crypto == null) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: fill, randomUUID },
  });
}
