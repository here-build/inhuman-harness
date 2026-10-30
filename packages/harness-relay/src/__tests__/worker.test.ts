import { describe, expect, it, vi } from "vitest";

import { buildDevCredential } from "../auth/dev.js";
import { sealSession, SESSION_COOKIE } from "../auth/index.js";
import { forward, handle } from "../index.js";
import { userStub } from "../stubs.js";
import { DEV_SECRET, makeIssuer, ORIGIN, testEnv, uniqueSub } from "./helpers.js";

const OK = "ok@example.com";
const devBearer = (sub: string, email = OK) => `Bearer ${buildDevCredential(DEV_SECRET, sub, email)}`;
const devCookie = (sub: string, email = OK) =>
  `relay_dev=${encodeURIComponent(buildDevCredential(DEV_SECRET, sub, email))}`;
const get = (path: string, headers: Record<string, string> = {}) => new Request(ORIGIN + path, { headers });
const ws = (path: string, headers: Record<string, string>) =>
  new Request(ORIGIN + path, { headers: { upgrade: "websocket", ...headers } });

async function connectDaemon(env: Env, sub: string, id: string, name = "laptop") {
  const res = await handle(ws(`/d/${id}/control?name=${name}`, { authorization: devBearer(sub) }), env);
  expect(res.status).toBe(101);
  const sock = res.webSocket!;
  sock.accept();
  return sock;
}

describe("forward", () => {
  it("drops client x-relay-* and sets verified facts", () => {
    const req = new Request(`${ORIGIN}/m/x/app/`, {
      headers: { "x-relay-sub": "evil", "X-Relay-Role": "daemon", "x-relay-extra": "1", cookie: "a=b" },
    });
    const out = forward(req, { sub: "u1", machine: "m1", role: "browser" });
    expect(out.headers.get("x-relay-sub")).toBe("u1");
    expect(out.headers.get("x-relay-machine")).toBe("m1");
    expect(out.headers.get("x-relay-role")).toBe("browser");
    expect(out.headers.has("x-relay-extra")).toBe(false);
    expect(out.headers.get("cookie")).toBe("a=b");
  });
});

describe("public config", () => {
  it("publishes the WorkOS client id without auth", async () => {
    const res = await handle(get("/api/config"), testEnv({ WORKOS_CLIENT_ID: "client_pub" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workosClientId: "client_pub" });
  });
});

describe("browser routes", () => {
  it("redirects / to login without a session; APIs answer 401", async () => {
    const env = testEnv();
    const root = await handle(get("/"), env);
    expect(root.status).toBe(303);
    expect(root.headers.get("location")).toBe("/auth/login");
    expect((await handle(get("/api/machines"), env)).status).toBe(401);
    expect((await handle(get("/m/abc/app/"), env)).status).toBe(401);
  });

  it("dev login sets a cookie only when the gate is on and the secret matches", async () => {
    const q = `?dev_token=${DEV_SECRET}&sub=u1&email=${OK}`;
    const on = await handle(get(`/auth/login${q}`), testEnv());
    expect(on.headers.get("set-cookie")).toMatch(/^relay_dev=.*HttpOnly.*SameSite=Lax.*Secure/);
    expect((await handle(get(`/auth/login${q}`), testEnv({ DEV_AUTH_TOKEN: undefined }))).status).toBe(401);
    expect((await handle(get("/auth/login?dev_token=nope&sub=u1&email=a@b.c"), testEnv())).status).toBe(401);
  });

  it("denies a signed-in user who is not on the allowlist", async () => {
    const res = await handle(get("/api/machines", { cookie: devCookie(uniqueSub(), "no@example.com") }), testEnv());
    expect(res.status).toBe(403);
  });

  it("empty allowlist admits nobody", async () => {
    const res = await handle(get("/api/machines", { cookie: devCookie(uniqueSub()) }), testEnv({ ALLOWED_EMAILS: "" }));
    expect(res.status).toBe(403);
  });

  it("lists machines, picker links to the app", async () => {
    const env = testEnv();
    const sub = uniqueSub();
    await userStub(env, sub).registerMachine("m-one", "My <Laptop>");
    const cookie = devCookie(sub);
    const json = (await (await handle(get("/api/machines", { cookie }), env)).json()) as { machineId: string }[];
    expect(json.map((m) => m.machineId)).toEqual(["m-one"]);
    const html = await (await handle(get("/", { cookie }), env)).text();
    expect(html).toContain('href="/m/m-one/app/"');
    expect(html).toContain("My &lt;Laptop&gt;");
  });

  it("scopes machines to the user, 404s unknown ones, 400s bad ids", async () => {
    const env = testEnv();
    const a = uniqueSub();
    const b = uniqueSub();
    await userStub(env, a).registerMachine("m-a", "a");
    expect((await handle(get("/m/m-a/app/", { cookie: devCookie(b) }), env)).status).toBe(404);
    expect((await handle(get("/m/m-a/app/", { cookie: devCookie(a) }), env)).status).toBe(503);
    expect((await handle(get("/m/bad.id/app/", { cookie: devCookie(a) }), env)).status).toBe(400);
    expect((await handle(get("/m/m-a/other", { cookie: devCookie(a) }), env)).status).toBe(404);
  });

  it("redirects /m/<id>/app to the trailing slash, keeping the query", async () => {
    const env = testEnv();
    const sub = uniqueSub();
    await userStub(env, sub).registerMachine("m-a", "a");
    const res = await handle(get("/m/m-a/app?x=1", { cookie: devCookie(sub) }), env);
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/m/m-a/app/?x=1");
  });

  it("rejects cross-origin socket upgrades", async () => {
    const env = testEnv();
    const sub = uniqueSub();
    await userStub(env, sub).registerMachine("m-a", "a");
    const res = await handle(ws("/m/m-a/room/r", { cookie: devCookie(sub), origin: "https://evil.example" }), env);
    expect(res.status).toBe(403);
  });

  it("logout clears cookies", async () => {
    const res = await handle(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }), testEnv());
    const cookies = res.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=;`) && c.includes("Max-Age=0"))).toBe(true);
  });

  it("starts the WorkOS login with a state cookie", async () => {
    const res = await handle(get("/auth/login"), testEnv());
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://api.workos.com/user_management/authorize");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(res.headers.get("set-cookie")).toContain(`relay_state=${loc.searchParams.get("state")}`);
  });
});

describe("session cookie", () => {
  it("accepts a sealed session with a valid access token", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    const { jwks, sign } = await makeIssuer();
    const sub = uniqueSub();
    await userStub(env, sub).setProfile(OK, true);
    const sealed = await sealSession(env, { accessToken: await sign(sub), refreshToken: "r" });
    const res = await handle(get("/api/machines", { cookie: `${SESSION_COOKIE}=${sealed}` }), env, { jwks });
    expect(res.status).toBe(200);
    expect(res.headers.has("set-cookie")).toBe(false);
  });

  it("refreshes an expired access token and sets a new cookie", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    const { jwks, sign } = await makeIssuer();
    const sub = uniqueSub();
    const expired = await sign(sub, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const fresh = await sign(sub);
    const sealed = await sealSession(env, { accessToken: expired, refreshToken: "r1" });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ grant_type: "refresh_token", refresh_token: "r1" });
      return Response.json({ access_token: fresh, refresh_token: "r2", user: { id: sub, email: OK } });
    }) as unknown as typeof fetch;
    const res = await handle(get("/api/machines", { cookie: `${SESSION_COOKIE}=${sealed}` }), env, {
      jwks,
      fetch: fetcher,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=v1.`);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("401s on a bad refresh, a forged cookie or a foreign-key token", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    const a = await makeIssuer();
    const b = await makeIssuer();
    const sub = uniqueSub();
    const expired = await a.sign(sub, { expiresIn: Math.floor(Date.now() / 1000) - 60 });
    const sealedExpired = await sealSession(env, { accessToken: expired, refreshToken: "r" });
    const denied = vi.fn(async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    const cookie = (v: string) => ({ cookie: `${SESSION_COOKIE}=${v}` });
    expect(
      (await handle(get("/api/machines", cookie(sealedExpired)), env, { jwks: a.jwks, fetch: denied })).status,
    ).toBe(401);
    expect((await handle(get("/api/machines", cookie("v1.aa.bb")), env, { jwks: a.jwks })).status).toBe(401);
    const sealedForeign = await sealSession(env, { accessToken: await b.sign(sub), refreshToken: "r" });
    expect((await handle(get("/api/machines", cookie(sealedForeign)), env, { jwks: a.jwks })).status).toBe(401);
  });

  it("callback exchanges the code, checks the allowlist and seals the session", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    const sub = uniqueSub();
    const fetcher = vi.fn(async () =>
      Response.json({ access_token: "a", refresh_token: "r", user: { id: sub, email: OK } }),
    ) as unknown as typeof fetch;
    const req = get("/auth/callback?code=c&state=s1", { cookie: "relay_state=s1" });
    const res = await handle(req, env, { fetch: fetcher });
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=v1.`))).toBe(true);
    expect(await userStub(env, sub).getProfile()).toEqual({ email: OK, allowed: true });

    const bad = await handle(get("/auth/callback?code=c&state=zzz", { cookie: "relay_state=s1" }), env, {
      fetch: fetcher,
    });
    expect(bad.status).toBe(400);
    const stranger = testEnv({ DEV_AUTH_TOKEN: undefined, ALLOWED_EMAILS: "someone@else.com" });
    expect((await handle(req, stranger, { fetch: fetcher })).status).toBe(403);
  });
});

describe("daemon routes", () => {
  it("requires a websocket upgrade and a bearer", async () => {
    const env = testEnv();
    expect((await handle(get("/d/m1/control"), env)).status).toBe(426);
    expect((await handle(ws("/d/m1/control", {}), env)).status).toBe(401);
    expect((await handle(ws("/d/m1/control", { authorization: "Bearer junk" }), env)).status).toBe(401);
    expect((await handle(ws("/d/bad.id/control", { authorization: devBearer("u") }), env)).status).toBe(400);
  });

  it("dev credentials are inert when the gate is off", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    expect((await handle(ws("/d/m1/control", { authorization: devBearer("u1") }), env)).status).toBe(401);
  });

  it("denies a non-allowlisted daemon", async () => {
    const res = await handle(
      ws("/d/m1/control", { authorization: devBearer(uniqueSub(), "no@example.com") }),
      testEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("looks up an unknown sub in WorkOS once and caches the verdict", async () => {
    const env = testEnv({ DEV_AUTH_TOKEN: undefined });
    const { jwks, sign } = await makeIssuer();
    const sub = uniqueSub();
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://api.workos.com/user_management/users/${sub}`);
      return Response.json({ id: sub, email: OK });
    }) as unknown as typeof fetch;
    const mk = async () => ws("/d/m1/control", { authorization: `Bearer ${await sign(sub)}` });
    const first = await handle(await mk(), env, { jwks, fetch: fetcher });
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    const second = await handle(await mk(), env, { jwks, fetch: fetcher });
    expect(second.status).toBe(101);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await userStub(env, sub).getProfile()).toEqual({ email: OK, allowed: true });
    first.webSocket!.close();
    second.webSocket!.accept();
    second.webSocket!.close();
  });

  it("control registers the machine, tracks online/offline", async () => {
    const env = testEnv();
    const sub = uniqueSub();
    const sock = await connectDaemon(env, sub, "m-ctl", "work box");
    const stub = userStub(env, sub);
    await vi.waitFor(async () =>
      expect((await stub.listMachines())[0]).toMatchObject({ name: "work box", online: true }),
    );
    sock.close(1000, "bye");
    await vi.waitFor(async () => expect((await stub.listMachines())[0]!.online).toBe(false));
  });

  it("room upgrades reach the MachineDO", async () => {
    const env = testEnv();
    const res = await handle(ws("/d/m1/room/kernel", { authorization: devBearer(uniqueSub()) }), env);
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });
});
