import { randomBytes } from "node:crypto";

import invariant from "tiny-invariant";

import { authorizeInBrowser, pkceChallenge } from "@/providers/auth";
import {
  getOpenRouterAccount,
  OpenAiCompatDriverConnection,
  type AccountSnapshot,
  type CacheFlavor,
} from "@/providers/openai-compat";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const AUTH_ORIGIN = "https://openrouter.ai";
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";
const KEY_LABEL = "Harness";
const LOGIN_HINT = "Authorize OpenRouter in the browser";

export class OpenRouterDriverConnection extends OpenAiCompatDriverConnection {
  static override configurationLabel = "openrouter";
  static offers = [
    {
      name: "OpenRouter",
      description: "OpenRouter API",
      live: true,
      adoptable: true,
      settings: { baseUrl: OPENROUTER_BASE_URL },
    },
  ];
  static override async adopt(
    args: {
      name?: string;
      settings?: Record<string, unknown>;
      signal?: AbortSignal;
    },
    callback: (kind: "UI", body: string) => Promise<Readonly<Record<string, unknown>>>,
  ): Promise<{
    readonly name?: string;
    readonly settings: Record<string, unknown>;
    readonly secrets: Record<string, string>;
  }> {
    const settings = { ...(args.settings ?? {}), baseUrl: OPENROUTER_BASE_URL };
    const minted = mintOpenRouterPkce();
    const authorized = await authorizeInBrowser((body) => callback("UI", body), {
      authUrl: minted.url,
      description: LOGIN_HINT,
      paste: "Or paste an OpenRouter key",
      signal: args.signal,
    });
    const code = "pasted" in authorized ? authorized.pasted : authorized.code;
    const name = asAdoptString(args.name) || "OpenRouter";
    if (code.startsWith("sk-")) return { name, settings, secrets: { apiKey: code } };
    return {
      name,
      settings,
      secrets: {
        apiKey: await exchangeOpenRouterCode(code, minted.verifier),
      },
    };
  }

  override cacheFlavor(): CacheFlavor {
    return "openrouter";
  }

  protected override accountPolls(): boolean {
    return this.secretField("apiKey") !== undefined;
  }

  protected override async loadAccount(): Promise<AccountSnapshot | undefined> {
    const apiKey = this.secretField("apiKey");
    if (typeof apiKey !== "string") return undefined;
    return getOpenRouterAccount({
      baseUrl: this.settings.baseUrl,
      apiKey,
      fetch: (input, init) => this.accountDoor(input, init),
    });
  }
}

function mintOpenRouterPkce(): { verifier: string; url: string } {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL("/auth", AUTH_ORIGIN);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", KEY_LABEL);
  return { verifier, url: url.toString() };
}

async function exchangeOpenRouterCode(code: string, verifier: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(KEYS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openrouter key exchange POST ${KEYS_URL}: ${message}`, {
      cause: error,
    });
  }
  invariant(response.ok, `OpenRouter key exchange failed (${response.status})`);
  const body: unknown = await response.json();
  const key =
    typeof body === "object" && body !== null && "key" in body && typeof body.key === "string" ? body.key.trim() : "";
  invariant(key !== "", "OpenRouter key exchange returned no key");
  return key;
}

function asAdoptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
