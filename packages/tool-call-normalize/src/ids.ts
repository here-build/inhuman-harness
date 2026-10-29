import type { NormalizeOptions } from "./types.js";

/** Sync non-crypto hash for stable ids (FNV-1a 32-bit hex). */
export function fnv1a(s: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function mintId(
  index: number,
  name: string,
  args: string,
  style: NormalizeOptions["idStyle"] = "stable",
  stream = false,
): string {
  if (stream) {
    if (style === "uuid") return randomId("uuid");
    if (style === "mistral9") return randomAlnum(9);
    return `call_${index}`;
  }
  switch (style ?? "stable") {
    case "uuid":
      return randomId("uuid");
    case "call":
      return `call_${index}_${randomAlnum(6)}`;
    case "mistral9":
      return randomAlnum(9);
    case "stable":
      return `call_${fnv1a(`${index}\0${name}\0${args}`)}`;
  }
}

function randomAlnum(n: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < n; i++) {
    s += chars[Math.floor(Math.random() * chars.length)]!;
  }
  return s;
}

function randomId(_kind: "uuid"): string {
  // simple uuid-ish without crypto dependency
  return `call_${randomAlnum(8)}_${randomAlnum(4)}`;
}
