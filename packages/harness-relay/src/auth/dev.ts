// Dev gate for local e2e. Live only while DEV_AUTH_TOKEN is set (in .dev.vars, never in wrangler vars).
// Credential is dev, secret, sub, email joined by dots. The sub has no dots; the email may.

export const DEV_COOKIE = "relay_dev";

export interface Identity {
  sub: string;
  email: string;
}

export function buildDevCredential(secret: string, sub: string, email: string): string {
  return `dev.${secret}.${sub}.${email}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i] ?? 0);
  return diff === 0;
}

export function parseDevCredential(credential: string, secret: string | undefined): Identity | undefined {
  if (!secret || !credential.startsWith("dev.")) return undefined;
  const [, given, sub, ...email] = credential.split(".");
  if (!given || !sub || email.length === 0 || !safeEqual(given, secret)) return undefined;
  return { sub, email: email.join(".") };
}
