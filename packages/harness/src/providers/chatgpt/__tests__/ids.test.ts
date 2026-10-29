import { isDriverConnectionClass } from "@inhuman.tools/plexus-expectations/driver";
import { describe, expect, it } from "vitest";

import { ChatGptDriverConnection, CHATGPT_CLIENT_VERSION } from "../index.js";

describe("chatgpt driver identity", () => {
  it("keeps the chatgpt driver id, Codex catalog client, and PEW class", () => {
    expect(ChatGptDriverConnection.configurationLabel).toBe("chatgpt");
    expect(ChatGptDriverConnection.oidcProfile.driver).toBe("chatgpt");
    expect(ChatGptDriverConnection.oidcProfile.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(ChatGptDriverConnection.oidcProfile.clientId).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(ChatGptDriverConnection.oidcProfile.extraAuthorize).toEqual({
      originator: "codex_cli_rs",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    });
    expect(CHATGPT_CLIENT_VERSION).toBe("1.0.0");
    expect(ChatGptDriverConnection.offers).toEqual([
      {
        name: "ChatGPT",
        description: "ChatGPT subscription",
        live: true,
        adoptable: true,
        settings: { baseUrl: "https://chatgpt.com/backend-api/codex" },
      },
    ]);
    expect(isDriverConnectionClass(ChatGptDriverConnection)).toBe(true);
    const connection = new ChatGptDriverConnection("chatgpt", {
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    expect(connection.completionApi()).toBe("responses");
    expect(connection.completionRequestUrl()).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(connection.cacheFlavor()).toBe("chatgpt");
    expect(connection.cacheAffinity("sess", "gpt-5.4")).toEqual({
      headers: { "session-id": "sess", "thread-id": "sess" },
      body: { prompt_cache_key: "sess" },
    });
    expect(connection.cacheAffinity("sess", "gpt-5.6-sol").body).toEqual({
      prompt_cache_key: "sess",
    });
    expect("prompt_cache_options" in connection.cacheAffinity("sess", "gpt-5.6-sol").body).toBe(false);
  });
});
