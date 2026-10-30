// Session cookie: AES-GCM over JSON, key = SHA-256(WORKOS_COOKIE_PASSWORD).

const enc = new TextEncoder();

function b64u(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCodePoint(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.codePointAt(i)!;
  return out;
}

async function key(password: string): Promise<CryptoKey> {
  if (!password || password.length < 32) throw new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters");
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(password));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(value: unknown, password: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(password),
    enc.encode(JSON.stringify(value)),
  );
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
}

/** Undefined for anything tampered, truncated or sealed with another password. */
export async function unseal<T>(sealed: string, password: string): Promise<T | undefined> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) return undefined;
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await key(password), unb64u(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return undefined;
  }
}
