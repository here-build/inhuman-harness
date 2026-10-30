/** Room keys and the browser-facing JSON-RPC id envelope. */

/** The daemon's upgrade paths (`classifyPublicUpgrade`). Anything else would only be refused by it. */
const ROOM_PATHS = new Set(["/kernel", "/project", "/session"]);
/** Keeps the socket attachment (2 KiB) roomy enough for the awareness client list. */
export const MAX_ROOM_URL = 900;

/** `rest` is the daemon's own upgrade path and query, e.g. `/session?sessionId=s1&path=/p`. Null if not a room. */
export function parseRoom(rest: string): { original: string; key: string } | null {
  if (rest.length > MAX_ROOM_URL) return null;
  const key = roomKey(rest);
  return key === null ? null : { original: rest, key };
}

/** Path plus query sorted by name, so equivalent upgrades share a room. Null for a path the daemon does not serve. */
export function roomKey(original: string): string | null {
  let url: URL;
  try {
    url = new URL(original, "https://room.invalid");
  } catch {
    return null;
  }
  if (!ROOM_PATHS.has(url.pathname)) return null;
  url.searchParams.sort();
  const query = url.searchParams.toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

/** Tags are capped at 256 characters; long keys are hashed (two 53-bit hashes). */
export function tagKey(key: string): string {
  if (key.length <= 200) return key;
  return `~${cyrb53(key, 0).toString(36)}${cyrb53(key, 1).toString(36)}`;
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xde_ad_be_ef ^ seed;
  let h2 = 0x41_c6_ce_57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.codePointAt(i)!;
    h1 = Math.imul(h1 ^ ch, 2_654_435_761);
    h2 = Math.imul(h2 ^ ch, 1_597_334_677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
  return 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0);
}

export const newClientTag = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
