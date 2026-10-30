import { clearCookie, getCookie, setCookie } from "./auth/cookies.js";
import { buildDevCredential, DEV_COOKIE, parseDevCredential } from "./auth/dev.js";
import {
  authenticateBrowser,
  authenticateDaemon,
  checkAllowed,
  logoutCookies,
  sealSession,
  SESSION_COOKIE,
  type AuthDeps,
  type AuthResult,
} from "./auth/index.js";
import { authorizationUrl, exchangeCode } from "./auth/workos.js";
import { isMachineId } from "./machine-id.js";
import { renderPicker } from "./picker.js";
import { machineStub, userStub } from "./stubs.js";

export { MachineDO } from "./machine-do.js";
export { UserDO } from "./user-do.js";

const STATE_COOKIE = "relay_state";

const text = (status: number, body: string, headers?: HeadersInit) => new Response(body, { status, headers });
const redirect = (location: string, cookies: string[] = []) => {
  const h = new Headers({ location });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 303, headers: h });
};

/** The trust boundary: x-relay-* from the outside is dropped, then set from verified facts. */
export function forward(req: Request, facts: { sub: string; machine: string; role: "browser" | "daemon" }): Request {
  const headers = new Headers(req.headers);
  for (const k of headers.keys()) if (k.toLowerCase().startsWith("x-relay-")) headers.delete(k);
  headers.set("x-relay-sub", facts.sub);
  headers.set("x-relay-machine", facts.machine);
  headers.set("x-relay-role", facts.role);
  return new Request(req, { headers });
}

function withCookie(res: Response, cookie?: string): Response {
  if (!cookie) return res;
  const headers = new Headers(res.headers);
  headers.append("set-cookie", cookie);
  // An upgrade response carries the socket and has no body to copy.
  if (res.status === 101) return new Response(null, { status: 101, webSocket: res.webSocket, headers });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export async function handle(req: Request, env: Env, deps: AuthDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/auth/login" && req.method === "GET") return login(url, env);
  if (pathname === "/auth/callback" && req.method === "GET") return callback(req, url, env, deps);
  if (pathname === "/auth/logout" && req.method === "POST") return redirect("/", logoutCookies(url));

  const daemon = /^\/d\/([^/]+)\/(control|room\/.+)$/.exec(pathname);
  if (daemon) {
    const machine = daemon[1]!;
    if (!isMachineId(machine)) return text(400, "bad machine id");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "expected websocket");
    const auth = await authenticateDaemon(req, env, deps);
    if (!auth.ok) return text(auth.status, auth.status === 401 ? "unauthorized" : "forbidden");
    if (daemon[2] === "control") {
      const name = (url.searchParams.get("name") ?? "").trim().slice(0, 100) || machine;
      await userStub(env, auth.sub).registerMachine(machine, name);
    }
    return machineStub(env, auth.sub, machine).fetch(forward(req, { sub: auth.sub, machine, role: "daemon" }));
  }

  if (pathname === "/" || pathname === "/api/machines" || pathname.startsWith("/m/")) {
    const auth = await authenticateBrowser(req, env, deps);
    if (!auth.ok) return pathname === "/" && auth.status === 401 ? redirect("/auth/login") : unauthorized(auth);
    const res = await browserRoute(req, url, env, auth.sub, auth.email);
    return withCookie(res, auth.setCookie);
  }

  return text(404, "not found");
}

const unauthorized = (auth: Extract<AuthResult, { ok: false }>) =>
  text(auth.status, auth.status === 401 ? "unauthorized" : "forbidden");

async function browserRoute(req: Request, url: URL, env: Env, sub: string, email?: string): Promise<Response> {
  const { pathname } = url;
  if (pathname === "/" || pathname === "/api/machines") {
    if (req.method !== "GET") return text(405, "method not allowed");
    const machines = await userStub(env, sub).listMachines();
    if (pathname === "/api/machines") return Response.json(machines);
    const profile = email ? undefined : await userStub(env, sub).getProfile();
    const known = email ?? profile?.email;
    return new Response(renderPicker(machines, known), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const m = /^\/m\/([^/]+)\/(?:app(?:\/|$)|file$|room\/)/.exec(pathname);
  if (!m) return text(404, "not found");
  const machine = m[1]!;
  if (!isMachineId(machine)) return text(400, "bad machine id");
  const origin = req.headers.get("origin");
  if (req.headers.get("upgrade") && origin && origin !== url.origin) return text(403, "bad origin");
  // Only machines the user's daemon registered; no DO is created for arbitrary ids.
  if (!(await userStub(env, sub).hasMachine(machine))) return text(404, "unknown machine");
  return machineStub(env, sub, machine).fetch(forward(req, { sub, machine, role: "browser" }));
}

function login(url: URL, env: Env): Response {
  // Dev gate: only reachable while DEV_AUTH_TOKEN is set.
  const devToken = url.searchParams.get("dev_token");
  if (devToken !== null) {
    const credential = buildDevCredential(
      devToken,
      url.searchParams.get("sub") ?? "",
      url.searchParams.get("email") ?? "",
    );
    if (!parseDevCredential(credential, env.DEV_AUTH_TOKEN)) return text(401, "unauthorized");
    return redirect("/", [setCookie(url, DEV_COOKIE, encodeURIComponent(credential))]);
  }
  if (!env.WORKOS_CLIENT_ID) return text(500, "WORKOS_CLIENT_ID is not configured");
  const state = crypto.randomUUID();
  return redirect(authorizationUrl(env.WORKOS_CLIENT_ID, `${url.origin}/auth/callback`, state), [
    setCookie(url, STATE_COOKIE, state, { path: "/auth", maxAge: 600 }),
  ]);
}

async function callback(req: Request, url: URL, env: Env, deps: AuthDeps): Promise<Response> {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const expected = getCookie(req, STATE_COOKIE);
  if (!code || !state || state !== expected) return text(400, "bad login state");
  const tokens = await exchangeCode(env, code, deps.fetch);
  if (!tokens) return text(401, "login failed");
  if (!(await checkAllowed(env, tokens.user.id, tokens.user.email, deps))) return text(403, "forbidden");
  const sealed = await sealSession(env, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  return redirect("/", [setCookie(url, SESSION_COOKIE, sealed), clearCookie(url, STATE_COOKIE, "/auth")]);
}

export default {
  fetch: (req, env) => handle(req, env),
} satisfies ExportedHandler<Env>;
