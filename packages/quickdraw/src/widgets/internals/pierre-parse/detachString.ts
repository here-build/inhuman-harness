/**
 * Vendored from @pierre/diffs@1.2.12 dist/utils/detachString.js (Apache-2.0).
 * See NOTICE in this directory.
 *
 * Detaches string slices from the parent rope so GC can reclaim large patch
 * buffers after parse.
 *
 * TextEncoder/TextDecoder are global in Node 18+ and modern browsers; declared
 * locally so we don't need @types/node or DOM lib on this package.
 */
type TextEncoderLike = {
  encodeInto: (source: string, destination: Uint8Array) => { read: number; written: number };
};
type TextDecoderLike = {
  decode: (input?: Uint8Array) => string;
};

const stringDetachEncoder = new (
  globalThis as unknown as {
    TextEncoder: new () => TextEncoderLike;
  }
).TextEncoder();
const stringDetachDecoder = new (
  globalThis as unknown as {
    TextDecoder: new (label?: string, options?: { ignoreBOM?: boolean }) => TextDecoderLike;
  }
).TextDecoder("utf8", { ignoreBOM: true });
const SURROGATE_CODE_UNIT_PATTERN = /[\uD800-\uDFFF]/;
const STRING_DETACH_INITIAL_BUFFER_SIZE = 1024;
let stringDetachBuffer = new Uint8Array(STRING_DETACH_INITIAL_BUFFER_SIZE);

export function releaseStringDetachBuffer(): void {
  if (stringDetachBuffer.length !== STRING_DETACH_INITIAL_BUFFER_SIZE) {
    stringDetachBuffer = new Uint8Array(STRING_DETACH_INITIAL_BUFFER_SIZE);
  }
}

export function detachString(value: string): string {
  if (value.length === 0) return value;
  if (SURROGATE_CODE_UNIT_PATTERN.test(value)) {
    return structuredClone(value);
  }
  const requiredByteLength = value.length * 3;
  if (stringDetachBuffer.length < requiredByteLength) {
    stringDetachBuffer = new Uint8Array(requiredByteLength);
  }
  const { written } = stringDetachEncoder.encodeInto(value, stringDetachBuffer);
  return stringDetachDecoder.decode(stringDetachBuffer.subarray(0, written));
}
