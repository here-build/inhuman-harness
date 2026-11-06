const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class Encoder {
  readonly #chunks: Uint8Array[] = [];
  #current = new Uint8Array(256);
  #offset = 0;

  writeVarUint(val: number): void {
    let num = Math.floor(val);
    while (num >= 0x80) {
      this.#write((num & 0x7f) | 0x80);
      num >>>= 7;
    }
    this.#write(num & 0x7f);
  }

  writeVarString(str: string): void {
    const bytes = textEncoder.encode(str);
    this.writeVarUint8Array(bytes);
  }

  writeVarUint8Array(bytes: Uint8Array): void {
    this.writeVarUint(bytes.byteLength);
    this.writeUint8Array(bytes);
  }

  writeUint8Array(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      this.#write(bytes[i]!);
    }
  }

  #write(byte: number): void {
    if (this.#offset === this.#current.length) {
      this.#chunks.push(this.#current);
      this.#current = new Uint8Array(Math.max(256, this.#current.length * 2));
      this.#offset = 0;
    }
    this.#current[this.#offset++] = byte;
  }

  toUint8Array(): Uint8Array {
    const total = this.#chunks.reduce((acc, c) => acc + c.length, 0) + this.#offset;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    out.set(this.#current.subarray(0, this.#offset), pos);
    return out;
  }
}

export class Decoder {
  #pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  get pos(): number {
    return this.#pos;
  }

  hasContent(): boolean {
    return this.#pos < this.bytes.length;
  }

  readVarUint(): number {
    let res = 0;
    let shift = 0;
    while (this.#pos < this.bytes.length) {
      const b = this.bytes[this.#pos++]!;
      res |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return res;
      shift += 7;
    }
    return res;
  }

  readVarString(): string {
    const len = this.readVarUint();
    const slice = this.bytes.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    return textDecoder.decode(slice);
  }

  readVarUint8Array(): Uint8Array {
    const len = this.readVarUint();
    const slice = this.bytes.subarray(this.#pos, this.#pos + len);
    this.#pos += len;
    return slice;
  }
}

export const createEncoder = (): Encoder => new Encoder();
export const toUint8Array = (e: Encoder): Uint8Array => e.toUint8Array();
export const writeVarUint = (e: Encoder, n: number): void => e.writeVarUint(n);
export const writeVarString = (e: Encoder, s: string): void => e.writeVarString(s);
export const writeVarUint8Array = (e: Encoder, b: Uint8Array): void => e.writeVarUint8Array(b);

export const createDecoder = (b: Uint8Array): Decoder => new Decoder(b);
export const hasContent = (d: Decoder): boolean => d.hasContent();
export const readVarUint = (d: Decoder): number => d.readVarUint();
export const readVarString = (d: Decoder): string => d.readVarString();
export const readVarUint8Array = (d: Decoder): Uint8Array => d.readVarUint8Array();
