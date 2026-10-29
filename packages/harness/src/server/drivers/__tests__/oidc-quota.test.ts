import { describe, expect, it } from "vitest";

import { ChatGptDriverConnection } from "@/providers/chatgpt";
import { GrokDriverConnection } from "@/providers/grok";
import { accountFromChatGptUsage, chatgptUsageUrl, accountFromGrokBilling } from "@/providers/openai-compat";

describe("OIDC subscription quota", () => {
  it.each([
    {
      name: "ChatGPT windows by duration, not primary/secondary seat",
      snap: () =>
        accountFromChatGptUsage({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 33,
              limit_window_seconds: 18_000,
              reset_after_seconds: 7_200,
            },
            secondary_window: {
              used_percent: 12,
              limit_window_seconds: 604_800,
              reset_after_seconds: 432_000,
            },
          },
          credits: { has_credits: true, unlimited: false, balance: "45.25" },
        }),
      extra: (snap: ReturnType<typeof accountFromChatGptUsage>) => ({
        usageUrl: chatgptUsageUrl("https://chatgpt.com/backend-api/codex"),
        plan: snap.identityDetail.plan,
        balance: snap.balance?.balance,
      }),
      wantWindows: [
        { label: "5h", remainingPercent: 67, resetInSec: 7200, resetAt: expect.any(Number), status: "ok" },
        { label: "weekly", remainingPercent: 88, resetInSec: 432000, resetAt: expect.any(Number), status: "ok" },
      ],
      wantExtra: {
        usageUrl: "https://chatgpt.com/backend-api/wham/usage",
        plan: "pro",
        balance: "45.25",
      },
    },
    {
      name: "keeps ChatGPT reset_at as unix seconds",
      snap: () =>
        accountFromChatGptUsage({
          rate_limit: {
            primary_window: {
              used_percent: 33,
              limit_window_seconds: 18_000,
              reset_at: 1_800_000_000,
            },
          },
        }),
      extra: () => ({}),
      wantWindows: [
        {
          label: "5h",
          remainingPercent: 67,
          resetInSec: expect.any(Number),
          resetAt: 1_800_000_000,
          status: "ok",
        },
      ],
      wantExtra: {},
    },
    {
      name: "lone long primary window is weekly when the 5h cap is lifted",
      snap: () =>
        accountFromChatGptUsage({
          rate_limit: {
            primary_window: { usedPercent: 80, limitWindowSeconds: 604_800, resetAfterSeconds: 10 },
            secondary_window: null,
          },
        }),
      extra: () => ({}),
      wantWindows: [
        { label: "weekly", remainingPercent: 20, resetInSec: 10, resetAt: expect.any(Number), status: "ok" },
      ],
      wantExtra: {},
    },
    {
      name: "Grok weekly creditUsagePercent and period end",
      snap: () => {
        const end = new Date(Date.now() + 3_600_000).toISOString();
        return accountFromGrokBilling({
          config: {
            creditUsagePercent: 55.4,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-01T00:00:00Z", end },
          },
        });
      },
      extra: () => ({}),
      wantWindows: [
        {
          label: "weekly",
          remainingPercent: 44.6,
          resetInSec: expect.any(Number),
          resetAt: expect.any(Number),
          status: "ok",
        },
      ],
      wantExtra: {},
    },
  ])("$name", ({ snap, extra, wantWindows, wantExtra }) => {
    const account = snap();
    expect({
      windows: account.balanceDetail?.windows,
      extra: extra(account),
    }).toEqual({
      windows: wantWindows,
      extra: wantExtra,
    });
  });

  it("ChatGPT and Grok poll quota; a usage miss does not fail the wire", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    const meter: Record<string, "ok" | "down"> = { usage: "down", billing: "down" };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/wham/usage")) {
        if (meter.usage === "down") {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
          });
        }
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_after_seconds: 100 },
              secondary_window: { used_percent: 20, limit_window_seconds: 604_800, reset_after_seconds: 200 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/billing")) {
        if (meter.billing === "down") {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
          });
        }
        return new Response(
          JSON.stringify({ config: { creditUsagePercent: 40, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url.includes("/models") ||
        url.includes("/user") ||
        url.includes("userinfo") ||
        url.includes("/oauth/token")
      ) {
        return new Response(JSON.stringify({ data: [{ id: "m1" }], models: [{ slug: "gpt-5.4" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const chatgptSecrets = { apiKey: "at", accountId: "acct" };
    const chatgpt = new ChatGptDriverConnection(
      "chatgpt",
      { baseUrl: "https://chatgpt.com/backend-api/codex" },
      {
        get: (field) => chatgptSecrets[field as keyof typeof chatgptSecrets],
        all: () => chatgptSecrets,
      },
    );
    const grok = new GrokDriverConnection(
      "grok",
      { baseUrl: "https://cli-chat-proxy.grok.com/v1" },
      { get: (field) => (field === "apiKey" ? "at" : undefined), all: () => ({ apiKey: "at" }) },
    );
    try {
      await chatgpt.ensureBootstrapStarted();
      await grok.ensureBootstrapStarted();
      expect({
        chatgpt: { readyState: chatgpt.readyState, error: chatgpt.error, account: chatgpt.state.account },
        grok: { readyState: grok.readyState, error: grok.error, account: grok.state.account },
      }).toEqual({
        chatgpt: { readyState: "ready", error: "", account: undefined },
        grok: { readyState: "ready", error: "", account: undefined },
      });

      meter.usage = "ok";
      meter.billing = "ok";
      await chatgpt["refreshAccount"]();
      await grok["refreshAccount"]();
      const chatgptWindows = chatgpt.state.account?.balanceDetail?.windows?.map((row) => row.label);
      const chatgptAsOf = chatgpt.state.account?.balanceDetail?.asOf;
      const grokWindows = grok.state.account?.balanceDetail?.windows;
      const grokAsOf = grok.state.account?.balanceDetail?.asOf;
      expect({
        chatgpt: { readyState: chatgpt.readyState, windows: chatgptWindows, asOf: typeof chatgptAsOf },
        grok: { readyState: grok.readyState, windows: grokWindows, asOf: typeof grokAsOf },
        polledUsage: seen.some((url) => url.includes("/wham/usage")),
        polledBilling: seen.some((url) => url.includes("/billing")),
      }).toEqual({
        chatgpt: { readyState: "ready", windows: ["5h", "weekly"], asOf: "string" },
        grok: {
          readyState: "ready",
          windows: [{ label: "weekly", remainingPercent: 60, status: "ok" }],
          asOf: "string",
        },
        polledUsage: true,
        polledBilling: true,
      });

      meter.usage = "down";
      meter.billing = "down";
      await chatgpt["refreshAccount"]();
      await grok["refreshAccount"]();
      expect({
        chatgpt: {
          readyState: chatgpt.readyState,
          error: chatgpt.error,
          windows: chatgpt.state.account?.balanceDetail?.windows?.map((row) => row.label),
          asOf: chatgpt.state.account?.balanceDetail?.asOf,
        },
        grok: {
          readyState: grok.readyState,
          error: grok.error,
          windows: grok.state.account?.balanceDetail?.windows,
          asOf: grok.state.account?.balanceDetail?.asOf,
        },
      }).toEqual({
        chatgpt: { readyState: "ready", error: "", windows: chatgptWindows, asOf: chatgptAsOf },
        grok: { readyState: "ready", error: "", windows: grokWindows, asOf: grokAsOf },
      });
    } finally {
      await chatgpt[Symbol.asyncDispose]();
      await grok[Symbol.asyncDispose]();
      globalThis.fetch = original;
    }
  });
});
