import { describe, expect, it } from "vitest";

import { memoryCredentialsStore } from "@/connections/credentials";

import {
  REMOTE_MACHINE_ID,
  REMOTE_TOKENS_ID,
  remoteLoggedIn,
  RemoteAccess,
  WORKOS_DEVICE_CODE_URL,
  WORKOS_TOKEN_URL,
} from "../remote-access.js";

const jwt = (claims: Record<string, unknown>): string =>
  `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

type Call = { url: string; form: Record<string, string> };

/** A fake WorkOS: the token endpoint answers from a script, one entry per call. */
function fakeWorkos(script: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const queue = [...script];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    if (url === WORKOS_DEVICE_CODE_URL) {
      return Promise.resolve(
        Response.json({
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.example/device",
          verification_uri_complete: "https://auth.example/device?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 5,
        }),
      );
    }
    const next = queue.shift();
    if (next === undefined) throw new Error("fake WorkOS: script exhausted");
    return Promise.resolve(Response.json(next.body, { status: next.status }));
  };
  return { fetchImpl, calls };
}

const success = (extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    access_token: jwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refresh_token: "refresh-1",
    user: { id: "user_1", email: "v@example.com" },
    ...extra,
  },
});
const failure = (error: string, status = 400) => ({ status, body: { error } });

function fakeClock() {
  const waits: number[] = [];
  let at = 1_000_000;
  return {
    waits,
    clock: {
      now: () => at,
      wait: (ms: number) => {
        waits.push(ms);
        at += ms;
        return Promise.resolve();
      },
    },
  };
}

function setup(script: Array<{ status: number; body: unknown }>, env: Record<string, string> = {}) {
  const credentials = memoryCredentialsStore();
  const workos = fakeWorkos(script);
  const time = fakeClock();
  const remote = new RemoteAccess({
    credentials: { read: credentials.read, write: credentials.write! },
    env: { HARNESS_REMOTE_WORKOS_CLIENT_ID: "client_test", ...env },
    fetch: workos.fetchImpl,
    hostname: () => "box.local",
    clock: time.clock,
  });
  const forms: string[] = [];
  const ui = (body: string) => {
    forms.push(body);
    return Promise.resolve({ kind: "accept" });
  };
  return { remote, credentials, workos, time, ui, forms };
}

describe("RemoteAccess login", () => {
  it("parks open-url, polls, stores tokens and reports the user", async () => {
    const t = setup([success()]);
    expect(t.remote.status().loggedIn).toBe(false);
    const done = await t.remote.login(t.ui);
    expect(t.forms).toEqual([
      '(harness/open-url :url "https://auth.example/device?user_code=ABCD-EFGH" :description "Approve this machine for remote access in the browser, then continue")',
    ]);
    expect(t.workos.calls[0]).toEqual({ url: WORKOS_DEVICE_CODE_URL, form: { client_id: "client_test" } });
    expect(t.workos.calls[1]).toEqual({
      url: WORKOS_TOKEN_URL,
      form: {
        client_id: "client_test",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: "dev-1",
      },
    });
    const status = t.remote.status();
    expect(status).toMatchObject({
      loggedIn: true,
      email: "v@example.com",
      machineName: "box.local",
      relayUrl: "https://harness.inhuman.tools",
      connected: false,
    });
    expect(done).toEqual({ email: "v@example.com", machineId: status.machineId });
    const bag = t.credentials.read(REMOTE_TOKENS_ID);
    expect(bag.refreshToken).toBe("refresh-1");
    // No expires_in in the body: expiry comes from the JWT exp.
    expect(Date.parse(bag.expiresAt ?? "") - Date.now()).toBeGreaterThan(3_500_000);
  });

  it("waits through authorization_pending, and backs off on slow_down", async () => {
    const t = setup([failure("authorization_pending"), failure("slow_down"), success()]);
    await t.remote.login(t.ui);
    expect(t.time.waits).toEqual([5000, 10_000]);
    expect(t.remote.status().loggedIn).toBe(true);
  });

  it("fails on expired_token and stores nothing", async () => {
    const t = setup([failure("expired_token")]);
    await expect(t.remote.login(t.ui)).rejects.toThrow(/device code expired/);
    expect(t.remote.status().loggedIn).toBe(false);
  });

  it("fails on access_denied and on invalid_grant", async () => {
    const denied = setup([failure("access_denied")]);
    await expect(denied.remote.login(denied.ui)).rejects.toThrow(/denied/);
    const bad = setup([failure("invalid_grant")]);
    await expect(bad.remote.login(bad.ui)).rejects.toThrow(/invalid_grant/);
    expect(bad.remote.status().loggedIn).toBe(false);
  });

  it("does not poll when the human cancels the form", async () => {
    const t = setup([success()]);
    await expect(t.remote.login(() => Promise.reject(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(t.workos.calls).toHaveLength(1);
    expect(t.remote.status().loggedIn).toBe(false);
  });

  it("fails with a clear message and no request when the client id is missing", async () => {
    const t = setup([], { HARNESS_REMOTE_WORKOS_CLIENT_ID: "" });
    await expect(t.remote.login(t.ui)).rejects.toThrow(/HARNESS_REMOTE_WORKOS_CLIENT_ID/);
    expect(t.workos.calls).toHaveLength(0);
    expect(t.forms).toEqual([]);
  });

  it("takes the relay url from the environment and trims trailing slashes", () => {
    const t = setup([], { HARNESS_REMOTE_URL: "http://localhost:8787/" });
    expect(t.remote.status().relayUrl).toBe("http://localhost:8787");
  });

  it("lets login rename the machine", async () => {
    const t = setup([success()]);
    await t.remote.login(t.ui, { name: "Studio" });
    expect(t.remote.status().machineName).toBe("Studio");
  });
});

describe("RemoteAccess machine and logout", () => {
  it("mints the machine id once, url-safe, and keeps it across logout", async () => {
    const t = setup([success()]);
    const first = t.remote.status().machineId;
    expect(first).toMatch(/^[\w-]{16,}$/i);
    await t.remote.login(t.ui);
    expect(t.remote.logout()).toEqual({ wasLoggedIn: true });
    expect(t.remote.status()).toMatchObject({ loggedIn: false, machineId: first });
    expect(t.credentials.read(REMOTE_TOKENS_ID)).toEqual({});
    expect(t.credentials.read(REMOTE_MACHINE_ID).machineId).toBe(first);
    expect(t.remote.logout()).toEqual({ wasLoggedIn: false });
  });
});

describe("RemoteAccess accessToken", () => {
  it("is undefined when logged out", async () => {
    const t = setup([]);
    expect(await t.remote.accessToken()).toBeUndefined();
  });

  it("returns the stored token while it is fresh", async () => {
    const t = setup([success()]);
    await t.remote.login(t.ui);
    const stored = t.credentials.read(REMOTE_TOKENS_ID).apiKey;
    expect(await t.remote.accessToken()).toBe(stored);
    expect(t.workos.calls).toHaveLength(2);
  });

  it("refreshes near expiry, stores the rotated tokens and keeps the user", async () => {
    const fresh = jwt({ sub: "user_1", exp: Math.floor(Date.now() / 1000) + 7200 });
    const t = setup([
      success(),
      { status: 200, body: { access_token: fresh, refresh_token: "refresh-2", expires_in: 3600 } },
    ]);
    await t.remote.login(t.ui);
    const token = await t.remote.accessToken(Date.now() + 3_600_000);
    expect(token).toBe(fresh);
    expect(t.workos.calls[2]).toEqual({
      url: WORKOS_TOKEN_URL,
      form: { client_id: "client_test", grant_type: "refresh_token", refresh_token: "refresh-1" },
    });
    const bag = t.credentials.read(REMOTE_TOKENS_ID);
    expect(bag).toMatchObject({ apiKey: fresh, refreshToken: "refresh-2", email: "v@example.com" });
    expect(t.remote.status()).toMatchObject({ loggedIn: true, email: "v@example.com" });
  });

  it("shares one refresh between concurrent callers", async () => {
    const t = setup([success(), success({ refresh_token: "refresh-2" })]);
    await t.remote.login(t.ui);
    const later = Date.now() + 3_600_000;
    const [a, b] = await Promise.all([t.remote.accessToken(later), t.remote.accessToken(later)]);
    expect(a).toBe(b);
    expect(t.workos.calls.filter((c) => c.form.grant_type === "refresh_token")).toHaveLength(1);
  });

  it("rejects when refresh fails transiently and leaves the stored tokens alone", async () => {
    const t = setup([success(), failure("server_error", 500)]);
    await t.remote.login(t.ui);
    await expect(t.remote.accessToken(Date.now() + 3_600_000)).rejects.toThrow(/token exchange failed \(500\)/);
    expect(t.credentials.read(REMOTE_TOKENS_ID).refreshToken).toBe("refresh-1");
    expect(t.remote.status().lastError).toBeUndefined();
  });

  it("drops the tokens and reports lastError on invalid_grant", async () => {
    const t = setup([success(), failure("invalid_grant")]);
    await t.remote.login(t.ui);
    await expect(t.remote.accessToken(Date.now() + 3_600_000)).resolves.toBeUndefined();
    const status = t.remote.status();
    expect(status.loggedIn).toBe(false);
    expect(status.lastError).toMatch(/harness login/);
  });
});

describe("RemoteAccess dev token (HARNESS_REMOTE_DEV_TOKEN)", () => {
  const dev = "dev.secret.user_9.me@example.com";

  it("is the bearer and the login, with no WorkOS call", async () => {
    const t = setup([], { HARNESS_REMOTE_DEV_TOKEN: dev });
    expect(await t.remote.accessToken(Date.now() + 3_600_000, true)).toBe(dev);
    expect(t.remote.status()).toMatchObject({ loggedIn: true, email: "me@example.com" });
    expect(t.workos.calls).toHaveLength(0);
    expect(remoteLoggedIn("/nonexistent", { HARNESS_REMOTE_DEV_TOKEN: dev })).toBe(true);
  });

  it("falls back to a placeholder email, and is inert when unset or blank", async () => {
    expect(setup([], { HARNESS_REMOTE_DEV_TOKEN: "dev.x" }).remote.status().email).toBe("dev@local");
    const t = setup([], { HARNESS_REMOTE_DEV_TOKEN: "  " });
    expect(await t.remote.accessToken()).toBeUndefined();
    expect(t.remote.status().loggedIn).toBe(false);
    expect(remoteLoggedIn("/nonexistent", {})).toBe(false);
  });
});
