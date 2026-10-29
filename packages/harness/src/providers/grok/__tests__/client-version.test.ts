import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import { afterEach, describe, expect, it } from "vitest";

import { GROK_CLIENT_VERSION, GROK_VERSION_SOURCE } from "../client-version.js";
import { GrokDriverConnection } from "../index.js";
import { installGrokFetch, listenGrok } from "./grok-server.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function header(init: RequestInit | undefined, name: string): string {
  return new Headers(init?.headers).get(name) ?? "";
}

describe("Grok client version", () => {
  it("sends a newer stored version and leaves that setting alone", async () => {
    let version = "";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      version = header(init, "x-grok-client-version");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const patches: Array<Readonly<Record<string, unknown>>> = [];
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1", clientVersion: "9.9.9" },
      { apiKey: "grok-at" },
    );
    connection.bindSettingsWriter((patch) => {
      patches.push(patch);
    });
    try {
      const res = await connection.handshakeFetch("https://cli-chat-proxy.grok.com/v1/user");
      expect(res.status).toBe(200);
      expect(version).toBe("9.9.9");
      expect(patches).toEqual([]);
    } finally {
      await connection[Symbol.asyncDispose]();
    }
  });

  it("raises a stored version below the floor and records the floor", async () => {
    let version = "";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      version = header(init, "x-grok-client-version");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const patches: Array<Readonly<Record<string, unknown>>> = [];
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1", clientVersion: "0.1.202" },
      { apiKey: "grok-at" },
    );
    connection.bindSettingsWriter((patch) => {
      patches.push(patch);
    });
    try {
      await connection.handshakeFetch("https://cli-chat-proxy.grok.com/v1/user");
      expect(version).toBe(GROK_CLIENT_VERSION);
      expect(patches).toEqual([{ clientVersion: GROK_CLIENT_VERSION }]);
    } finally {
      await connection[Symbol.asyncDispose]();
    }
  });

  it("retries an outdated handshake once with the published crate version", async () => {
    const versions: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === GROK_VERSION_SOURCE) {
        return new Response('[package]\nname = "xai-grok-version"\nversion = "9.9.9"\n');
      }
      versions.push(header(init, "x-grok-client-version"));
      if (versions.length === 1) {
        return new Response("Your Grok CLI version (1.0.45) is outdated. Please update to version 1.0.13 or later", {
          status: 426,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const patches: Array<Readonly<Record<string, unknown>>> = [];
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1" },
      { apiKey: "grok-at" },
    );
    connection.bindSettingsWriter((patch) => {
      patches.push(patch);
    });
    try {
      const res = await connection.handshakeFetch("https://cli-chat-proxy.grok.com/v1/user");
      expect(res.status).toBe(200);
      expect(versions).toEqual([GROK_CLIENT_VERSION, "9.9.9"]);
      expect(patches).toEqual([{ clientVersion: GROK_CLIENT_VERSION }, { clientVersion: "9.9.9" }]);
    } finally {
      await connection[Symbol.asyncDispose]();
    }
  });

  it("returns the 426 body when the crate version cannot be read", async () => {
    let cargoHits = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === GROK_VERSION_SOURCE) {
        cargoHits += 1;
        return new Response("not a crate manifest", { status: 200 });
      }
      return new Response("Your Grok CLI version (1.0.45) is outdated.", { status: 426 });
    }) as typeof fetch;
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1" },
      { apiKey: "grok-at" },
    );
    try {
      const res = await connection.handshakeFetch("https://cli-chat-proxy.grok.com/v1/user");
      expect(res.status).toBe(426);
      expect(await res.text()).toContain("outdated");
      expect(cargoHits).toBe(1);
    } finally {
      await connection[Symbol.asyncDispose]();
    }
  });

  it("does not fetch the crate for an unrelated 426", async () => {
    let cargoHits = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) === GROK_VERSION_SOURCE) {
        cargoHits += 1;
        return new Response('[package]\nversion = "9.9.9"\n');
      }
      return new Response("upgrade required", { status: 426 });
    }) as typeof fetch;
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1" },
      { apiKey: "grok-at" },
    );
    try {
      const res = await connection.handshakeFetch("https://cli-chat-proxy.grok.com/v1/user");
      expect(res.status).toBe(426);
      expect(await res.text()).toBe("upgrade required");
      expect(cargoHits).toBe(0);
    } finally {
      await connection[Symbol.asyncDispose]();
    }
  });

  it("retries an outdated completion and stamps the model override on both posts", async () => {
    const restore = installGrokFetch();
    const grok = await listenGrok({
      reply: () => "from-grok",
      chat: (_post, index) =>
        index === 0
          ? {
              status: 426,
              body: {
                error: "Your Grok CLI version (1.0.45) is outdated. Please update to version 1.0.13 or later",
              },
            }
          : undefined,
    });
    const installed = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) === GROK_VERSION_SOURCE) {
        return new Response('[package]\nversion = "9.9.9"\n');
      }
      return installed(input, init);
    }) as typeof fetch;
    const connection = new GrokDriverConnection("row-grok", { baseUrl: grok.baseUrl }, { apiKey: "grok-at" });
    const plexus = SessionPlexus.create("grok-version", "/ws");
    const patches: Array<Readonly<Record<string, unknown>>> = [];
    try {
      await connection.ensureBootstrapStarted();
      connection.bindSettingsWriter((patch) => {
        patches.push(patch);
      });
      const round = new CompletionExpectation({
        promptText: prompt.user`hi`,
        connectionId: "row-grok",
        model: "grok-4",
      });
      plexus.root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: round.promptText,
        doneWork: [new CompletionJob({ expectation: round })],
        queue: [],
      });
      const result = await connection.complete({
        model: "grok-4",
        promptText: "hi",
        round,
      });
      expect(result.text).toBe("from-grok");
      expect(grok.requestHeaders.map((headers) => headers["x-grok-client-version"])).toEqual([
        GROK_CLIENT_VERSION,
        "9.9.9",
      ]);
      expect(grok.requestHeaders.map((headers) => headers["x-grok-model-override"])).toEqual(["grok-4", "grok-4"]);
      expect(patches).toEqual([{ clientVersion: GROK_CLIENT_VERSION }, { clientVersion: "9.9.9" }]);
    } finally {
      plexus.destroy();
      await connection[Symbol.asyncDispose]();
      await grok.close();
      restore();
    }
  });
});
