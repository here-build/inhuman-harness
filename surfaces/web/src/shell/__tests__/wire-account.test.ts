import { describe, expect, it } from "vitest";

import {
  accountAnnotation,
  accountLow,
  accountWindowLines,
  quotaLine,
  spellRemaining,
  wireAccount,
} from "../wire-account.js";

const NOW = 1_792_424_000_000;
const inSec = (sec: number): number => NOW / 1000 + sec;

describe("wire account", () => {
  it("names a subscription by its signed-in person and spells each live window", () => {
    const account = wireAccount({
      readyState: "ready",
      live: {
        identity: { displayName: "Ada", email: "ada@example.com", plan: "plus" },
        account: {
          balanceDetail: {
            windows: [
              { label: "5h", remainingPercent: 40, resetAt: inSec(7200) },
              { label: "weekly", remainingPercent: "84", resetAt: inSec(6 * 86_400 + 21 * 3600) },
            ],
          },
        },
      },
    });
    expect(account.description).toBe("Ada");
    expect(accountAnnotation(account, NOW)).toBe("40% 5h left; resets in 2h · 84% weekly left; resets in 6d 21h");
  });

  it("hides a window whose reset has passed", () => {
    const account = wireAccount({
      live: {
        account: {
          balanceDetail: { windows: [{ remainingPercent: 0, resetAt: inSec(-60) }, { remainingPercent: 12 }] },
        },
      },
    });
    expect(accountAnnotation(account, NOW)).toBe("12% left");
    // The expired empty window no longer counts; the live 12% does.
    expect(accountLow(account, NOW)).toBe(true);
  });

  it("is low only while a live window is at or under a fifth", () => {
    const low = (remainingPercent: number): boolean =>
      accountLow(wireAccount({ live: { account: { balanceDetail: { windows: [{ remainingPercent }] } } } }), NOW);
    expect([low(21), low(20), low(0)]).toEqual([false, true, true]);
  });

  it("falls back from the person to the key mask, then the plan", () => {
    expect(wireAccount({ live: { identity: { email: "ada@example.com" } } }).description).toBe("ada@example.com");
    expect(wireAccount({ live: { keyMask: "sk-or-...999" } })).toMatchObject({
      description: "…",
      detail: "sk-or-...999",
    });
    expect(wireAccount({ live: { identity: { plan: "SuperGrokPro" } } }).description).toBe("SuperGrokPro");
  });

  it("paints a balance with its symbol, else its code", () => {
    const funds = (balance: string, currency: object): string =>
      accountAnnotation(wireAccount({ live: { account: { balance: { balance, currency } } } }), NOW);
    expect(funds("74.75", { code: "USD", symbol: "$" })).toBe("$74.75");
    expect(funds("0.001", { code: "USD", symbol: "$" })).toBe("<$0.01");
    expect(funds("-3", { code: "USD", symbol: "$" })).toBe("-$3.00");
    expect(funds("1200", { code: "CRED" })).toBe("1200.00 CRED");
  });

  it("paints a refused or silent endpoint as the provider, and keeps the raw error", () => {
    expect(
      wireAccount({ readyState: "failed", error: "connect ECONNREFUSED 127.0.0.1:1234" }, "LM Studio"),
    ).toMatchObject({
      description: "LM Studio didn’t answer on this machine. Check it’s running, then retry.",
      detail: "connect ECONNREFUSED 127.0.0.1:1234",
    });
    expect(wireAccount({ readyState: "failed", error: "connect ETIMEDOUT 10.0.0.1:1" }, "LM Studio").description).toBe(
      "No answer from LM Studio.",
    );
  });

  it("spells each live window on its own short line", () => {
    const account = wireAccount({
      live: {
        account: {
          balanceDetail: {
            windows: [
              { label: "5h", remainingPercent: 62, resetAt: inSec(3 * 3600) },
              { label: "weekly", remainingPercent: 10, resetAt: inSec(-1) },
            ],
          },
        },
      },
    });
    expect(quotaLine({ remainingPercent: 62, label: "5h" }, NOW)).toBe("62% left · 5h");
    expect(accountWindowLines(account, NOW)).toEqual([{ text: "62% left · 5h", low: false }]);
  });

  it("shows needs auth as a reconnect and hides the stored person and quota", () => {
    const account = wireAccount({
      readyState: "ready",
      live: {
        auth: "needs-auth",
        identity: { displayName: "Ada", plan: "SuperGrokPro" },
        account: { balance: { balance: "5", currency: { symbol: "$" } } },
      },
    });
    expect(account).toMatchObject({ failed: true, description: "needs auth — reconnect", detail: "", balance: "" });
    expect(accountAnnotation(account, NOW)).toBe("");
  });

  it("keeps a timeout as a connection failure when the wire also needs auth", () => {
    const account = wireAccount(
      {
        readyState: "failed",
        error: "connect ETIMEDOUT 10.0.0.1:1",
        live: { auth: "needs-auth", identity: { displayName: "Ada" } },
      },
      "LM Studio",
    );
    expect(account).toMatchObject({
      failed: true,
      description: "No answer from LM Studio.",
      detail: "connect ETIMEDOUT 10.0.0.1:1",
      balance: "",
    });
  });

  it("shows only the failure on a failed wire", () => {
    const account = wireAccount({
      readyState: "failed",
      error: "handshake failed: 401",
      live: { keyMask: "sk-...1", account: { balance: { balance: "5", currency: { symbol: "$" } } } },
    });
    expect(account).toMatchObject({
      failed: true,
      description: "The key was refused. Reconnect.",
      detail: "handshake failed: 401",
    });
    expect(accountAnnotation(account, NOW)).toBe("");
  });

  it("spells durations in units, rounded the way the status rail does", () => {
    expect(spellRemaining(30_000)).toBe("1m");
    expect(spellRemaining(61 * 60_000)).toBe("1h");
    expect(spellRemaining(119 * 60_000)).toBe("2h");
    expect(spellRemaining(90 * 60_000)).toBe("1h 30m");
    expect(spellRemaining(2 * 86_400_000)).toBe("2d");
    expect(spellRemaining(86_400_000 + 18 * 3_600_000)).toBe("1d 18h");
  });
});
