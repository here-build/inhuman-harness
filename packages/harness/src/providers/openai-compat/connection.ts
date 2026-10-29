/**
 * The class is the driver; an instance is one live openai-compat connection.
 * Bootstrap handshakes GET {baseUrl}/models. The actor owns the chat turn.
 *
 * Wire history is viewWire over the PEW spine, not a connection bag.
 *
 * Adopt parks an optional API key via `callback("UI", …)`; bootstrap reads
 * `apiKey` from `this.secrets`.
 *
 * TFRP FRESHNESS: `nowMs` / `lastChallenge` / `refreshFailedAtMs` are own
 * handle fields — never keys of `state`, never `spec.live`. The published face
 * is `state.auth` (`"needs-auth"` while `needsAuth`). The kernel mirror copies
 * that onto `spec.live`. Clock is `@action tick` (no `Date.now()` in a
 * computed). `fresh` is per class: empty-key compat is fresh without a token.
 *
 * Two fetch doors — not a public `send()`, no 401 retry, no `refreshSession()`
 * from a fetch site:
 * - handshake (`#probe`, hydrate, probeAccount, anything awaited inside
 *   `bootstrap()`): always hits the wire; never waits send-ready.
 * - send (actor, Grok webSearch, `#accountLoop` after `bootstrapDone`):
 *   `when ((ready && fresh) || needsAuth || failed)` then stamp (stamp wins
 *   `init.headers`) then fetch once.
 */
import { step, trace } from "@inhuman.tools/harness-diagnostics";
import { CompletionExpectation } from "@inhuman.tools/harness-model";
import type { CompleteResult, ConnectionCompleteRequest } from "@inhuman.tools/harness-provider-sdk";
import {
  ConnectionMiss,
  type DriverOffer,
  type ExpectationActor,
  PEWDriver,
} from "@inhuman.tools/plexus-expectations/driver";
import { action, autorun, computed, type IReactionDisposer, observable, runInAction, when } from "mobx";
import invariant from "tiny-invariant";

import { accountGetterFor, paintAccountHint } from "./account-look.js";
import { OpenAiCompatChatActor, OpenAiCompatResponsesActor } from "./actor.js";
import { type AdoptCallback, asAdoptString, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { type AccountSnapshot, maskSecret } from "./api-extensions/index.js";
import {
  cacheAffinityFor,
  cacheFlavorFromBaseUrl,
  probeCachePolicy,
  type CacheAffinity,
  type CacheAffinityRequest,
  type CacheFlavor,
} from "./cache-affinity.js";
import { describeFetchLine, describeHttpFailure, REQUEST_TIMEOUT_MS, wrapFetchFailure } from "./fetch-failure.js";
import { headersRecord, type FetchInput, type HeaderInit } from "./fetch-types.js";
import { detectedLocalOffers } from "./local-offers.js";
import { CUSTOM_OFFER, isLoopbackBaseUrl, nameFromBaseUrl, REMOTE_OFFERS } from "./presence.js";
import { reasoningFlavorFromBaseUrl, type ReasoningFlavor } from "./reasoning-flavor.js";
import {
  openaiCompatConfigurationSchema,
  type OpenaiCompatConnectionConfig,
  openaiCompatSecretsSchema,
} from "./schema.js";

const HEALTH_MS = 30_000;
/** Looking (focused / ambient occupancy) quota poll. */
export const ACCOUNT_STALE_MS = 45_000;
/** Interned but nobody looking — slow heartbeat so Ctrl overlay is not empty. */
export const ACCOUNT_IDLE_MS = 5 * 60_000;
/** Same period as `OIDC_REFRESH_MS` — tick is the event source, not a refresh call. */
const CLOCK_TICK_MS = 60_000;
/** Local OpenAI-compat (LM Studio / Ollama) answers in milliseconds. */
export const LOCAL_HANDSHAKE_MS = 2500;
/** Remote catalogs (OpenRouter, Grok proxy, ChatGPT) need a real RTT. */
export const REMOTE_HANDSHAKE_MS = REQUEST_TIMEOUT_MS;

/** Detected-offers state per driver class — each class reads its own demand. */
const detectedByClass = new WeakMap<object, ReturnType<typeof detectedLocalOffers>>();

function detectedFor(cls: typeof OpenAiCompatDriverConnection) {
  let box = detectedByClass.get(cls);
  if (box === undefined) {
    box = detectedLocalOffers({
      looking: () => cls.revalidationDemand !== "none",
      fetch: () => cls.probeFetch,
    });
    detectedByClass.set(cls, box);
  }
  return box;
}

export type LastChallenge = "none" | 401 | 403;

export function handshakeTimeoutMs(url: string): number {
  try {
    const host = new URL(url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return LOCAL_HANDSHAKE_MS;
  } catch {
    /* keep remote */
  }
  return REMOTE_HANDSHAKE_MS;
}

/** OpenAI-compat extras: invocation catalog plus the account/key face. */
export function openaiCompatLiveState(): {
  catalogName: string;
  account: AccountSnapshot | undefined;
  keyMask: string;
  /** `undefined` is omitted by the kernel mirror, which clears a previous `"needs-auth"` on `spec.live`. */
  auth: "needs-auth" | undefined;
  models: string[];
  windows: Record<string, number>;
} {
  return {
    catalogName: "",
    account: undefined,
    keyMask: "",
    auth: undefined,
    models: [],
    windows: {},
  };
}

export class OpenAiCompatDriverConnection extends PEWDriver<CompletionExpectation, OpenaiCompatConnectionConfig> {
  static override configurationSchema = openaiCompatConfigurationSchema;
  static override secretsSchema = openaiCompatSecretsSchema;
  static override configurationLabel = "openai-compat";

  /** Probe transport for local detection. Tests swap it. */
  static probeFetch: typeof fetch = (input, init) => fetch(input, init);

  /**
   * Detected local servers, then the custom door, then key-only catalogs. The
   * detected part is observable and wakes under an observer (the catalog
   * mirror); a plain read sees whatever was last probed.
   */
  static get offers(): readonly DriverOffer[] {
    return [...detectedFor(this).get(), CUSTOM_OFFER, ...REMOTE_OFFERS];
  }

  /**
   * Loopback baseUrl: no questions. Remote baseUrl (a catalog offer): one
   * required key. No baseUrl (custom): ask for it, key optional.
   */
  static async adopt(args: DriverAdoptArgs, callback: AdoptCallback): Promise<DriverAdoptBags> {
    const settings = { ...(args.settings ?? {}) };
    const custom = asAdoptString(settings.baseUrl) === "";
    let baseUrl = asAdoptString(settings.baseUrl);
    if (custom) {
      const { input } = await callback(
        "UI",
        '(harness/input :name "Base URL" :description "OpenAI-compatible endpoint")',
      );
      baseUrl = asAdoptString(input);
    }
    settings.baseUrl = baseUrl;
    const fallback = (args.name ?? "").trim();
    const name =
      fallback === "" || fallback === "openai-compat" || fallback === "OpenAI-compatible"
        ? (nameFromBaseUrl(baseUrl) ?? (fallback || "openai-compat"))
        : fallback;
    const secrets: Record<string, string> = {};
    if (custom) {
      const { input: apiKey } = await callback(
        "UI",
        '(harness/input :name "API key" :description "Optional. Empty to skip." :secret #t)',
      );
      const key = asAdoptString(apiKey);
      if (key !== "") secrets.apiKey = key;
    } else if (!isLoopbackBaseUrl(baseUrl) && asAdoptString(args.secrets?.apiKey) === "") {
      const quotedHint = `"${`${name} API key`.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`;
      const { input: apiKey } = await callback(
        "UI",
        `(harness/input :name "API key" :description ${quotedHint} :secret #t)`,
      );
      const key = asAdoptString(apiKey);
      if (key === "") throw new Error(`${name} needs an API key`);
      secrets.apiKey = key;
    }
    return { name, settings, secrets };
  }

  #baseUrl = "";
  #headers: Readonly<Record<string, string>> = {};
  /** Flavor learned from a live probe; wins over the hostname guess. */
  #detectedFlavor: CacheFlavor | null = null;
  #healthy = false;
  readonly #inflight = new Set<AbortController>();
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  #tickTimer: ReturnType<typeof setInterval> | null = null;
  #accountLoop: ReturnType<typeof setInterval> | null = null;
  #accountPeriod = 0;
  #accountInflight: Promise<void> | null = null;
  #accountStop: IReactionDisposer | null = null;
  #account: AccountSnapshot | undefined;
  #refreshing: Promise<void> | null = null;
  @observable accessor #secretRev = 0;
  @observable accessor nowMs = Date.now();
  @observable accessor lastChallenge: LastChallenge = "none";
  @observable accessor refreshFailedAtMs: number | null = null;
  @observable.shallow override accessor state = openaiCompatLiveState();

  get alive(): boolean {
    return this.#healthy;
  }

  /** Secret bag changed — computeds read this, not `Date.now()`, then `secrets.get`. */
  protected readSecrets(): void {
    void this.#secretRev;
  }

  @computed
  get expiring(): boolean {
    return false;
  }

  /**
   * Static key: lastChallenge with a configured key. Empty key is not ceremony.
   * PR4: a send 401 is `noteChallenge`, not catalog `noteFail`.
   */
  @computed
  get needsAuth(): boolean {
    this.readSecrets();
    return this.secretField("apiKey") !== undefined && this.lastChallenge !== "none";
  }

  @computed
  get fresh(): boolean {
    return !this.expiring && !this.needsAuth;
  }

  @action
  tick(now = Date.now()): void {
    this.nowMs = now;
  }

  @action
  noteChallenge(status: number): void {
    this.lastChallenge = status === 403 ? 403 : 401;
    this.publishAuth();
    step(
      `challenge ${status}: connection=${this.connectionId} refreshToken=${this.secretField("refreshToken") === undefined ? "no" : "yes"}`,
    );
  }

  @action
  protected publishAuth(): void {
    this.state.auth = this.needsAuth ? "needs-auth" : undefined;
  }

  @action
  protected noteRefreshFailed(): void {
    this.refreshFailedAtMs = this.nowMs;
    this.publishAuth();
  }

  /** Persist a bag. Identity hydrate uses this; a token grant uses {@link depositSecrets}. */
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
      this.secrets = {
        get: (field) => bag[field],
        all: () => bag,
      };
    } else {
      this.secrets.replace(bag);
    }
    this.reportLive();
  }

  /**
   * Token grant. Clears `lastChallenge` and `refreshFailedAtMs` so a grant
   * does not keep the standing reaction eligible forever.
   */
  @action
  protected depositSecrets(next: Record<string, string>): void {
    this.lastChallenge = "none";
    this.refreshFailedAtMs = null;
    this.mergeSecrets(next);
  }

  /** Coalesced grant. Fetch sites do not call this. */
  async refreshSession(): Promise<void> {
    if (this.#refreshing !== null) return this.#refreshing;
    const pending = this.refreshGrant().finally(() => {
      if (this.#refreshing === pending) this.#refreshing = null;
    });
    this.#refreshing = pending;
    return pending;
  }

  protected async refreshGrant(): Promise<void> {}

  override async bootstrap(): Promise<void> {
    this.#baseUrl = this.settings.baseUrl;
    this.#headers = this.settings.headers ?? {};
    this.#healthy = false;
    this.reportLive();
    this.#startClock();

    await this.#probe();
    void this.#probeCacheFlavor(this.state.models).catch(() => {});
    this.#healthTimer = setInterval(() => {
      void this.#probe().catch(() => {});
    }, HEALTH_MS);
    this.#healthTimer.unref?.();
    this.#accountStop = autorun(() => {
      if (!this.accountPolls()) {
        this.#stopAccountLoop();
        return;
      }
      const looking = this.revalidationDemand !== "none";
      if (looking) void this.#refreshAccount();
      this.#restartAccountLoop(looking ? ACCOUNT_STALE_MS : ACCOUNT_IDLE_MS);
    });
    if (this.accountPolls()) void this.#refreshAccount();
  }

  #startClock(): void {
    if (this.#tickTimer !== null) return;
    this.#tickTimer = setInterval(() => {
      this.tick();
    }, CLOCK_TICK_MS);
    this.#tickTimer.unref?.();
  }

  protected modelsRequestUrl(): string {
    return `${this.#baseUrl}/models`;
  }

  completionRequestUrl(): string {
    return `${this.#baseUrl}/chat/completions`;
  }

  responsesRequestUrl(): string {
    return `${this.#baseUrl || this.settings.baseUrl}/responses`;
  }

  completionApi(): "chat" | "responses" {
    return "chat";
  }

  async #probe(): Promise<void> {
    const url = this.modelsRequestUrl();
    let response: Response;
    try {
      response = await this.#fetchWithTimeout(url, undefined, handshakeTimeoutMs(url));
    } catch (error) {
      this.#noteProbeFail(error);
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!response.ok) {
      const body = await response.text();
      const detail = body.trim().slice(0, 240);
      const error = new Error(
        describeHttpFailure({
          why: "models probe",
          method: "GET",
          url,
          status: response.status,
          detail,
        }),
      );
      this.#noteProbeFail(error);
      throw error;
    }
    const ids: string[] = [];
    const windows: Record<string, number> = {};
    for (const row of modelRows(await response.json())) {
      const id = modelId(row);
      if (id === null) continue;
      ids.push(id);
      const window = contextWindowOf(row);
      if (window != null) windows[id] = window;
    }
    const manual = this.settings.contextWindow;
    for (const id of ids) {
      const key = `${this.connectionId}:${id}`;
      const override = manual?.[key];
      if (typeof override === "number" && Number.isFinite(override) && override > 0) {
        windows[id] = Math.trunc(override);
      }
    }
    runInAction(() => {
      this.state.models = ids;
      this.state.windows = windows;
      this.#healthy = true;
    });
    this.#noteOk();
    step(
      `probe completed: connection=${this.connectionId} healthy=true models=${ids.length} ${ids.length === 0 ? "(none)" : ids.slice(0, 8).join(",") + (ids.length > 8 ? ",…" : "")}`,
    );
  }

  /**
   * Learn the cache flavor by probing when the hostname does not pin one.
   * Known hosts (grok/openai/chatgpt/openrouter) keep their hardcoded flavor.
   * Unknown hosts get two warm/repeat calls once per bootstrap; the probe
   * sends no affinity keys, so it is safe against servers that 400 on them.
   *
   * Set `settings.cacheProbe: true` to enable — off by default, since it costs
   * two extra completion calls at bootstrap and writes a POST the operator did
   * not ask for. Enable per connection for an unknown provider.
   */
  async #probeCacheFlavor(models: readonly string[]): Promise<void> {
    if (this.settings.cacheProbe !== true) return;
    // Honor a subclass that pins a flavor: nothing to learn, and probing would
    // overwrite the pin.
    if (this.cacheFlavor() !== "none") {
      this.#detectedFlavor = null;
      return;
    }
    if (models.length === 0) return;
    const model = models[0];
    if (model === "") return;
    const flavor = await probeCachePolicy({
      url: this.completionRequestUrl(),
      headers: this.#headers,
      model,
      fetch: (reqUrl, init) => this.handshakeFetch(reqUrl, init),
    });
    runInAction(() => {
      this.#detectedFlavor = flavor;
    });
    step(`cache flavor probed: connection=${this.connectionId} flavor=${flavor} model=${model}`);
  }

  @action
  protected reportLive(): void {
    this.state.catalogName = this.connectionCatalogName();
    this.state.account = this.#account;
    this.state.keyMask = this.connectionKeyMask();
    this.publishAuth();
  }

  protected connectionCatalogName(): string {
    const configured = this.settings.name;
    if (typeof configured === "string" && configured.trim() !== "") return configured;
    const detected = nameFromBaseUrl(this.settings.baseUrl);
    if (detected !== undefined) return detected;
    return this.connectionId;
  }

  protected connectionKeyMask(): string {
    const apiKey = this.secretField("apiKey");
    if (this.#account !== undefined) return paintAccountHint(this.#account, apiKey);
    if (apiKey === undefined) return "";
    return maskSecret(apiKey);
  }

  #stopAccountLoop(): void {
    if (this.#accountLoop !== null) {
      clearInterval(this.#accountLoop);
      this.#accountLoop = null;
    }
    this.#accountPeriod = 0;
  }

  #restartAccountLoop(period: number): void {
    if (this.#accountLoop !== null && this.#accountPeriod === period) return;
    this.#stopAccountLoop();
    this.#accountPeriod = period;
    this.#accountLoop = setInterval(() => {
      void this.#refreshAccount();
    }, period);
    this.#accountLoop.unref?.();
  }

  #refreshAccount(): Promise<void> {
    if (this.#accountInflight !== null) return this.#accountInflight;
    const pending = this.#accountOnce().finally(() => {
      if (this.#accountInflight === pending) this.#accountInflight = null;
    });
    this.#accountInflight = pending;
    return pending;
  }

  async #accountOnce(): Promise<void> {
    try {
      const snap = await this.loadAccount();
      if (snap === undefined) return;
      this.#account = {
        ...snap,
        balanceDetail: {
          ...snap.balanceDetail,
          asOf: new Date().toISOString(),
        },
      };
      this.reportLive();
    } catch (error) {
      // Usage/limits metadata is not handshake. Last snapshot stays on live.account.
      step(
        `account poll failed: connection=${this.connectionId} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** True when this connection has a funds/quota probe. Local hosts stay off. */
  protected accountPolls(): boolean {
    return accountGetterFor(this.#baseUrl) !== undefined;
  }

  /** Handshake until `bootstrapDone`; send after. */
  protected accountDoor(input: FetchInput, init?: RequestInit): Promise<Response> {
    const signal = init?.signal ?? undefined;
    return this.bootstrapDone ? this.authorizedFetch(input, init, signal) : this.handshakeFetch(input, init, signal);
  }

  protected async loadAccount(): Promise<AccountSnapshot | undefined> {
    const getter = accountGetterFor(this.#baseUrl);
    if (getter === undefined) return undefined;
    return getter({
      baseUrl: this.#baseUrl,
      apiKey: this.secretField("apiKey"),
      fetch: (input, init) => this.accountDoor(input, init),
    });
  }

  protected refreshAccount(): Promise<void> {
    return this.#refreshAccount();
  }

  @action
  #noteOk(): void {
    this.readyState = "ready";
    this.error = "";
  }

  @action
  noteFail(error: unknown): void {
    this.readyState = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    step(
      `probe failed: connection=${this.connectionId} healthy=${this.#healthy} models=${this.state.models.length} error=${this.error}`,
    );
  }

  /** Handshake miss is a failure. Refresh miss with a catalog is not. */
  @action
  #noteProbeFail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    step(
      `probe failed: connection=${this.connectionId} healthy=${this.#healthy} models=${this.state.models.length} error=${message}`,
    );
    if (this.state.models.length > 0) return;
    this.readyState = "failed";
    this.error = message;
  }

  trackInflight(abort: AbortController): void {
    this.#inflight.add(abort);
  }

  untrackInflight(abort: AbortController): void {
    this.#inflight.delete(abort);
  }

  override abortOnDrop(reason: unknown): void {
    super.abortOnDrop(reason);
    for (const abort of this.#inflight) abort.abort(reason);
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    this.#accountStop?.();
    this.#accountStop = null;
    this.#stopAccountLoop();
    if (this.#healthTimer !== null) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    for (const abort of this.#inflight) abort.abort();
    this.#inflight.clear();
    this.#healthy = false;
  }

  /**
   * Wait send-ready, then `handle(round)`. Idempotent under live honor.
   * On abort, abort the interned actor.
   */
  async complete(req: ConnectionCompleteRequest): Promise<CompleteResult> {
    invariant(req.round.plexus != null, "complete: round must be homed");
    const waitSignal = req.signal;
    const sendReady = (): boolean =>
      (this.readyState === "ready" && this.fresh) || this.needsAuth || this.readyState === "failed";
    try {
      await (waitSignal === undefined ? when(sendReady) : when(sendReady, { signal: waitSignal }));
    } catch (error) {
      if (waitSignal?.reason instanceof ConnectionMiss) throw waitSignal.reason;
      throw error;
    }
    if (this.needsAuth) {
      throw new ConnectionMiss("needs-auth", `connection ${this.connectionId} needs auth — reconnect`);
    }
    if (this.readyState === "failed" || !this.fresh) {
      throw new ConnectionMiss("not-ready", `connection ${this.connectionId} is not send-ready`);
    }
    trace("harness:complete", `handle ${req.round.uuid} connection=${this.connectionId} api=${this.completionApi()}`);
    this.handle(req.round);
    const onAbort = (): void => {
      if (!this.has(req.round)) return;
      const actor = this.resolveExpectation(req.round);
      const reason = waitSignal?.reason;
      // A park pauses the round: stop the actor, write no ending. The next wrap
      // appends a fresh round (a new CompletionJob is a new attempt).
      if (reason === "park") {
        actor.abort(reason);
        return;
      }
      if (req.round.failReason == null && reason instanceof Error && reason.message !== "") {
        req.round.failReason = reason.message;
      }
      actor.abort(reason);
      if (!req.round.isDone) actor.admitTermination();
    };
    if (waitSignal !== undefined) {
      if (waitSignal.aborted) onAbort();
      else waitSignal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      await (waitSignal === undefined
        ? when(() => req.round.isDone)
        : when(() => req.round.isDone, { signal: waitSignal }));
    } catch (error) {
      if (waitSignal?.aborted === true && !req.round.isDone) onAbort();
      if (!req.round.isDone) throw error;
    } finally {
      waitSignal?.removeEventListener("abort", onAbort);
    }
    if (this.accountPolls() && waitSignal?.aborted !== true) void this.#refreshAccount();
    if (req.round.outcome !== "successful") {
      const reason = req.round.failReason;
      throw new Error(reason == null ? "completion failed" : reason);
    }
    return {
      text: req.round.responseText,
      ...(req.round.responseThought === "" ? {} : { thought: req.round.responseThought }),
      ...(req.round.responseThoughtKind == null ? {} : { thoughtKind: req.round.responseThoughtKind }),
    };
  }

  protected override resolve(expectation: CompletionExpectation): ExpectationActor<CompletionExpectation> {
    invariant(this.#healthy, "OpenAiCompatDriverConnection.resolve: connection not warmed");
    return this.completionApi() === "responses"
      ? new OpenAiCompatResponsesActor(expectation, this)
      : new OpenAiCompatChatActor(expectation, this);
  }

  /** Pure stamp: current secret + `authHeaders()`. Tests and dumps only. */
  requestHeaders(): Record<string, string> {
    const apiKey = this.secretField("apiKey");
    return {
      "content-type": "application/json",
      ...this.#headers,
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...this.authHeaders(),
    };
  }

  /** Stamp wins colliding keys (case-insensitive). Never another connection's secrets. */
  stamp(init?: HeaderInit): Record<string, string> {
    const out = headersRecord(init);
    for (const [key, value] of Object.entries(this.requestHeaders())) {
      for (const existing of Object.keys(out)) {
        if (existing.toLowerCase() === key.toLowerCase()) delete out[existing];
      }
      out[key] = value;
    }
    return out;
  }

  /**
   * Send door. Wait on the graph; stamp; fetch once. No retry. No `refreshSession()`.
   */
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
      throw new ConnectionMiss("needs-auth", `connection ${this.connectionId} needs auth — reconnect`);
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

  /** Handshake door. Always hits the wire. Never throws on !fresh. Never waits send-ready. */
  async handshakeFetch(input: FetchInput, init?: RequestInit, signal?: AbortSignal): Promise<Response> {
    return fetch(input, {
      ...init,
      headers: this.stamp(init?.headers),
      signal: signal ?? init?.signal,
    });
  }

  /** Extra auth headers for a subscription profile (account id, grok-cli token). */
  protected authHeaders(): Record<string, string> {
    return {};
  }

  protected secretField(field: string): string | undefined {
    this.readSecrets();
    const value = this.secrets.get(field);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  /**
   * Prompt-cache flavor. Subscription drivers override. Hostname tables are
   * the fallback; `#detectedFlavor` wins after a live {@link probeCachePolicy}.
   */
  cacheFlavor(): CacheFlavor {
    return this.#detectedFlavor ?? cacheFlavorFromBaseUrl(this.#baseUrl || this.settings.baseUrl);
  }

  /** Completion-only. Handshake must not send these. */
  cacheAffinity(sessionId: string, model: string, request?: CacheAffinityRequest): CacheAffinity {
    return cacheAffinityFor(this.cacheFlavor(), sessionId, model, request);
  }

  /**
   * Reasoning dialect from host. Cache flavor pins grok/openai/chatgpt/openrouter
   * when a driver stubs it (tests, subscription). Else {@link reasoningFlavorFromBaseUrl}.
   */
  reasoningFlavor(): ReasoningFlavor {
    const cache = this.cacheFlavor();
    if (cache === "grok" || cache === "openai" || cache === "chatgpt" || cache === "openrouter") return cache;
    return reasoningFlavorFromBaseUrl(this.#baseUrl || this.settings.baseUrl);
  }

  async #fetchWithTimeout(url: string, init?: RequestInit, ms = LOCAL_HANDSHAKE_MS): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    const method = typeof init?.method === "string" && init.method.trim() !== "" ? init.method : "GET";
    const where = { why: "models probe", method, url } as const;
    try {
      return await this.handshakeFetch(url, init, ctrl.signal);
    } catch (error) {
      throw ctrl.signal.aborted
        ? new Error(describeFetchLine(where, `timeout after ${ms}ms`))
        : wrapFetchFailure(error, where);
    } finally {
      clearTimeout(timer);
    }
  }
}

function modelRows(raw: unknown): object[] {
  if (typeof raw !== "object" || raw === null) return [];
  const rec = raw as { data?: unknown; models?: unknown };
  const rows = Array.isArray(rec.data) ? rec.data : Array.isArray(rec.models) ? rec.models : [];
  return rows.filter((row): row is object => typeof row === "object" && row !== null);
}

function modelId(row: object): string | null {
  const item = row as { id?: unknown; slug?: unknown };
  const id = typeof item.slug === "string" && item.slug.length > 0 ? item.slug : item.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function contextWindowOf(row: object): number | null {
  const rec = row as Record<string, unknown>;
  const provider = rec.top_provider;
  if (typeof provider === "object" && provider !== null) {
    const routed = positiveInt((provider as { context_length?: unknown }).context_length);
    if (routed != null) return routed;
  }
  const loaded = rec.loaded_instances;
  const loadedWindow =
    Array.isArray(loaded) && typeof loaded[0] === "object" && loaded[0] !== null
      ? positiveInt((loaded[0] as { config?: { context_length?: unknown } }).config?.context_length)
      : null;
  return (
    positiveInt(rec.context_length) ??
    positiveInt(rec.context_window) ??
    positiveInt(rec.max_model_len) ??
    positiveInt(rec.max_context_length) ??
    positiveInt(rec.max_context_window) ??
    loadedWindow
  );
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}
