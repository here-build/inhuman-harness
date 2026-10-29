/**
 * Picture bytes for a user turn. Identity syncs on the turn. The file
 * lives beside the session document, under the kernel root.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bindVisualReader } from "@inhuman.tools/harness-provider-sdk";
import { PNG } from "pngjs";

const MAX_EDGE = 2048;
const MAX_BYTES = 5 * 1024 * 1024;
const SAFE_ID = /^[\w-]+$/;
const BASE64 = /^[a-z0-9+/]+={0,2}$/i;

export const VISUAL_UNREADABLE = "the picture could not be read";
export const VISUAL_TOO_LARGE = "the picture is too large";
export const VISUAL_TYPE = "this picture type can't be sent";

const VISION_MODELS = [
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "chatgpt-4o",
  "claude",
  "gemini",
  "grok-4",
  "grok-3",
  "grok-2",
  "pixtral",
  "llava",
  "qwen3-vl",
  "qwen2-vl",
  "qwen-vl",
];

let rootDir: string | null = null;

/** Seats the store and hands providers the read seam; the wire projection reads pictures through it. */
export function bindVisualStore(root: string): void {
  rootDir = root;
  bindVisualReader(readVisual);
}

/** Unknown and empty model ids are text-only. Bare `gpt-4` is not in the list. */
export function modelSeesImages(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (id === "") return false;
  return VISION_MODELS.some((token) => id.includes(token));
}

export type FittedVisual = {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly resizedFrom: { readonly width: number; readonly height: number } | null;
  readonly sourcePath: string | null;
};

export type FitVisualResult = ({ readonly ok: true } & FittedVisual) | { readonly ok: false; readonly reason: string };

export function decodeVisualBytes(text: string): Uint8Array | null {
  const compact = text.replaceAll(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  const decoded = Buffer.from(compact, "base64");
  if (decoded.length === 0) return null;
  return decoded;
}

export function fitVisual(input: {
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly sourcePath?: string;
}): FitVisualResult {
  const mime = canonicalMime(input.mime);
  const sourcePath = cleanPath(input.sourcePath);
  if (mime == null) return { ok: false, reason: VISUAL_TYPE };
  if (mime === "image/png") return fitPng(input.bytes, sourcePath);
  const size =
    mime === "image/jpeg" ? jpegSize(input.bytes) : mime === "image/gif" ? gifSize(input.bytes) : webpSize(input.bytes);
  return fitHeader(mime, input.bytes, size, sourcePath);
}

export function writeVisual(sessionId: string, id: string, bytes: Uint8Array): void {
  const path = visualPath(sessionId, id);
  if (path == null) throw new Error("visual store rejected the picture id");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readVisual(sessionId: string, id: string): Uint8Array | null {
  const path = visualPath(sessionId, id);
  if (path == null) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function visualPath(sessionId: string, id: string): string | null {
  if (rootDir == null) return null;
  if (!SAFE_ID.test(sessionId) || !SAFE_ID.test(id)) return null;
  return join(rootDir, "visuals", sessionId, id);
}

function canonicalMime(mime: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  const name = mime.trim().toLowerCase();
  if (name === "image/jpg" || name === "image/pjpeg") return "image/jpeg";
  if (name === "image/png" || name === "image/jpeg" || name === "image/gif" || name === "image/webp") return name;
  return null;
}

function cleanPath(path: string | undefined): string | null {
  if (path == null) return null;
  const trimmed = path.trim();
  return trimmed === "" ? null : trimmed;
}

function fitHeader(
  mime: string,
  bytes: Uint8Array,
  size: { readonly width: number; readonly height: number } | null,
  sourcePath: string | null,
): FitVisualResult {
  if (size == null) return { ok: false, reason: VISUAL_UNREADABLE };
  if (size.width > MAX_EDGE || size.height > MAX_EDGE || bytes.byteLength > MAX_BYTES) {
    return { ok: false, reason: VISUAL_TOO_LARGE };
  }
  return { ok: true, mime, bytes, width: size.width, height: size.height, resizedFrom: null, sourcePath };
}

function fitPng(bytes: Uint8Array, sourcePath: string | null): FitVisualResult {
  let src: PNG;
  try {
    src = PNG.sync.read(Buffer.from(bytes));
  } catch {
    return { ok: false, reason: VISUAL_UNREADABLE };
  }
  if (src.width < 1 || src.height < 1) return { ok: false, reason: VISUAL_UNREADABLE };
  const scaled = scalePng(src, MAX_EDGE);
  const stored = scaled.resized ? PNG.sync.write(scaled.png) : Buffer.from(bytes);
  if (stored.length > MAX_BYTES) return { ok: false, reason: VISUAL_TOO_LARGE };
  return {
    ok: true,
    mime: "image/png",
    bytes: stored,
    width: scaled.png.width,
    height: scaled.png.height,
    resizedFrom: scaled.resized ? { width: src.width, height: src.height } : null,
    sourcePath,
  };
}

function scalePng(src: PNG, maxEdge: number): { png: PNG; resized: boolean } {
  const edge = Math.max(src.width, src.height);
  if (edge <= maxEdge) return { png: src, resized: false };
  const scale = maxEdge / edge;
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      dst.data[di] = src.data[si] ?? 0;
      dst.data[di + 1] = src.data[si + 1] ?? 0;
      dst.data[di + 2] = src.data[si + 2] ?? 0;
      dst.data[di + 3] = src.data[si + 3] ?? 0;
    }
  }
  return { png: dst, resized: true };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
    if (length < 2 || offset + length > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc2) {
      if (length < 7 || offset + 6 >= bytes.length) return null;
      const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
      const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    offset += length;
  }
  return null;
}

function gifSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const sig = ascii(bytes, 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
  const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  if (chunk === "VP8 ") {
    if (((bytes[20] ?? 0) & 1) !== 0) return null;
    if ((bytes[23] ?? 0) !== 0x9d || (bytes[24] ?? 0) !== 0x01 || (bytes[25] ?? 0) !== 0x2a) return null;
    const width = ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff;
    const height = ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  if (chunk === "VP8L") {
    if ((bytes[20] ?? 0) !== 0x2f) return null;
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  }
  return null;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(bytes[start + index] ?? 0);
  return text;
}
