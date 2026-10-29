import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GrokDriverConnection } from "../index.js";
import { grokHitsFromResponses } from "../search.js";
import { installGrokFetch, listenGrok } from "./grok-server.js";

describe("Grok web search on scripted HTTP", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = installGrokFetch();
  });
  afterEach(() => {
    restore();
  });

  it("posts Responses web_search and returns citation hits", async () => {
    const grok = await listenGrok({
      search: () => ({
        citations: [
          {
            url: "https://example.test/a",
            title: "Alpha",
            snippet: "first",
          },
        ],
        output: [
          {
            type: "message",
            content: [
              {
                annotations: [{ url: "https://example.test/b", title: "Beta" }],
              },
            ],
          },
        ],
      }),
    });
    const connection = new GrokDriverConnection(
      "row-grok",
      { baseUrl: grok.baseUrl, model: "grok-4" },
      { apiKey: "grok-at" },
    );
    try {
      await connection.ensureBootstrapStarted();
      const result = await connection.webSearch({
        query: "tea leaves",
        limit: 5,
      });
      expect(result).toEqual({
        ok: true,
        value: {
          provider: "grok",
          results: [
            { title: "Alpha", url: "https://example.test/a", snippet: "first" },
            { title: "Beta", url: "https://example.test/b", snippet: "" },
          ],
        },
      });
      expect(grok.posts[0]).toEqual({
        model: "grok-4",
        input: "tea leaves",
        tools: [{ type: "web_search" }],
      });
      expect(grok.requestHeaders[0]).toMatchObject({
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-model-override": "grok-4",
        authorization: "Bearer grok-at",
      });
    } finally {
      await connection[Symbol.asyncDispose]();
      await grok.close();
    }
  });

  it("rejects an empty query without hitting the wire", async () => {
    const grok = await listenGrok({ search: () => ({ citations: [] }) });
    const connection = new GrokDriverConnection("row-grok", { baseUrl: grok.baseUrl }, { apiKey: "grok-at" });
    try {
      await connection.ensureBootstrapStarted();
      const result = await connection.webSearch({ query: "  " });
      expect(result).toEqual({
        ok: false,
        text: "web_search: query is required — call web_search again with the text to search for",
      });
      expect(grok.posts).toHaveLength(0);
    } finally {
      await connection[Symbol.asyncDispose]();
      await grok.close();
    }
  });

  it("surfaces HTTP failure text from Responses", async () => {
    const grok = await listenGrok({
      search: () => {
        throw new Error("boom");
      },
    });
    const connection = new GrokDriverConnection("row-grok", { baseUrl: grok.baseUrl }, { apiKey: "grok-at" });
    try {
      await connection.ensureBootstrapStarted();
      const result = await connection.webSearch({ query: "tea" });
      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/HTTP 500/);
    } finally {
      await connection[Symbol.asyncDispose]();
      await grok.close();
    }
  });
});

describe("Grok Responses hit parse", () => {
  it("dedupes citations and annotations, fills hostname titles", () => {
    expect(
      grokHitsFromResponses(
        {
          citations: [
            "https://example.test/a",
            { url: "https://example.test/a", title: "dup" },
            { url: "https://example.test/c", title: "Charlie", snippet: "c" },
          ],
          output: [
            {
              type: "message",
              content: [
                {
                  annotations: [{ url: "https://example.test/d" }],
                },
              ],
            },
          ],
        },
        5,
      ),
    ).toEqual([
      { title: "example.test", url: "https://example.test/a", snippet: "" },
      {
        title: "Charlie",
        url: "https://example.test/c",
        snippet: "c",
      },
      { title: "example.test", url: "https://example.test/d", snippet: "" },
    ]);
  });
});
