/**
 * The class is the driver; an instance is one live MCP Streamable HTTP connection.
 * Load writes tools onto state. Work is handle → resolve → actor.
 * Bearer token lives on this.secrets (secrets.json), not on catalog tools.
 *
 * One Transport `fetch`: handshake while `!bootstrapDone` (401 on the wire),
 * send after `bootstrapDone` (wait then stamp). TFRP refresh lives on this
 * handle when `refresh_token` / `expires_at` exist — not on PEWDriver.
 */
import { step } from "@inhuman.tools/harness-diagnostics";
import type { McpToolExpectation } from "@inhuman.tools/harness-model";
import { ConnectionMiss } from "@inhuman.tools/plexus-expectations/driver";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { action, computed, type IReactionDisposer, observable, reaction, runInAction, when } from "mobx";

import { OIDC_REFRESH_BACKOFF_MS, OIDC_REFRESH_MS, OIDC_REFRESH_SKEW_MS } from "@/providers/auth";

import { McpHttpToolActor } from "./actor.js";
import { isMcpEnabled, stampBearer } from "./config.js";
import { type FetchInput, type HeaderInit, wrapFetchFailure } from "./fetch.js";
import { McpDriverConnection } from "./mcp-connection.js";
import { isMcpAuthChallenge, refreshMcpHttpToken } from "./oauth.js";
import { mcpHttpConfigurationSchema, mcpSecretsSchema, type McpHttpConnectionConfig } from "./schemas/mcp.js";

export type LastChallenge = "none" | 401 | 403;

export class McpHttpDriverConnection extends McpDriverConnection<McpHttpConnectionConfig> {
  static override configurationSchema = mcpHttpConfigurationSchema;
  static override secretsSchema = mcpSecretsSchema;
  static override configurationLabel = "mcp-http";

  protected override createToolActor(expectation: McpToolExpectation): McpHttpToolActor {
    return new McpHttpToolActor(expectation, this);
  }

  #transport: StreamableHTTPClientTransport | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #refreshStop: IReactionDisposer | null = null;
  #refreshing: Promise<void> | null = null;
  @observable accessor #secretRev = 0;
  @observable accessor nowMs = Date.now();
  @observable accessor lastChallenge: LastChallenge = "none";
  @observable accessor refreshFailedAtMs: number | null = null;

  protected readSecrets(): void {
    void this.#secretRev;
  }

  protected secretField(field: string): string | undefined {
    this.readSecrets();
    const value = this.secrets.get(field);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  @computed
  get expiring(): boolean {
    this.readSecrets();
    return mcpAccessExpiring(this.secretField("expires_at"), this.nowMs);
  }

  @computed
  get needsAuth(): boolean {
    this.readSecrets();
    if (this.state.auth === "needs-auth") return true;
    if (this.refreshFailedAtMs != null) return true;
    if (this.lastChallenge !== "none" && this.secretField("refresh_token") === undefined) return true;
    return false;
  }

  @computed
  get fresh(): boolean {
    this.readSecrets();
    if (this.needsAuth || this.expiring) return false;
    const token = this.secretField("token") ?? this.secretField("apiKey");
    return token !== undefined || this.lastChallenge === "none";
  }

  @action
  tick(now = Date.now()): void {
    this.nowMs = now;
  }

  @action
  noteChallenge(status: number): void {
    this.lastChallenge = status === 403 ? 403 : 401;
    step(
      `challenge ${status}: connection=${this.connectionId} refreshToken=${this.secretField("refresh_token") === undefined ? "no" : "yes"}`,
    );
  }

  @action
  protected mergeSecrets(next: Record<string, string>): void {
    const bag: Record<string, string> = {};
    const current = this.secrets.all?.() ?? {};
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === "string" && value.length > 0) bag[key] = value;
    }
    Object.assign(bag, next);
    this.#secretRev += 1;
    if (this.secrets.replace === undefined) {
      this.secrets = { get: (field) => bag[field], all: () => bag };
    } else {
      this.secrets.replace(bag);
    }
  }

  @action
  protected depositSecrets(next: Record<string, string>): void {
    this.lastChallenge = "none";
    this.refreshFailedAtMs = null;
    this.mergeSecrets(next);
  }

  stamp(init?: HeaderInit): Record<string, string> {
    return stampBearer(this.secrets, this.settings.headers, init);
  }

  async handshakeFetch(input: FetchInput, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    return fetch(input, {
      ...init,
      headers: this.stamp(init?.headers),
      signal: signal ?? init?.signal,
    });
  }

  async authorizedFetch(input: FetchInput, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    const waitSignal = signal ?? init?.signal ?? undefined;
    const started = Date.now();
    const sendReady = (): boolean =>
      (this.readyState === "ready" && this.fresh) || this.needsAuth || this.readyState === "failed";
    try {
      await (waitSignal === undefined ? when(sendReady) : when(sendReady, { signal: waitSignal }));
    } catch (error) {
      if (waitSignal?.reason instanceof ConnectionMiss) throw waitSignal.reason;
      throw error;
    }
    step(`wait-fresh: connection=${this.connectionId} ms=${Date.now() - started}`);
    if (this.needsAuth) {
      throw new ConnectionMiss("needs-auth", `connection ${this.connectionId} needs auth`);
    }
    if (this.readyState === "failed" || !this.fresh) {
      throw new ConnectionMiss("not-ready", `connection ${this.connectionId} is not send-ready`);
    }
    const res = await fetch(input, {
      ...init,
      headers: this.stamp(init?.headers),
      signal: waitSignal,
    });
    if (res.status === 401 || res.status === 403) {
      runInAction(() => {
        this.noteChallenge(res.status);
      });
    }
    return res;
  }

  readonly #transportFetch = (input: FetchInput, init?: RequestInit): Promise<Response> =>
    this.bootstrapDone ? this.authorizedFetch(input, init) : this.handshakeFetch(input, init);

  override async bootstrap(): Promise<void> {
    this.#startClock();
    this.startFreshnessWatch();
    if (!isMcpEnabled(this.settings)) {
      this.state.tools = [];
      this.state.auth = undefined;
      return;
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.settings.url), {
      fetch: this.#transportFetch as typeof fetch,
    });
    const prevOnClose = transport.onclose;
    // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses onclose callback, not EventTarget
    transport.onclose = () => {
      try {
        prevOnClose?.();
      } catch {
        /* ignore */
      }
      if (this.#transport === transport) {
        this.client = null;
        this.#transport = null;
        if (this.bootstrapDone) this.failReady(new Error("mcp-http: transport closed"));
      }
    };
    let client;
    try {
      client = await this.connectMcpClient(transport);
      this.#transport = transport;
    } catch (error) {
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      if (isMcpAuthChallenge(error, this.secrets, this.settings)) {
        this.state.auth = "needs-auth";
        this.state.tools = [];
        return;
      }
      throw wrapFetchFailure(error, {
        why: "mcp connect",
        url: this.settings.url,
      });
    }
    this.state.auth = undefined;
    this.state.tools = [...(await this.requestMcpListTools(client))];
  }

  #startClock(): void {
    if (this.#tickTimer !== null) return;
    this.#tickTimer = setInterval(() => {
      this.tick();
    }, OIDC_REFRESH_MS);
    this.#tickTimer.unref?.();
  }

  protected startFreshnessWatch(): void {
    if (this.#refreshStop !== null) return;
    this.#refreshStop = reaction(
      () => {
        this.readSecrets();
        const backoffOk =
          this.refreshFailedAtMs == null || this.nowMs - this.refreshFailedAtMs >= OIDC_REFRESH_BACKOFF_MS;
        const eligible =
          (this.expiring || this.lastChallenge !== "none") &&
          this.secretField("refresh_token") !== undefined &&
          this.secretField("token_endpoint") !== undefined &&
          !this.needsAuth &&
          backoffOk;
        return eligible ? this.nowMs : 0;
      },
      (whenMs) => {
        if (whenMs !== 0) void this.refreshSession();
      },
      { fireImmediately: true },
    );
  }

  async refreshSession(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing;
    const pending = this.#refreshOnce().finally(() => {
      if (this.#refreshing === pending) this.#refreshing = null;
    });
    this.#refreshing = pending;
    return pending;
  }

  async #refreshOnce(): Promise<void> {
    const refreshToken = this.secretField("refresh_token");
    const tokenEndpoint = this.secretField("token_endpoint");
    if (refreshToken === undefined || tokenEndpoint === undefined) return;
    if (!(this.expiring || this.lastChallenge !== "none")) return;
    step(`refresh start: connection=${this.connectionId}`);
    try {
      const current = this.secrets.all?.() ?? {};
      const bag: Record<string, string> = {};
      for (const [key, value] of Object.entries(current)) {
        if (typeof value === "string" && value.length > 0) bag[key] = value;
      }
      this.depositSecrets(await refreshMcpHttpToken(bag));
      step(`refresh ok: connection=${this.connectionId}`);
    } catch {
      runInAction(() => {
        this.refreshFailedAtMs = this.nowMs;
      });
      step(`refresh fail: connection=${this.connectionId}`);
    }
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    this.#refreshStop?.();
    this.#refreshStop = null;
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    const client = this.client;
    const transport = this.#transport;
    this.client = null;
    this.#transport = null;
    if (transport) {
      try {
        // eslint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses onclose callback, not EventTarget
        transport.onclose = undefined;
      } catch {
        /* ignore */
      }
    }
    try {
      if (client && typeof client.close === "function") await client.close();
    } catch {
      /* ignore */
    }
    try {
      if (transport && typeof transport.close === "function") await transport.close();
    } catch {
      /* ignore */
    }
  }
}

/** `expires_at` is unix seconds (MCP OAuth) or an ISO string. Absent / unparseable is not expired. */
export function mcpAccessExpiring(expiresAt: string | undefined, nowMs: number): boolean {
  if (expiresAt === undefined || expiresAt.trim() === "") return false;
  const asNum = Number(expiresAt);
  const atMs = Number.isFinite(asNum) && asNum > 0 ? (asNum < 1e12 ? asNum * 1000 : asNum) : Date.parse(expiresAt);
  if (!Number.isFinite(atMs)) return false;
  return atMs - nowMs <= OIDC_REFRESH_SKEW_MS;
}
