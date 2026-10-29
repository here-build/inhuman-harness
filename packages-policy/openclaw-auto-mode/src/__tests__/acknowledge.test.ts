import { describe, expect, it } from "vitest";

import plugin, { handle, matcherFor, type OpenClawApi } from "../index.js";

const api = (pluginConfig: unknown): OpenClawApi => ({ pluginConfig, on() {} });
const exec = (command: string) => ({ toolName: "exec", params: { command } });
const deny = { runtime: { decisions: { evaluate: async () => ({ value: "deny" as const }) } } };
const allow = { runtime: { decisions: { evaluate: async () => ({ value: "allow" as const }) } } };

describe("openclaw acknowledgement (degraded: no prompt path)", () => {
  const gitFlag = { acknowledge: [{ match: { command: ["git", "status"] } }] };

  it("blocks a flagged floor-approved call with the exact reason", async () => {
    expect(await handle(exec("git status"), api(gitFlag))).toEqual({
      block: true,
      blockReason: "needs acknowledgement: command git status; confirm in OpenClaw and retry",
    });
    expect(await handle(exec("pwd"), api(gitFlag))).toBeUndefined();
  });

  it("applies to a judge-allowed call", async () => {
    const flagged = { ...allow, pluginConfig: { acknowledge: [{ match: { class: "package-install" } }] }, on() {} };
    expect(await handle(exec("npm install left-pad"), flagged)).toMatchObject({
      blockReason: expect.stringContaining("needs acknowledgement: class package-install"),
    });
  });

  it("block and denial keep their own reasons", async () => {
    const config = { acknowledge: [{ match: { tool: "exec" } }] };
    expect(await handle(exec("rm .env"), api(config))).toEqual({ block: true, blockReason: "blocked by policy floor" });
    const denied = { ...deny, pluginConfig: config, on() {} };
    expect(await handle(exec("rm file"), denied)).toEqual({ block: true, blockReason: "not authorized" });
  });

  it("user and project flags are a union", async () => {
    const config = { acknowledge: [{ match: { tool: "write" } }], projectAcknowledge: [{ match: { tool: "exec" } }] };
    expect(await handle(exec("pwd"), api(config))).toMatchObject({ block: true });
    expect(await handle({ toolName: "read", params: { path: "a.ts" } }, api(config))).toBeUndefined();
  });

  it("mcp flag blocks a tool outside the gated five; the matcher is widened", async () => {
    const config = { acknowledge: [{ match: { mcp: "gmail", tool: "send_email" } }] };
    expect(await handle({ toolName: "mcp__gmail__send_email", params: {} }, api(config))).toEqual({
      block: true,
      blockReason: "needs acknowledgement: mcp gmail/send_email; confirm in OpenClaw and retry",
    });
    expect(matcherFor(api(config))).toBeUndefined();
    expect(matcherFor(api({}))).toContain("exec");
  });

  it("an invalid block fails closed with a clear error", async () => {
    expect(await handle(exec("pwd"), api({ acknowledge: [{ match: {} }] }))).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("invalid acknowledge config"),
    });
  });

  void plugin;
});
