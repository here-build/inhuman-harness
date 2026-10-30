import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const jwksByClient = new Map<string, JWTVerifyGetKey>();

function jwksFor(clientId: string): JWTVerifyGetKey {
  let jwks = jwksByClient.get(clientId);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`));
    jwksByClient.set(clientId, jwks);
  }
  return jwks;
}

export type TokenResult = { ok: true; sub: string } | { ok: false; expired: boolean };

/** Verifies a WorkOS access token (browser or device flow, same client). `jwks` is injectable for tests. */
export async function verifyAccessToken(
  token: string,
  clientId: string,
  jwks: JWTVerifyGetKey = jwksFor(clientId),
): Promise<TokenResult> {
  if (!clientId) return { ok: false, expired: false };
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://api.workos.com/user_management/${clientId}`,
    });
    return payload.sub ? { ok: true, sub: payload.sub } : { ok: false, expired: false };
  } catch (error) {
    return { ok: false, expired: (error as { code?: string }).code === "ERR_JWT_EXPIRED" };
  }
}
