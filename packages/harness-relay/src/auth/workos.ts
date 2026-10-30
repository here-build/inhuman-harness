const API = "https://api.workos.com/user_management";

export interface WorkosUser {
  id: string;
  email: string;
}

export interface WorkosTokens {
  accessToken: string;
  refreshToken: string;
  user: WorkosUser;
}

export function authorizationUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL(`${API}/authorize`);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    provider: "authkit",
    state,
  }).toString();
  return u.toString();
}

async function authenticate(body: Record<string, string>, fetcher: typeof fetch): Promise<WorkosTokens | undefined> {
  const res = await fetcher(`${API}/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    user?: { id?: string; email?: string };
  };
  if (!j.access_token || !j.refresh_token || !j.user?.id || !j.user.email) return undefined;
  return { accessToken: j.access_token, refreshToken: j.refresh_token, user: { id: j.user.id, email: j.user.email } };
}

export function exchangeCode(
  env: { WORKOS_CLIENT_ID: string; WORKOS_API_KEY: string },
  code: string,
  fetcher: typeof fetch = fetch,
) {
  return authenticate(
    {
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "authorization_code",
      code,
    },
    fetcher,
  );
}

export function refreshTokens(
  env: { WORKOS_CLIENT_ID: string; WORKOS_API_KEY: string },
  refreshToken: string,
  fetcher: typeof fetch = fetch,
) {
  return authenticate(
    {
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    },
    fetcher,
  );
}

export async function fetchUser(
  env: { WORKOS_API_KEY: string },
  id: string,
  fetcher: typeof fetch = fetch,
): Promise<WorkosUser | undefined> {
  const res = await fetcher(`${API}/users/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${env.WORKOS_API_KEY}` },
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as { id?: string; email?: string };
  return j.id && j.email ? { id: j.id, email: j.email } : undefined;
}
