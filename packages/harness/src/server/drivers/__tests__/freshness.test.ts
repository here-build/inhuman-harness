import { extraLiveFromState, ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import { runInAction, when } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { OIDC_REFRESH_BACKOFF_MS, OIDC_REFRESH_SKEW_MS } from "@/providers/auth";
import { GrokDriverConnection } from "@/providers/grok";
import { OpenAiCompatDriverConnection } from "@/providers/openai-compat";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const TOKEN_URL = GrokDriverConnection.oidcProfile.tokenUrl;
const NOW = 1_700_000_000_000;

function bag(init: Record<string, string>) {
  const secrets: Record<string, string> = { ...init };
  const connection = new GrokDriverConnection(
    "grok",
    { baseUrl: GrokDriverConnection.oidcProfile.baseUrl },
    {
      get: (field) => secrets[field],
      all: () => secrets,
      replace: (next) => {
        for (const key of Object.keys(secrets)) delete secrets[key];
        Object.assign(secrets, next);
      },
    },
  );
  return { connection, secrets };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function mockOidcFetch(opts?: { grant?: "ok" | "fail" | (() => Promise<Response>); grants?: { n: number } }) {
  const grants = opts?.grants ?? { n: 0 };
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href === TOKEN_URL) {
      grants.n += 1;
      const grant = opts?.grant ?? "ok";
      if (typeof grant === "function") return grant();
      if (grant === "fail") return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
        status: 200,
      });
    }
    if (href.includes("/models") || href.includes("/user") || href.includes("userinfo") || href.includes("/billing")) {
      return new Response(JSON.stringify({ data: [{ id: "grok-4" }], config: { creditUsagePercent: 40 } }), {
        status: 200,
      });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  return grants;
}

function sendReady(connection: OpenAiCompatDriverConnection): boolean {
  return (
    (connection.readyState === "ready" && connection.fresh) ||
    connection.needsAuth ||
    connection.readyState === "failed"
  );
}

describe("openai-compat TFRP freshness: nowMs, per-class fresh, wait+stamp, deposit clears challenge", () => {
  it("empty-key and static-key compat are fresh; nowMs stays off spec.live", () => {
    const empty = new OpenAiCompatDriverConnection("row", { baseUrl: "http://127.0.0.1:11434/v1" });
    const keyed = new OpenAiCompatDriverConnection("row", { baseUrl: "https://api.example.test/v1" }, { apiKey: "sk" });
    empty.tick(NOW);
    keyed.tick(NOW);
    expect({
      empty: { fresh: empty.fresh, expiring: empty.expiring, needsAuth: empty.needsAuth },
      keyed: { fresh: keyed.fresh, expiring: keyed.expiring, needsAuth: keyed.needsAuth },
      live: extraLiveFromState(empty.state),
      stateHasNow: "nowMs" in empty.state,
    }).toEqual({
      empty: { fresh: true, expiring: false, needsAuth: false },
      keyed: { fresh: true, expiring: false, needsAuth: false },
      live: expect.not.objectContaining({ nowMs: expect.anything() }),
      stateHasNow: false,
    });
    void empty[Symbol.asyncDispose]();
    void keyed[Symbol.asyncDispose]();
  });

  it("OIDC expiring/fresh follow nowMs; absent expiresAt is not already-expired", () => {
    const { connection } = bag({
      apiKey: "at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60_000),
    });
    connection.tick(NOW);
    expect({ expiring: connection.expiring, fresh: connection.fresh }).toEqual({ expiring: true, fresh: false });
    connection.tick(NOW - OIDC_REFRESH_SKEW_MS - 60_000);
    expect({ expiring: connection.expiring, fresh: connection.fresh }).toEqual({ expiring: false, fresh: true });

    const missing = bag({ apiKey: "at", refreshToken: "rt" }).connection;
    missing.tick(NOW);
    expect({ expiring: missing.expiring, fresh: missing.fresh, needsAuth: missing.needsAuth }).toEqual({
      expiring: false,
      fresh: true,
      needsAuth: false,
    });
    const junk = bag({ apiKey: "at", refreshToken: "rt", expiresAt: "not-a-date" }).connection;
    junk.tick(NOW);
    expect(junk.expiring).toBe(false);
    void connection[Symbol.asyncDispose]();
    void missing[Symbol.asyncDispose]();
    void junk[Symbol.asyncDispose]();
  });

  it("when on the send predicate does not resolve during bootstrapping while the token is already fresh", async () => {
    const { connection } = bag({
      apiKey: "at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60 * 60_000),
    });
    connection.tick(NOW);
    runInAction(() => {
      connection.readyState = "bootstrapping";
    });
    expect({ fresh: connection.fresh, ready: sendReady(connection) }).toEqual({ fresh: true, ready: false });
    let resolved = false;
    void when(() => sendReady(connection)).then(() => {
      resolved = true;
      return undefined;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(resolved).toBe(false);
    await connection[Symbol.asyncDispose]();
  });

  it("send waits while not fresh; deposit unblocks; stamp wins init.headers; helper does not retry 401", async () => {
    const { connection } = bag({
      apiKey: "old-at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60_000),
    });
    connection.tick(NOW);
    runInAction(() => {
      connection.readyState = "ready";
    });
    connection.bootstrapDone = true;
    const seen: Array<{ auth: string | undefined; status: number }> = [];
    let posts = 0;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      posts += 1;
      const headers = new Headers(init?.headers);
      seen.push({ auth: headers.get("authorization") ?? headers.get("Authorization") ?? undefined, status: 401 });
      return new Response("nope", { status: 401 });
    }) as typeof fetch;
    const pending = connection.authorizedFetch("https://cli-chat-proxy.grok.com/v1/responses", {
      headers: { authorization: "Bearer stale", "x-test": "1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(posts).toBe(0);
    connection["depositSecrets"]({
      apiKey: "new-at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60 * 60_000),
    });
    const res = await pending;
    expect({ posts, status: res.status, auth: seen[0]?.auth, challenge: connection.lastChallenge }).toEqual({
      posts: 1,
      status: 401,
      auth: "Bearer new-at",
      challenge: 401,
    });
    await connection[Symbol.asyncDispose]();
  });

  it("deposit clears lastChallenge and refreshFailedAtMs so later ticks do not re-enter refresh", async () => {
    const grants = { n: 0 };
    mockOidcFetch({ grants });
    const { connection } = bag({
      apiKey: "old-at",
      refreshToken: "old-rt",
      expiresAt: iso(Date.now() + 60_000),
    });
    await connection.ensureBootstrapStarted();
    const afterBoot = grants.n;
    expect(afterBoot).toBeGreaterThanOrEqual(1);
    connection.noteChallenge(401);
    await when(() => connection.lastChallenge === "none");
    const afterHeal = grants.n;
    expect(afterHeal).toBeGreaterThan(afterBoot);
    connection.tick(connection.nowMs + CLOCK_STEP);
    connection.tick(connection.nowMs + CLOCK_STEP);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect({
      lastChallenge: connection.lastChallenge,
      refreshFailedAtMs: connection.refreshFailedAtMs,
      grants: grants.n,
    }).toEqual({
      lastChallenge: "none",
      refreshFailedAtMs: null,
      grants: afterHeal,
    });
    await connection[Symbol.asyncDispose]();
  });

  it("refresh miss keeps ready and needsAuth blocks re-fire; 401 without expiresAt still force-refreshes", async () => {
    const grants = mockOidcFetch({ grant: "fail" });
    const { connection } = bag({
      apiKey: "old-at",
      refreshToken: "old-rt",
      expiresAt: iso(Date.now() + 60_000),
    });
    await connection.ensureBootstrapStarted();
    expect({
      readyState: connection.readyState,
      needsAuth: connection.needsAuth,
      auth: connection.state.auth,
      liveAuth: extraLiveFromState(connection.state).auth,
      grants: grants.n,
    }).toEqual({
      readyState: "ready",
      needsAuth: true,
      auth: "needs-auth",
      liveAuth: "needs-auth",
      grants: 1,
    });
    connection.tick(connection.nowMs + OIDC_REFRESH_BACKOFF_MS + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(grants.n).toBe(1);

    const force = bag({ apiKey: "at", refreshToken: "rt" }).connection;
    const forceGrants = mockOidcFetch();
    force.tick(NOW);
    expect(force.expiring).toBe(false);
    force["startFreshnessWatch"]();
    force.noteChallenge(401);
    await when(() => force.lastChallenge === "none");
    expect(forceGrants.n).toBe(1);
    await connection[Symbol.asyncDispose]();
    await force[Symbol.asyncDispose]();
  });

  it("audience: Grok stamp never sees another connection's secrets", () => {
    const a = bag({ apiKey: "secret-aaa", refreshToken: "rt-a", expiresAt: iso(NOW + 3_600_000) }).connection;
    const b = bag({ apiKey: "secret-bbb", refreshToken: "rt-b", expiresAt: iso(NOW + 3_600_000) }).connection;
    const stamped = JSON.stringify(a.stamp({ authorization: "Bearer leaked" }));
    expect({
      hasOwn: stamped.includes("secret-aaa"),
      hasOther: stamped.includes("secret-bbb"),
      hasOtherRt: stamped.includes("rt-b"),
      extras: a.requestHeaders()["x-xai-token-auth"],
    }).toEqual({
      hasOwn: true,
      hasOther: false,
      hasOtherRt: false,
      extras: "xai-grok-cli",
    });
    void a[Symbol.asyncDispose]();
    void b[Symbol.asyncDispose]();
  });

  it("handshake door is used inside bootstrap; account poll after bootstrapDone uses send; OIDC bootstrap does not hang", async () => {
    mockOidcFetch();
    const { connection } = bag({
      apiKey: "at",
      refreshToken: "rt",
      expiresAt: iso(Date.now() + 3_600_000),
    });
    const doors: string[] = [];
    const send = connection.authorizedFetch.bind(connection);
    const hand = connection.handshakeFetch.bind(connection);
    connection.authorizedFetch = (async (...args: Parameters<typeof send>) => {
      doors.push("send");
      return send(...args);
    }) as typeof connection.authorizedFetch;
    connection.handshakeFetch = (async (...args: Parameters<typeof hand>) => {
      doors.push("handshake");
      return hand(...args);
    }) as typeof connection.handshakeFetch;
    await connection.ensureBootstrapStarted();
    expect({
      readyState: connection.readyState,
      duringBoot: doors.includes("send"),
      handshake: doors.includes("handshake"),
    }).toEqual({ readyState: "ready", duringBoot: false, handshake: true });
    doors.length = 0;
    await connection["refreshAccount"]();
    expect(doors.includes("send")).toBe(true);
    await connection[Symbol.asyncDispose]();
  });

  it("parallel send waits share one refresh coalescer", async () => {
    let inflight = 0;
    let peak = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      if (href === TOKEN_URL) {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inflight -= 1;
        return new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
          status: 200,
        });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const { connection } = bag({
      apiKey: "old-at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60_000),
    });
    connection.tick(NOW);
    runInAction(() => {
      connection.readyState = "ready";
    });
    connection.bootstrapDone = true;
    connection["startFreshnessWatch"]();
    const a = connection.authorizedFetch("https://cli-chat-proxy.grok.com/v1/chat/completions");
    const b = connection.authorizedFetch("https://cli-chat-proxy.grok.com/v1/responses");
    connection.tick(NOW + 1);
    await Promise.all([a, b]);
    expect(peak).toBe(1);
    expect(connection.fresh).toBe(true);
    await connection[Symbol.asyncDispose]();
  });

  it("abortOnDrop unblocks send-path when with connection-dropped", async () => {
    const { connection } = bag({
      apiKey: "old-at",
      refreshToken: "rt",
      expiresAt: iso(NOW + 60_000),
    });
    connection.tick(NOW);
    runInAction(() => {
      connection.readyState = "ready";
    });
    const abort = new AbortController();
    const pending = connection.authorizedFetch("https://cli-chat-proxy.grok.com/v1/x", undefined, abort.signal);
    connection.abortOnDrop(new ConnectionMiss("connection-dropped", "connection grok dropped"));
    abort.abort(new ConnectionMiss("connection-dropped", "connection grok dropped"));
    await expect(pending).rejects.toMatchObject({ code: "connection-dropped" });
    await connection[Symbol.asyncDispose]();
  });

  it("authorizedFetch throws ConnectionMiss when needsAuth or failed", async () => {
    const failed = new OpenAiCompatDriverConnection(
      "row",
      { baseUrl: "https://api.example.test/v1" },
      { apiKey: "sk" },
    );
    runInAction(() => {
      failed.readyState = "failed";
    });
    await expect(failed.authorizedFetch("https://api.example.test/v1/x")).rejects.toMatchObject({
      name: "ConnectionMiss",
      code: "not-ready",
    } satisfies Partial<ConnectionMiss>);
    const oidc = bag({ refreshToken: "rt" }).connection;
    runInAction(() => {
      oidc.readyState = "ready";
    });
    oidc.bootstrapDone = true;
    await expect(oidc.authorizedFetch("https://cli-chat-proxy.grok.com/v1/x")).rejects.toMatchObject({
      code: "needs-auth",
    });
    await failed[Symbol.asyncDispose]();
    await oidc[Symbol.asyncDispose]();
  });
});

const CLOCK_STEP = 60_000;
