import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, readJson } from "fs-extra";
import { describe, expect, it } from "vitest";

import { isUiForm } from "@/protocol/rpc";
import { mintOidcPkce } from "@/providers/auth";
import { ChatGptDriverConnection } from "@/providers/chatgpt";
import { GrokDriverConnection } from "@/providers/grok";
import { OpenRouterDriverConnection } from "@/providers/openrouter";

import { callbackOf, hitCallback, parkedUrl } from "../../providers/auth/__tests__/browser.js";
import { RpcInvalidParams, RpcMethodNotFound } from "../contract.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";

describe("kernel actions", () => {
  it("connection CRUD: adopt parks, secrets stay out of config, eTLD+1, drop, list, rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-act-crud-"));
    using daemon = new KernelDaemon(root);
    await daemon.ready;

    const urlPark = parked(
      await daemon.handleRequest("connect/adopt", { driver: "openai-compat", name: "OpenAI-compatible" }),
    );
    expect(urlPark).toMatchObject({
      form: "ui",
      pending: expect.any(String),
      body: expect.stringMatching(/harness\/input[\s\S]*Base URL/),
    });
    expect(await connectionsOf(root)).toEqual({});

    const keyPark = parked(
      await daemon.handleRequest("ui/resolve", {
        pending: urlPark.pending,
        kind: "text",
        input: "https://example.test/v1",
      }),
    );
    expect(keyPark).toMatchObject({
      form: "ui",
      pending: expect.any(String),
      body: expect.stringMatching(/API key[\s\S]*:secret/),
    });
    expect(await connectionsOf(root)).toEqual({});

    const skipped = (await daemon.handleRequest("ui/resolve", {
      pending: keyPark.pending,
      kind: "text",
      input: "",
    })) as { id: string };
    const afterSkip = await configOf(root);
    expect(skipped).toMatchObject({ id: "example-test" });
    expect(afterSkip).toMatchObject({
      connections: {
        "example-test": {
          driver: "openai-compat",
          name: "example.test",
          settings: { baseUrl: "https://example.test/v1" },
        },
      },
    });
    expect(afterSkip.connections["example-test"]).not.toHaveProperty("secrets");
    expect(existsSync(join(root, "secrets.json"))).toBe(false);

    const openai = (await daemon.handleRequest("connect/adopt", {
      driver: "openai-compat",
      name: "OpenAI-compatible",
      settings: { baseUrl: "https://api.openai.com/v1" },
      // A catalog needs a key; a caller that brings one is not asked for it.
      secrets: { apiKey: "sk-test" },
    })) as { id: string };
    const groq = (await daemon.handleRequest("connect/adopt", {
      driver: "openai-compat",
      name: "OpenAI-compatible",
      settings: { baseUrl: "https://api.groq.com/openai/v1" },
      // A catalog needs a key; a caller that brings one is not asked for it.
      secrets: { apiKey: "sk-test" },
    })) as { id: string };
    expect({ openai: openai.id, groq: groq.id }).toEqual({ openai: "openai", groq: "groq" });
    expect(await configOf(root)).toMatchObject({
      connections: {
        openai: { name: "OpenAI", settings: { baseUrl: "https://api.openai.com/v1" } },
        groq: { name: "Groq", settings: { baseUrl: "https://api.groq.com/openai/v1" } },
      },
    });

    const sentry = (await daemon.handleRequest("connect/adopt", {
      driver: "mcp-http",
      name: "sentry",
      settings: { url: "https://mcp.sentry.dev/mcp" },
      secrets: { token: "secret-token" },
    })) as { id: string };
    const withSecrets = await configOf(root);
    expect(sentry).toMatchObject({ id: "sentry" });
    expect(withSecrets).toMatchObject({
      connections: {
        sentry: { driver: "mcp-http", name: "sentry", settings: { url: "https://mcp.sentry.dev/mcp" } },
      },
    });
    expect(withSecrets.connections.sentry).not.toHaveProperty("secrets");
    expect(JSON.stringify(withSecrets)).not.toContain("secret-token");
    expect(await readJson(join(root, "secrets.json"))).toEqual({
      connections: {
        openai: { apiKey: "sk-test" },
        groq: { apiKey: "sk-test" },
        sentry: { token: "secret-token" },
      },
    });

    const listed = (await daemon.handleRequest("connect/list", {})) as {
      connections: Array<{ id: string; driver: string; enabled: boolean; status: string; toolCount: number }>;
    };
    const mcpOnly = (await daemon.handleRequest("connect/list", { abilityClaim: "mcp" })) as {
      connections: Array<{ id: string }>;
    };
    const got = (await daemon.handleRequest("connect/get", { id: "sentry" })) as {
      id: string;
      settings: Record<string, unknown>;
    };
    expect({
      sentry: listed.connections.find((row) => row.id === "sentry"),
      mcpOnly: mcpOnly.connections.map((row) => row.id),
      got,
    }).toMatchObject({
      sentry: {
        id: "sentry",
        name: "sentry",
        driver: "mcp-http",
        abilityClaim: ["mcp"],
        enabled: true,
        status: "idle",
        toolCount: 0,
        error: "",
      },
      mcpOnly: ["sentry"],
      got: { id: "sentry", settings: { url: "https://mcp.sentry.dev/mcp" } },
    });
    expect(got).not.toHaveProperty("secrets");
    expect(JSON.stringify(got)).not.toContain("token");

    await expect(daemon.handleRequest("connect/set-enabled", { id: "sentry", enabled: false })).resolves.toEqual({
      ok: true,
    });
    expect(await configOf(root)).toMatchObject({
      connections: { sentry: { settings: { enabled: false, url: "https://mcp.sentry.dev/mcp" } } },
    });
    expect(await daemon.handleRequest("connect/get", { id: "sentry" })).toMatchObject({
      enabled: false,
      status: "disabled",
      settings: { enabled: false },
    });

    await expect(daemon.handleRequest("connect/drop", { id: "sentry", confirm: true })).resolves.toEqual({ ok: true });
    expect({
      sentry: "sentry" in (await connectionsOf(root)),
      secrets: Object.keys(((await readJson(join(root, "secrets.json"))) as { connections: object }).connections),
    }).toEqual({ sentry: false, secrets: ["openai", "groq"] });

    const dropPark = parked(await daemon.handleRequest("connect/drop", { id: "openai" }));
    expect(dropPark).toMatchObject({
      form: "ui",
      pending: expect.any(String),
      body: expect.stringMatching(/harness\/confirm/),
    });
    await expect(daemon.handleRequest("ui/resolve", { pending: "nope" })).rejects.toBeInstanceOf(RpcInvalidParams);
    await daemon.handleRequest("ui/resolve", { pending: dropPark.pending, kind: "cancel" });
    expect({ openai: "openai" in (await connectionsOf(root)) }).toEqual({ openai: true });

    const dropAgain = parked(await daemon.handleRequest("connect/drop", { id: "openai" }));
    await daemon.handleRequest("ui/resolve", { pending: dropAgain.pending, kind: "accept" });
    expect({ openai: "openai" in (await connectionsOf(root)) }).toEqual({ openai: false });

    await expect(daemon.handleRequest("connect/probe", {})).rejects.toBeInstanceOf(RpcMethodNotFound);
    await expect(daemon.handleRequest("connect/drop", {})).rejects.toBeInstanceOf(RpcInvalidParams);

    const github = (await daemon.handleRequest("connect/adopt", {
      driver: "mcp-http",
      name: "github",
      settings: { url: "https://mcp.example/mcp" },
      secrets: { token: "t" },
    })) as { id: string };
    expect(github).toMatchObject({ id: "github" });
    await expect(daemon.handleRequest("connect/always-allow", { id: "github", tool: "get_issue" })).resolves.toEqual({
      ok: true,
    });
    await expect(daemon.handleRequest("connect/always-allow", { id: "github", tool: "get_issue" })).resolves.toEqual({
      ok: true,
    });
    await expect(
      daemon.handleRequest("connect/exclude-tool", { id: "github", tool: "merge_pull_request" }),
    ).resolves.toEqual({ ok: true });
    expect(await configOf(root)).toMatchObject({
      connections: {
        github: {
          settings: {
            url: "https://mcp.example/mcp",
            alwaysAllow: ["get_issue"],
            tools: ["!merge_pull_request"],
          },
        },
      },
    });
    await expect(
      daemon.handleRequest("connect/always-allow", { id: "missing", tool: "get_issue" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    await expect(
      daemon.handleRequest("connect/exclude-tool", { id: "missing", tool: "merge_pull_request" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);

    // the old cluster flags are gone from the wire: no shorthand, no compatibility
    await expect(daemon.handleRequest("config/auto-allow", { write: true })).rejects.toThrow(/Method not found/);

    // the user layer of the authorization table is validated before it is written
    await expect(
      daemon.handleRequest("config/set", { authorization: { auto: { risky: "ask" } } }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    await expect(
      daemon.handleRequest("config/set", { authorization: { auto: { classes: { "made-up": "allow" } } } }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    await expect(daemon.handleRequest("config/set", { authorization: { auto: { preset: "full" } } })).resolves.toEqual({
      ok: true,
    });
    expect((await configOf(root)).authorization).toEqual({ auto: { preset: "full" } });
    expect(JSON.parse(daemon.plexus.root.authorizationJson)).toEqual({ auto: { preset: "full" } });
    await expect(daemon.handleRequest("config/set", { authorization: null })).resolves.toEqual({ ok: true });
    expect((await configOf(root)).authorization).toBeUndefined();
    expect(daemon.plexus.root.authorizationJson).toBe("");

    // stored grants: settings grants do not expire, a fenced subtree is refused, revoke removes the row
    const subject = { kind: "command", argv0: "make", spine: [], args: ["deploy"] } as const;
    await expect(daemon.handleRequest("grant/add", { scope: "project", subject })).resolves.toEqual({
      ok: false,
      reason: "invalid-scope",
    });
    await expect(
      daemon.handleRequest("grant/add", {
        scope: "global",
        subject: { kind: "path", cluster: "read", path: "/", depth: "subtree" },
      }),
    ).resolves.toEqual({ ok: false, reason: "fenced-path" });
    await expect(daemon.handleRequest("grant/add", { scope: "session", scopeKey: "nope", subject })).resolves.toEqual({
      ok: false,
      reason: "unknown-session",
    });
    const added = (await daemon.handleRequest("grant/add", { scope: "project", scopeKey: "/p", subject })) as {
      ok: true;
      row: { id: string; expiresAtMs: number | null; source: string; scope: string };
    };
    expect(added).toMatchObject({ ok: true, row: { expiresAtMs: null, source: "settings", scope: "project" } });
    const timed = (await daemon.handleRequest("grant/add", { scope: "global", subject, ttlMs: 1000 })) as {
      row: { id: string; expiresAtMs: number };
    };
    expect(timed.row.expiresAtMs).toBeGreaterThan(Date.now());
    const storedRows = (await daemon.handleRequest("grant/list", {})) as { rows: Array<{ id: string }> };
    expect(storedRows.rows.map((row) => row.id).toSorted()).toEqual([added.row.id, timed.row.id].toSorted());
    expect(JSON.parse(daemon.plexus.root.grantsJson)).toHaveLength(2);
    await expect(daemon.handleRequest("grant/list", { scope: "global" })).resolves.toMatchObject({
      rows: [{ id: timed.row.id }],
    });
    await expect(daemon.handleRequest("grant/revoke", { id: added.row.id })).resolves.toEqual({ ok: true });
    await expect(daemon.handleRequest("grant/revoke", { id: added.row.id })).resolves.toEqual({ ok: false });
    expect(JSON.parse(daemon.plexus.root.grantsJson)).toHaveLength(1);
    // an expired row is not listed and is swept
    expect(daemon.sweepGrants(Date.now() + 10_000)).toBe(1);
    await expect(daemon.handleRequest("grant/list", { includeExpired: true })).resolves.toEqual({ rows: [] });
  });

  describe("OIDC login", () => {
    it("parked Grok adopt does not block term-continue/set", async () => {
      const root = await mkdtemp(join(tmpdir(), "harness-act-grok-park-"));
      using daemon = new KernelDaemon(root);
      await daemon.ready;
      const park = parked(await daemon.handleRequest("connect/adopt", { driver: "grok" }));
      const continued = await Promise.race([
        daemon.handleRequest("term-continue/set", { key: "emu=1", sessionId: "s1" }),
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, blocked: true }), 500);
        }),
      ]);
      const cancelled = await daemon.handleRequest("ui/resolve", { pending: park.pending, kind: "cancel" });
      const afterCancel = await daemon.handleRequest("term-continue/set", { key: "emu=2", sessionId: "s2" });
      expect({ form: park.form, continued, cancelled, afterCancel }).toEqual({
        form: "ui",
        continued: { ok: true },
        cancelled: { ok: false },
        afterCancel: { ok: true },
      });
    });
  });

  describe("mcp-server/adopt", () => {
    it("plane close aborts hung OAuth probe and does not stamp config", async () => {
      const originalFetch = globalThis.fetch;
      let sawSignal = false;
      globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) {
            reject(new Error("mcp adopt fetch missing AbortSignal"));
            return;
          }
          sawSignal = true;
          if (signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        })) as typeof fetch;
      const root = await mkdtemp(join(tmpdir(), "harness-act-mcp-abort-"));
      using daemon = new KernelDaemon(root);
      await daemon.ready;
      const identity = { requestId: 1, connectionId: "plane-mcp" };
      const before = await connectionsOf(root);
      try {
        const adopt = daemon.handleRequest("mcp-server/adopt", { input: "https://mcp.example.test/mcp" }, identity);
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (sawSignal) {
              clearInterval(timer);
              resolve();
            }
          }, 10);
          setTimeout(() => {
            clearInterval(timer);
            resolve();
          }, 2000);
        });
        expect(sawSignal).toBe(true);
        const continued = await Promise.race([
          daemon.handleRequest("term-continue/set", { key: "emu=mcp", sessionId: "s1" }),
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: false, blocked: true }), 500);
          }),
        ]);
        daemon.onPlaneClose("plane-mcp");
        expect({ continued, adopt: await adopt, connections: await connectionsOf(root) }).toEqual({
          continued: { ok: true },
          adopt: { ok: false },
          connections: before,
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("OIDC login", () => {
    it("PKCE dialect is per-provider", async () => {
      let openrouterHref = "";
      await OpenRouterDriverConnection.adopt({}, async (_kind, body) => {
        openrouterHref = parkedUrl(body).toString();
        return { kind: "text", input: "sk-or-x" };
      });
      const grokPkce = mintOidcPkce(GrokDriverConnection.oidcProfile);
      const chatgptPkce = mintOidcPkce(ChatGptDriverConnection.oidcProfile);
      expect({
        openrouter: new URL(openrouterHref).searchParams.get("callback_url"),
        grok: new URL(grokPkce.url).searchParams.get("redirect_uri"),
        chatgpt: new URL(chatgptPkce.url).searchParams.get("redirect_uri"),
        originator: new URL(chatgptPkce.url).searchParams.get("originator"),
        grokScope: new URL(grokPkce.url).searchParams.get("scope")?.includes("grok-cli:access") ?? false,
      }).toEqual({
        openrouter: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
        grok: null,
        chatgpt: null,
        originator: "codex_cli_rs",
        grokScope: true,
      });
    });
    it("cancel while waiting for the browser aborts the adopt and frees the callback", async () => {
      const root = await mkdtemp(join(tmpdir(), "harness-act-cancel-"));
      using daemon = new KernelDaemon(root);
      await daemon.ready;
      const park = parked(await daemon.handleRequest("connect/adopt", { driver: "grok" }));
      const callback = callbackOf(parkedUrl(park.body));
      const inflight = daemon.handleRequest("ui/resolve", { pending: park.pending, kind: "opened", url: "https://x" });
      const cancelled = await daemon.handleRequest("ui/resolve", { pending: park.pending, kind: "cancel" });
      expect({ cancelled, inflight: await inflight }).toEqual({ cancelled: { ok: true }, inflight: { ok: false } });
      await expect(fetch(callback)).rejects.toThrow();
      expect(Object.keys(await connectionsOf(root))).toEqual([]);
    });
    it("Nous Portal adopt parks device-code URL then stores OAuth tokens", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const href = String(url);
        if (href.endsWith("/api/oauth/device/code")) {
          const body = new URLSearchParams(String(init?.body));
          expect({ client: body.get("client_id"), scope: body.get("scope") }).toEqual({
            client: "hermes-cli",
            scope: "inference:invoke",
          });
          return new Response(
            JSON.stringify({
              device_code: "dev-1",
              user_code: "ABCD-EFGH",
              verification_uri: "https://portal.nousresearch.com/manage-subscription",
              verification_uri_complete: "https://portal.nousresearch.com/manage-subscription?user_code=ABCD-EFGH",
              expires_in: 600,
              interval: 0,
            }),
            { status: 200 },
          );
        }
        if (href.endsWith("/api/oauth/token")) {
          const body = new URLSearchParams(String(init?.body));
          expect({
            grant: body.get("grant_type"),
            device: body.get("device_code"),
            client: body.get("client_id"),
          }).toEqual({
            grant: "urn:ietf:params:oauth:grant-type:device_code",
            device: "dev-1",
            client: "hermes-cli",
          });
          return new Response(JSON.stringify({ access_token: "nous-at", refresh_token: "nous-rt", expires_in: 3600 }), {
            status: 200,
          });
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        const root = await mkdtemp(join(tmpdir(), "harness-act-nous-"));
        using daemon = new KernelDaemon(root);
        await daemon.ready;

        const park = parked(await daemon.handleRequest("connect/adopt", { driver: "nous" }));
        expect(park).toMatchObject({ form: "ui", pending: expect.any(String) });
        const url = urlFromPark(park.body);
        expect({ hostname: url.hostname, pathname: url.pathname, user: url.searchParams.get("user_code") }).toEqual({
          hostname: "portal.nousresearch.com",
          pathname: "/manage-subscription",
          user: "ABCD-EFGH",
        });
        expect(await connectionsOf(root)).toEqual({});

        const adopted = (await daemon.handleRequest("ui/resolve", {
          pending: park.pending,
          kind: "text",
          input: "",
        })) as { id: string };
        expect(adopted).toMatchObject({ id: "nous-portal" });
        const file = await configOf(root);
        expect(file.connections["nous-portal"]).toMatchObject({
          driver: "nous",
          name: "Nous Portal",
          settings: { baseUrl: "https://inference-api.nousresearch.com/v1" },
        });
        expect(file.connections["nous-portal"]).not.toHaveProperty("secrets");
        expect(await readJson(join(root, "secrets.json"))).toMatchObject({
          connections: {
            "nous-portal": {
              apiKey: "nous-at",
              refreshToken: "nous-rt",
              expiresAt: expect.stringMatching(/^\d{4}-/),
            },
          },
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("OIDC login: PKCE dialect and token exchange", async () => {
      const grokPkce = mintOidcPkce(GrokDriverConnection.oidcProfile);
      const chatgptPkce = mintOidcPkce(ChatGptDriverConnection.oidcProfile);
      expect({
        grok: new URL(grokPkce.url).searchParams.get("redirect_uri"),
        chatgpt: new URL(chatgptPkce.url).searchParams.get("redirect_uri"),
        originator: new URL(chatgptPkce.url).searchParams.get("originator"),
        grokScope: new URL(grokPkce.url).searchParams.get("scope")?.includes("grok-cli:access") ?? false,
      }).toEqual({
        grok: null,
        chatgpt: null,
        originator: "codex_cli_rs",
        grokScope: true,
      });

      const payload = Buffer.from(
        JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
      ).toString("base64url");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/auth/keys")) {
          const body = JSON.parse(String(init?.body)) as { code?: string; code_verifier?: string };
          expect({ code: body.code, verifier: (body.code_verifier ?? "").length > 0 }).toEqual({
            code: "or-auth-code",
            verifier: true,
          });
          return new Response(JSON.stringify({ key: "sk-or-exchanged" }), { status: 200 });
        }
        if (href === GrokDriverConnection.oidcProfile.tokenUrl) {
          const body = new URLSearchParams(String(init?.body));
          expect({
            grant_type: body.get("grant_type"),
            code: body.get("code"),
            redirect_uri: body.get("redirect_uri"),
            verifier: (body.get("code_verifier") ?? "").length > 0,
          }).toEqual({
            grant_type: "authorization_code",
            code: "grok-auth-code",
            redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
            verifier: true,
          });
          return new Response(JSON.stringify({ access_token: "grok-at", refresh_token: "grok-rt", expires_in: 3600 }), {
            status: 200,
          });
        }
        if (href === ChatGptDriverConnection.oidcProfile.tokenUrl) {
          return new Response(
            JSON.stringify({
              access_token: "codex-at",
              refresh_token: "codex-rt",
              expires_in: 3600,
              id_token: `hdr.${payload}.sig`,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch;

      const root = await mkdtemp(join(tmpdir(), "harness-act-oidc-"));
      using daemon = new KernelDaemon(root);
      await daemon.ready;
      try {
        await expect(daemon.handleRequest("connect/login", { id: "missing" })).rejects.toBeInstanceOf(RpcInvalidParams);

        for (const row of EXCHANGE) {
          const park = parked(await daemon.handleRequest("connect/adopt", { driver: row.driver }));
          expect(park).toMatchObject({ form: "ui", pending: expect.any(String) });
          const url = urlFromPark(park.body);
          expect({
            hostname: url.hostname,
            pathname: url.pathname,
            redirect_uri: url.searchParams.get("redirect_uri"),
            callback_url: url.searchParams.get("callback_url"),
            method: url.searchParams.get("code_challenge_method"),
          }).toEqual(row.dialect);
          // The daemon holds the loopback: a browser client pastes, or opens and the code lands there.
          const answer =
            row.code === undefined
              ? row.paste
              : await hitCallback(
                  park.body,
                  { code: row.code, state: url.searchParams.get("state") ?? "" },
                  originalFetch,
                );
          const adopted = (await daemon.handleRequest("ui/resolve", {
            pending: park.pending,
            ...answer,
          })) as { id: string };
          expect(adopted).toMatchObject({ id: row.id });
          const file = await configOf(root);
          expect(file.connections[row.id]).toMatchObject(row.config);
          expect(file.connections[row.id]).not.toHaveProperty("secrets");
          expect(await readJson(join(root, "secrets.json"))).toMatchObject({
            connections: { [row.id]: row.secrets },
          });
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

const EXCHANGE = [
  {
    driver: "openrouter",
    id: "openrouter",
    paste: { kind: "text" as const, input: "or-auth-code" },
    code: undefined,
    dialect: {
      hostname: "openrouter.ai",
      pathname: "/auth",
      redirect_uri: null,
      callback_url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      method: "S256",
    },
    config: { driver: "openrouter", settings: { baseUrl: "https://openrouter.ai/api/v1" } },
    secrets: { apiKey: "sk-or-exchanged" },
  },
  {
    driver: "grok",
    id: "grok",
    code: "grok-auth-code",
    dialect: {
      hostname: "auth.x.ai",
      pathname: "/oauth2/authorize",
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      callback_url: null,
      method: "S256",
    },
    config: { driver: "grok", settings: { baseUrl: "https://cli-chat-proxy.grok.com/v1" } },
    secrets: {
      apiKey: "grok-at",
      refreshToken: "grok-rt",
      expiresAt: expect.stringMatching(/^\d{4}-/),
    },
  },
  {
    driver: "chatgpt",
    id: "chatgpt",
    code: "chatgpt-auth-code",
    dialect: {
      hostname: "auth.openai.com",
      pathname: "/oauth/authorize",
      redirect_uri: "http://localhost:1455/auth/callback",
      callback_url: null,
      method: "S256",
    },
    config: { driver: "chatgpt", settings: { baseUrl: "https://chatgpt.com/backend-api/codex" } },
    secrets: { apiKey: "codex-at", refreshToken: "codex-rt", accountId: "acct-1" },
  },
] as const;

type ConfigFile = {
  connections: Record<string, { driver?: string; name?: string; settings?: Record<string, unknown> }>;
  authorization?: unknown;
};

async function configOf(root: string): Promise<ConfigFile> {
  return (await readJson(join(root, "config.json"))) as ConfigFile;
}

async function connectionsOf(root: string): Promise<ConfigFile["connections"]> {
  return (await configOf(root)).connections;
}

function parked(value: unknown): { form: "ui"; pending: string; body: string } {
  if (!isUiForm(value)) throw new Error(`expected parked ui, got ${JSON.stringify(value)}`);
  return value;
}

function urlFromPark(body: string): URL {
  const match = /:url "([^"]+)"/.exec(body);
  if (match === null) throw new Error(`parked body has no url: ${body}`);
  return new URL(match[1]!.replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
}
