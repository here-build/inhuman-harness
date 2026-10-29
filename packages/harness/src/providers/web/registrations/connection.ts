/**
 * Shared PEW connection for web-search vendor drivers.
 * Bootstrap is a no-op — HTTP is per interned method.
 */
import {
  WebExtractExpectation,
  type WebExtractResult,
  WebSearchExpectation,
  type WebSearchResult,
} from "@inhuman.tools/harness-model";
import { ConnectionMiss, type ExpectationActor, PEWDriver } from "@inhuman.tools/plexus-expectations/driver";
import { computed, when } from "mobx";

import { WebSearchActor } from "./actor.js";
import { asAdoptString, type AdoptCallback, type DriverAdoptArgs, type DriverAdoptBags } from "./adopt.js";
import { WebExtractActor } from "./extract-actor.js";
import { extractWithFailover, searchWithFailover } from "./ring.js";
import { extractVendor, KEYLESS_SESSION_ID, publicHttpUrl, searchVendor, type KeylessVendor } from "../wire/index.js";

export abstract class WebSearchDriverConnection extends PEWDriver<
  WebSearchExpectation | WebExtractExpectation,
  Readonly<Record<string, unknown>>
> {
  abstract readonly vendor: KeylessVendor | "keyless";

  override async bootstrap(): Promise<void> {}

  @computed
  get expiring(): boolean {
    return false;
  }

  @computed
  get needsAuth(): boolean {
    return this.vendor !== "keyless" && this.apiKey() === undefined;
  }

  @computed
  get fresh(): boolean {
    return !this.needsAuth;
  }

  async #waitSendReady(signal?: AbortSignal): Promise<void> {
    const sendReady = (): boolean =>
      (this.readyState === "ready" && this.fresh) || this.needsAuth || this.readyState === "failed";
    try {
      await (signal === undefined ? when(sendReady) : when(sendReady, { signal }));
    } catch (error) {
      if (signal?.reason instanceof ConnectionMiss) throw signal.reason;
      throw error;
    }
    if (this.needsAuth) throw new ConnectionMiss("needs-auth", `connection ${this.connectionId} needs auth`);
    if (this.readyState === "failed" || !this.fresh) {
      throw new ConnectionMiss("not-ready", `connection ${this.connectionId} is not send-ready`);
    }
  }

  async webSearch(req: {
    readonly query: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WebSearchResult> {
    await this.#waitSendReady(req.signal);
    const query = req.query.trim();
    if (query === "")
      return { ok: false, text: "web_search: query is required — call web_search again with the text to search for" };
    const limit = req.limit ?? 5;
    const signal = req.signal ?? AbortSignal.timeout(120_000);
    const sessionId = KEYLESS_SESSION_ID;
    const outcome =
      this.vendor === "keyless"
        ? await searchWithFailover({ query, limit, signal, sessionId })
        : await searchVendor(this.vendor, {
            query,
            limit,
            signal,
            sessionId,
            apiKey: this.apiKey(),
            apiUrl: this.apiUrl(),
          });
    if (outcome.ok) {
      return {
        ok: true,
        value: { results: [...outcome.hits], provider: outcome.vendor },
      };
    }
    return { ok: false, text: outcome.error };
  }

  async webExtract(req: {
    readonly url: string;
    readonly charLimit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WebExtractResult> {
    await this.#waitSendReady(req.signal);
    const raw = req.url.trim();
    if (raw === "")
      return { ok: false, text: "web_extract: url is required — call web_extract again with the page url" };
    try {
      publicHttpUrl(raw);
    } catch (error) {
      return {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      };
    }
    const charLimit = req.charLimit ?? 15_000;
    const signal = req.signal ?? AbortSignal.timeout(120_000);
    const sessionId = KEYLESS_SESSION_ID;
    const outcome =
      this.vendor === "keyless"
        ? await extractWithFailover({
            url: raw,
            charLimit,
            signal,
            sessionId,
          })
        : await extractVendor(this.vendor, {
            url: raw,
            charLimit,
            signal,
            sessionId,
            apiKey: this.apiKey(),
            apiUrl: this.apiUrl(),
          });
    if (outcome.ok) {
      return {
        ok: true,
        value: {
          url: outcome.url,
          requestedUrl: outcome.requestedUrl,
          ...(outcome.sourceUrl === undefined ? {} : { sourceUrl: outcome.sourceUrl }),
          provenance: outcome.sourceUrl === undefined ? "unavailable" : "provider-reported",
          ...(outcome.title === "" ? {} : { title: outcome.title }),
          markdown: outcome.markdown,
          provider: outcome.vendor,
          ...(outcome.truncated ? { truncated: true } : {}),
        },
      };
    }
    return { ok: false, text: outcome.error };
  }

  protected override resolve(
    expectation: WebSearchExpectation | WebExtractExpectation,
  ): ExpectationActor<WebSearchExpectation | WebExtractExpectation> {
    if (expectation instanceof WebExtractExpectation) return new WebExtractActor(expectation, this);
    return new WebSearchActor(expectation, this);
  }

  apiKey(): string | undefined {
    const key = this.secrets.get("apiKey");
    return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
  }

  apiUrl(): string | undefined {
    const url = this.settings.apiUrl;
    return typeof url === "string" && url.trim() !== "" ? url.trim() : undefined;
  }
}

export async function adoptApiKey(
  label: string,
  args: DriverAdoptArgs,
  callback: AdoptCallback,
): Promise<DriverAdoptBags> {
  const { input } = await callback(
    "UI",
    `(harness/input :name "${label} API key" :description "Required." :secret #t)`,
  );
  const key = asAdoptString(input);
  if (key === "") throw new Error(`${label} API key is required`);
  const name = (args.name ?? "").trim() || label.toLowerCase();
  return {
    name,
    settings: { ...(args.settings ?? {}) },
    secrets: { apiKey: key },
  };
}
