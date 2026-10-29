import { describe, expect, it } from "vitest";

import { callArgsSchema, PERIOD_ERR, REPL_PERIOD_ERR, watchArgsSchema } from "../../schemas/index.js";
import { AGENT_ASK, AGENT_SEND, AutonomousToolError } from "../agent-syntax.js";
import { periodMsOf, SCHEME_REPL_NAMING, SCHEME_REPL_TOOL_NAME, SCHEME_WATCH_TOOL_NAME } from "../scheme-syntax.js";

describe("scheme-repl syntax", () => {
  it("names, period clock, and argument schemas stay below executors", () => {
    expect({
      repl: SCHEME_REPL_TOOL_NAME,
      watch: SCHEME_WATCH_TOOL_NAME,
      naming: SCHEME_REPL_NAMING,
      minute: periodMsOf("1 minutes"),
      hour: periodMsOf("2 hours"),
      day: periodMsOf("1 days"),
      send: AGENT_SEND,
      ask: AGENT_ASK,
    }).toEqual({
      repl: "scheme_repl",
      watch: "scheme_watch",
      naming: { toolName: "scheme_repl", argName: "expr" },
      minute: 60_000,
      hour: 7_200_000,
      day: 86_400_000,
      send: "agent__send",
      ask: "agent__ask",
    });
    expect(() => periodMsOf("0 minutes")).toThrow(PERIOD_ERR);
    expect(REPL_PERIOD_ERR).toMatch(/scheme_repl runs once/);
    expect(callArgsSchema.safeParse({ expr: "(+ 1 2)" }).success).toBe(true);
    expect(callArgsSchema.safeParse({ expr: "(+ 1 2)", timeoutMs: 1 }).success).toBe(true);
    expect(callArgsSchema.safeParse({ expr: 1 }).success).toBe(false);
    expect(watchArgsSchema.safeParse({ expr: "(tick)", period: "1 minutes" }).success).toBe(true);
    expect(watchArgsSchema.safeParse({ expr: "(tick)" }).success).toBe(false);
    expect(watchArgsSchema.safeParse({ expr: "(tick)", period: "1 minute" }).success).toBe(false);
    const host = new AutonomousToolError("memory");
    expect(host.name).toBe("AutonomousToolError");
    expect(host.message).toMatch(/host tool/);
  });
});
