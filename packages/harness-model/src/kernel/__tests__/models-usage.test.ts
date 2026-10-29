import { expect, test } from "vitest";

import { KernelRoot } from "../KernelRoot.js";

test("stampModelUsage writes connection/model recency and ignores empty sides", () => {
  const root = new KernelRoot();
  root.stampModelUsage("openai", "chatgpt-5.6-luna", 10);
  root.stampModelUsage("openrouter", "anthropic/claude-sonnet", 20);
  root.stampModelUsage("", "ghost", 30);
  root.stampModelUsage("openai", "  ", 40);
  expect(root.modelsUsage).toEqual({
    "openai/chatgpt-5.6-luna": 10,
    "openrouter/anthropic/claude-sonnet": 20,
  });
  expect(root.lastUsedConnectionModel).toEqual({
    openai: "chatgpt-5.6-luna",
    openrouter: "anthropic/claude-sonnet",
  });
});

test("stampModelUsage last-used index keeps the most recent model per connection", () => {
  const root = new KernelRoot();
  root.stampModelUsage("openai", "gpt-4", 10);
  root.stampModelUsage("openai", "gpt-5", 20);
  expect(root.lastUsedConnectionModel).toEqual({ openai: "gpt-5" });
});
