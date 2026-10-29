import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PiCtx, PiHost, ToolCall } from "@inhuman.tools/policy-pi";
import { afterEach, describe, expect, it } from "vitest";

import { register, secretFile } from "../index.js";

describe("register", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function ctx(cwd: string, ui: PiCtx["ui"]): PiCtx {
    return { hasUI: true, cwd, isProjectTrusted: () => true, ui };
  }

  async function seated(options: { env?: NodeJS.ProcessEnv; program?: string } = {}): Promise<{
    dir: string;
    cwd: string;
    tool: (event: ToolCall, ctx: PiCtx) => Promise<{ block: true; reason: string } | undefined>;
    start: (event: unknown, ctx: PiCtx) => void;
    command: (args: string, ctx: PiCtx) => Promise<void>;
    notes: string[];
    ui: PiCtx["ui"];
    draft: { key: string | undefined };
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-pi-jev-"));
    temps.push(dir);
    const cwd = path.join(dir, "project");
    const notes: string[] = [];
    const draft = { key: "secret-key" as string | undefined };
    const handlers: {
      tool?: (event: ToolCall, ctx: PiCtx) => Promise<{ block: true; reason: string } | undefined>;
      start?: (event: unknown, ctx: PiCtx) => void;
      command?: (args: string, ctx: PiCtx) => Promise<void>;
    } = {};
    const ui: PiCtx["ui"] = {
      notify(message) {
        notes.push(message);
      },
      input: async () => draft.key,
      editor: async () => '"allow"',
    };
    const pi: PiHost = {
      on(event, handler) {
        if (event === "tool_call") {
          // @ts-expect-error overload joins both handlers; this branch is tool_call
          handlers.tool = handler;
        } else {
          // @ts-expect-error overload joins both handlers; this branch is session_start
          handlers.start = handler;
        }
      },
      registerCommand(_name, command) {
        handlers.command = command.handler;
      },
    };
    register(pi, {
      agentDir: path.join(dir, "agent"),
      cwd,
      env: options.env ?? {},
      ...(options.program === undefined ? {} : { program: options.program }),
    });
    if (handlers.tool === undefined || handlers.start === undefined || handlers.command === undefined) {
      throw new Error("policy-pi-jev did not register");
    }
    return { dir, cwd, tool: handlers.tool, start: handlers.start, command: handlers.command, notes, ui, draft };
  }

  it("stores a typesafe key at mode 0600 and then allows a judged command", async () => {
    const seat = await seated();
    const here = ctx(seat.cwd, seat.ui);
    await seat.command("login", here);
    const info = await stat(secretFile(path.join(seat.dir, "agent")));
    expect(info.mode & 0o777).toBe(0o600);
    await seat.command("program edit", here);
    const allowed = await seat.tool({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, here);
    expect(allowed).toBeUndefined();
    await seat.command("status", here);
    expect(seat.notes.at(-1)).toContain("typesafe key from file");
  });

  it("TYPESAFE_API_KEY allows a literal program", async () => {
    const seat = await seated({ env: { TYPESAFE_API_KEY: "typesafe-env" }, program: '"allow"' });
    const here = ctx(seat.cwd, seat.ui);
    expect(await seat.tool({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, here)).toBeUndefined();
  });

  it("JEV_API_KEY unlocks the gate like the sibling Jev adapters", async () => {
    const seat = await seated({ env: { JEV_API_KEY: "jev-env" }, program: '"allow"' });
    const here = ctx(seat.cwd, seat.ui);
    expect(await seat.tool({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, here)).toBeUndefined();
  });

  it("SAGE_API_KEY does not unlock the gate", async () => {
    const seat = await seated({
      env: { SAGE_API_KEY: "sage-env" },
      program: '"allow"',
    });
    const here = ctx(seat.cwd, seat.ui);
    expect(await seat.tool({ toolName: "bash", input: { command: "rm -rf /tmp/x" } }, here)).toEqual({
      block: true,
      reason: "not authorized",
    });
  });

  it("warns at session start when no typesafe key is configured", async () => {
    const seat = await seated();
    seat.start(undefined, ctx(seat.cwd, seat.ui));
    expect(seat.notes).toEqual(["policy-pi has no decision key; judged calls block"]);
  });

  it("does not warn when TYPESAFE_API_KEY is set", async () => {
    const seat = await seated({ env: { TYPESAFE_API_KEY: "typesafe-env" } });
    seat.start(undefined, ctx(seat.cwd, seat.ui));
    expect(seat.notes).toEqual([]);
  });

  it("still warns when only SAGE_API_KEY is set", async () => {
    const seat = await seated({ env: { SAGE_API_KEY: "sage-env" } });
    seat.start(undefined, ctx(seat.cwd, seat.ui));
    expect(seat.notes).toEqual(["policy-pi has no decision key; judged calls block"]);
  });

  it("logout removes the stored key and the next judged call blocks", async () => {
    const seat = await seated({ program: '"allow"' });
    const here = ctx(seat.cwd, seat.ui);
    const call = { toolName: "bash", input: { command: "rm -rf /tmp/x" } };
    await seat.command("login", here);
    const allowed = await seat.tool(call, here);
    await seat.command("logout", here);
    const blocked = await seat.tool(call, here);
    await seat.command("status", here);
    await expect(stat(secretFile(path.join(seat.dir, "agent")))).rejects.toMatchObject({ code: "ENOENT" });
    expect({ allowed, blocked, notes: seat.notes }).toEqual({
      allowed: undefined,
      blocked: { block: true, reason: "not authorized" },
      notes: ["typesafe key stored", "typesafe key removed", "no typesafe key; dist program; gate on"],
    });
  });

  it("an empty login stores nothing", async () => {
    const seat = await seated();
    seat.draft.key = "  ";
    await seat.command("login", ctx(seat.cwd, seat.ui));
    await expect(stat(secretFile(path.join(seat.dir, "agent")))).rejects.toMatchObject({ code: "ENOENT" });
    expect(seat.notes).toEqual(["no key stored"]);
  });

  it("logout without a UI still removes the key and does not notify", async () => {
    const seat = await seated();
    const here = ctx(seat.cwd, seat.ui);
    await seat.command("login", here);
    await seat.command("logout", { hasUI: false, cwd: seat.cwd, isProjectTrusted: () => true, ui: seat.ui });
    await expect(stat(secretFile(path.join(seat.dir, "agent")))).rejects.toMatchObject({ code: "ENOENT" });
    expect(seat.notes).toEqual(["typesafe key stored"]);
  });

  it("an unknown command prints the typesafe usage", async () => {
    const seat = await seated();
    await seat.command("nope", ctx(seat.cwd, seat.ui));
    expect(seat.notes).toEqual(["usage: status | login | logout | program edit|clear"]);
  });
});
