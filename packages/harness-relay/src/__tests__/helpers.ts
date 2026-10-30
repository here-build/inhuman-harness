import { env as baseEnv } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

export const CLIENT_ID = "client_test";
export const DEV_SECRET = "dev-secret";
export const ORIGIN = "https://harness.test";

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    ...baseEnv,
    WORKOS_CLIENT_ID: CLIENT_ID,
    ALLOWED_EMAILS: "ok@example.com",
    DEV_AUTH_TOKEN: DEV_SECRET,
    ...over,
  };
}

export async function makeIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  return {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    sign: (sub: string, opts: { expiresIn?: string | number; issuer?: string } = {}) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setSubject(sub)
        .setIssuer(opts.issuer ?? `https://api.workos.com/user_management/${CLIENT_ID}`)
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? "5m")
        .sign(privateKey),
  };
}

let n = 0;
export const uniqueSub = () => `user_${Date.now()}_${n++}`;
