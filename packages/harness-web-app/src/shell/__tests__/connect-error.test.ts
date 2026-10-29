import { describe, expect, it } from "vitest";

import { connectError } from "../connect-error.js";

describe("connect errors", () => {
  it("says a refused connection did not answer, and keeps the daemon line", () => {
    expect(connectError("DeepSeek", "connect ECONNREFUSED 127.0.0.1:7788")).toEqual({
      kind: "connection",
      summary: "DeepSeek didn’t answer on this machine. Check it’s running, then retry.",
      detail: "connect ECONNREFUSED 127.0.0.1:7788",
    });
    expect(connectError("Ollama", "connection refused").summary).toBe(
      "Ollama didn’t answer on this machine. Check it’s running, then retry.",
    );
  });

  it("says a timeout got no answer", () => {
    for (const message of [
      "Connect Timeout Error",
      "Headers Timeout Error",
      "ETIMEDOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "The operation timed out",
    ]) {
      expect(connectError("Groq", message)).toEqual({
        kind: "connection",
        summary: "No answer from Groq.",
        detail: message,
      });
    }
  });

  it("says a 401 or 403 refused the key and says to reconnect", () => {
    for (const message of [
      "completion POST https://api.openai.com/v1/chat/completions: HTTP 401 nope",
      "HTTP 403",
      "401 Unauthorized",
      "403 Forbidden",
      "status code 401",
    ]) {
      expect(connectError("OpenAI", message)).toEqual({
        kind: "auth",
        summary: "The key was refused. Reconnect.",
        detail: message,
      });
    }
  });

  it("prefers a refused key over a timeout word in the same line", () => {
    expect(connectError("OpenAI", "HTTP 401 after timeout")).toMatchObject({
      kind: "auth",
      summary: "The key was refused. Reconnect.",
    });
  });

  it("leaves a message it does not recognize as the sentence", () => {
    expect(connectError("Groq", "socket closed")).toEqual({
      kind: "connection",
      summary: "socket closed",
      detail: null,
    });
    expect(connectError("Groq", "The daemon gave an answer this page does not know.")).toEqual({
      kind: "connection",
      summary: "The daemon gave an answer this page does not know.",
      detail: null,
    });
  });

  it("names a provider when the call site has none, and a blank failure still has a sentence", () => {
    expect(connectError("  ", "ECONNREFUSED").summary).toBe(
      "The provider didn’t answer on this machine. Check it’s running, then retry.",
    );
    expect(connectError("Groq", "  ")).toEqual({
      kind: "connection",
      summary: "Couldn’t connect to Groq.",
      detail: null,
    });
  });
});
