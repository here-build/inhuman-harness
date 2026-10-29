/**
 * Browser sign-in against the real loopback on port 0 (and a free fixed port for
 * latest-wins). The client side is `browser.ts`; no network beyond 127.0.0.1.
 */
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import { authorizeInBrowser, type BrowserAuthorizeUi } from "../authorize.js";
import { callbackOf, hitCallback, parkedUrl } from "./browser.js";

const AUTH_URL = "https://auth.example/authorize?client_id=x&state=s1";

/** A parked body's callback must be dead once the sign-in settles. */
async function expectClosed(body: string): Promise<void> {
  await expect(fetch(callbackOf(parkedUrl(body)))).rejects.toThrow();
}

function recording(answer: (body: string) => Promise<Record<string, unknown>> | Record<string, unknown>) {
  const bodies: string[] = [];
  const ui: BrowserAuthorizeUi = async (body) => {
    bodies.push(body);
    return answer(body);
  };
  return { ui, bodies };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe("authorizeInBrowser", () => {
  it("parks the callback-bearing URL, with a paste field only when asked", async () => {
    const plain = recording((body) => hitCallback(body, { code: "c", state: "s1" }));
    await authorizeInBrowser(plain.ui, { authUrl: AUTH_URL, description: "Sign in" });
    const paste = recording((body) => hitCallback(body, { code: "c", state: "s1" }));
    await authorizeInBrowser(paste.ui, { authUrl: AUTH_URL, description: "Sign in", paste: "Key" });
    const url = parkedUrl(plain.bodies[0]!);
    expect({
      host: url.host,
      callback: callbackOf(url).pathname,
      challenge: url.searchParams.get("client_id"),
      plainInput: plain.bodies[0]!.includes(":input"),
      pasteInput: paste.bodies[0]!.includes(':name "Key" :input \'password'),
      described: plain.bodies[0]!.includes(':description "Sign in"'),
    }).toEqual({
      host: "auth.example",
      callback: "/callback",
      challenge: "x",
      plainInput: false,
      pasteInput: true,
      described: true,
    });
  });

  it("opened answer waits for the browser's code, buffered or late", async () => {
    const early = recording((body) => hitCallback(body, { code: "early", state: "s1" }));
    const first = await authorizeInBrowser(early.ui, { authUrl: AUTH_URL, description: "d" });
    const late = recording((body) => {
      setTimeout(() => void hitCallback(body, { code: "late", state: "s2" }), 20);
      return { kind: "opened", url: parkedUrl(body).toString() };
    });
    const second = await authorizeInBrowser(late.ui, { authUrl: AUTH_URL, description: "d" });
    expect({ first, second }).toEqual({
      first: {
        code: "early",
        state: "s1",
        redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      },
      second: {
        code: "late",
        state: "s2",
        redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      },
    });
    await expectClosed(early.bodies[0]!);
    await expectClosed(late.bodies[0]!);
  });

  it("returns pasted text and closes the listener", async () => {
    const run = recording(() => ({ kind: "text", input: "  sk-pasted \n" }));
    const result = await authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", paste: "Key" });
    expect(result).toEqual({ pasted: "sk-pasted" });
    await expectClosed(run.bodies[0]!);
  });

  it("a pasted redirect URL is the callback delivered by hand", async () => {
    let callback = "";
    const run = recording((body) => {
      callback = callbackOf(parkedUrl(body)).toString();
      return { kind: "text", input: `${callback}?code=by-hand&state=s9` };
    });
    const result = await authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", paste: "Key" });
    expect(result).toEqual({ code: "by-hand", state: "s9", redirectUri: callback });
  });

  it("an empty paste means open: it waits for the callback", async () => {
    const run = recording((body) => {
      setTimeout(() => void hitCallback(body, { code: "after-empty" }), 10);
      return { kind: "text", input: "" };
    });
    const result = await authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", paste: "Key" });
    expect(result).toMatchObject({ code: "after-empty", state: "" });
  });

  it("an error param rejects and closes", async () => {
    const run = recording((body) => hitCallback(body, { error: "access_denied" }));
    await expect(authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d" })).rejects.toThrow(/access_denied/);
    await expectClosed(run.bodies[0]!);
  });

  it("times out and closes", async () => {
    const run = recording((body) => ({ kind: "opened", url: parkedUrl(body).toString() }));
    await expect(authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", timeoutMs: 30 })).rejects.toThrow(
      /timed out/,
    );
    await expectClosed(run.bodies[0]!);
  });

  it("abort while waiting for the browser rejects as aborted and closes", async () => {
    const abort = new AbortController();
    const run = recording((body) => {
      setTimeout(() => abort.abort(), 20);
      return { kind: "opened", url: parkedUrl(body).toString() };
    });
    const error = await authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", signal: abort.signal }).catch(
      (error_: unknown) => error_,
    );
    expect(error).toMatchObject({ name: "AbortError" });
    await expectClosed(run.bodies[0]!);
  });

  it("abort while the park is unanswered closes the listener", async () => {
    const abort = new AbortController();
    const run = recording(
      () =>
        new Promise<Record<string, unknown>>(() => {
          setTimeout(() => abort.abort(), 20);
        }),
    );
    const error = await authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", signal: abort.signal }).catch(
      (error_: unknown) => error_,
    );
    expect(error).toMatchObject({ name: "AbortError" });
    await expectClosed(run.bodies[0]!);
  });

  it("an already-aborted signal never parks", async () => {
    const run = recording(() => ({ kind: "opened" }));
    await expect(
      authorizeInBrowser(run.ui, { authUrl: AUTH_URL, description: "d", signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(run.bodies).toEqual([]);
  });

  it("latest sign-in wins a fixed port: the old wait is cancelled, the new one binds", async () => {
    const port = await freePort();
    const listen = { port, host: "127.0.0.1" };
    let parkedFirst: (body: string) => void = () => undefined;
    const firstParked = new Promise<string>((resolve) => {
      parkedFirst = resolve;
    });
    const first = recording((body) => {
      parkedFirst(body);
      return { kind: "opened", url: parkedUrl(body).toString() };
    });
    const abandoned = authorizeInBrowser(first.ui, { authUrl: AUTH_URL, description: "d", listen }).catch(
      (error: unknown) => error,
    );
    await firstParked;
    const second = recording((body) => hitCallback(body, { code: "retry", state: "s1" }));
    const retried = await authorizeInBrowser(second.ui, { authUrl: AUTH_URL, description: "d", listen });
    expect({ abandoned: await abandoned, retried }).toEqual({
      abandoned: expect.objectContaining({ name: "AbortError" }),
      retried: { code: "retry", state: "s1", redirectUri: `http://127.0.0.1:${port}/callback` },
    });
    await expectClosed(second.bodies[0]!);
  });
});
