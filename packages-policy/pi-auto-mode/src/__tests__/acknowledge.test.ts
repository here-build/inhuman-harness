import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { evaluateCall, register, type Block, type GateFiles, type Judge, type PiCtx, type PiHost } from "../index.js";

const bash = (command: string) => ({ toolName: "bash", input: { command } });
const flags = (...match: Record<string, unknown>[]) =>
  match.map((m) => ({ match: m })) as unknown as NonNullable<Parameters<typeof evaluateCall>[1]> extends infer O
    ? O extends { acknowledgeFlags?: infer F }
      ? F
      : never
    : never;

describe("evaluateCall acknowledgement", () => {
  it("a flag forces an ack on a floor-approved call; accepted runs, refused is denied", async () => {
    const acknowledge = vi.fn(async () => true);
    const options = { acknowledgeFlags: flags({ command: ["git", "status"] }), acknowledge };
    expect(await evaluateCall(bash("git status"), options)).toBeUndefined();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    const refused = await evaluateCall(bash("git status"), { ...options, acknowledge: async () => false });
    expect(refused).toEqual({ block: true, reason: "acknowledgement declined: command git status" });
  });

  it("no prompt path degrades to a block with the exact reason", async () => {
    const out = await evaluateCall(bash("git status"), { acknowledgeFlags: flags({ command: ["git"] }) });
    expect(out).toEqual({ block: true, reason: "needs acknowledgement: command git" });
  });

  it("applies to a judge-allowed call; unflagged calls do not prompt", async () => {
    const acknowledge = vi.fn(async () => true);
    const judge: Judge = async () => "allow";
    const options = { judge, acknowledgeFlags: flags({ class: "package-install" }), acknowledge };
    expect(await evaluateCall(bash("npm install left-pad"), options)).toBeUndefined();
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(await evaluateCall(bash("rm file"), options)).toBeUndefined();
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("block and denial are unaffected and never prompt", async () => {
    const acknowledge = vi.fn(async () => true);
    const options = { judge: (async () => "deny") as Judge, acknowledge, acknowledgeFlags: flags({ tool: "bash" }) };
    expect(await evaluateCall(bash("rm .env"), options)).toEqual({ block: true, reason: "blocked by policy floor" });
    expect(await evaluateCall(bash("rm file"), options)).toEqual({ block: true, reason: "not authorized" });
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("mcp tool flags reach a trusted extension tool", async () => {
    const out = await evaluateCall(
      { toolName: "mcp__gmail__send_email", input: { to: "boss" } },
      { trustedTools: ["mcp__gmail__send_email"], acknowledgeFlags: flags({ mcp: "gmail", tool: "send_email" }) },
    );
    expect(out).toEqual({ block: true, reason: "needs acknowledgement: mcp gmail/send_email" });
  });
});

describe("register acknowledgement", () => {
  function seat(user: object | undefined, project: object | undefined, ui: Partial<PiCtx["ui"]> & { hasUI?: boolean }) {
    const store = new Map<string, string>();
    if (user !== undefined) store.set("/agent/policy-pi.json", JSON.stringify(user));
    if (project !== undefined) store.set("/proj/.pi/policy-pi.json", JSON.stringify(project));
    const files: GateFiles = {
      read: (file) => store.get(file),
      write: (file, text) => void store.set(file, text),
      remove: (file) => void store.delete(file),
    };
    let handler: ((event: unknown, ctx: PiCtx) => Promise<Block | undefined>) | undefined;
    const pi = {
      on(name: string, h: never) {
        if (name === "tool_call") handler = h;
      },
      registerCommand() {},
    } as unknown as PiHost;
    register(pi, { agentDir: "/agent", cwd: "/proj", env: {}, files });
    const ctx: PiCtx = {
      hasUI: ui.hasUI ?? true,
      cwd: "/proj",
      isProjectTrusted: () => false,
      ui: {
        notify() {},
        input: ui.input ?? (async () => undefined),
        editor: async () => undefined,
        ...(ui.confirm === undefined ? {} : { confirm: ui.confirm }),
      },
    };
    return (call: unknown) => handler!(call, ctx);
  }

  it("project flags add; they cannot remove a user flag", async () => {
    const run = seat(
      { acknowledge: [{ match: { command: ["git", "status"] } }] },
      { acknowledge: [{ match: { command: ["ls"] } }] },
      { hasUI: false },
    );
    expect(await run(bash("git status"))).toMatchObject({ reason: "needs acknowledgement: command git status" });
    expect(await run(bash("ls"))).toMatchObject({ reason: "needs acknowledgement: command ls" });
    expect(await run(bash("pwd"))).toBeUndefined();
    const removed = seat({ acknowledge: [{ match: { command: ["git"] } }] }, { acknowledge: [] }, { hasUI: false });
    expect(await removed(bash("git status"))).toMatchObject({ block: true });
  });

  it("uses ui.confirm when present, else a yes/no input", async () => {
    const confirm = vi.fn(async () => true);
    const user = { acknowledge: [{ match: { tool: "bash" }, why: "shell" }] };
    expect(await seat(user, undefined, { confirm })(bash("git status"))).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    const input = vi.fn(async () => "yes");
    expect(await seat(user, undefined, { input })(bash("git status"))).toBeUndefined();
    expect(input).toHaveBeenCalledTimes(1);
    expect(await seat(user, undefined, { input: async () => "no" })(bash("git status"))).toMatchObject({
      reason: "acknowledgement declined: tool bash",
    });
  });

  it("an invalid acknowledge block blocks with a clear error", async () => {
    const run = seat({ acknowledge: [{ match: { nope: 1 } }] }, undefined, {});
    expect(await run(bash("git status"))).toMatchObject({
      block: true,
      reason: expect.stringContaining("invalid acknowledge config"),
    });
  });
});

void path;
