import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateCall,
  register,
  type Judge,
  type PiCtx,
  type PiModelRegistry,
  type PiHost,
  type ToolCall,
} from "../index.js";
import { gateEnabled, PROGRAM_FILE, readEnabled, SETTINGS_FILE } from "../seat.js";

function bash(command: string) {
  return { toolName: "bash", input: { command } };
}

describe("evaluateCall", () => {
  it("sudo ls is floor deny and git status is floor approve", async () => {
    const judge = vi.fn<Judge>(async (document) => (document === "rm file" ? "allow" : "deny"));
    const removed = await evaluateCall(bash("sudo ls"), judge);
    const status = await evaluateCall(bash("git status"), judge);
    const asked = await evaluateCall(bash("rm file"), judge);
    expect(judge.mock.calls).toEqual([["sudo ls"], ["rm file"]]);
    expect({ removed, status, asked }).toEqual({
      removed: { block: true, reason: "not authorized" },
      status: undefined,
      asked: undefined,
    });
  });

  it("a floor block does not call the judge", async () => {
    const judge = vi.fn<Judge>(async () => "allow");
    const removed = await evaluateCall(bash("rm .env"), judge);
    const written = await evaluateCall({ toolName: "write", input: { path: ".env", content: "SECRET=1" } }, judge);
    const edited = await evaluateCall(
      { toolName: "edit", input: { path: ".git/config", oldText: "a", newText: "b" } },
      judge,
    );
    const read = await evaluateCall({ toolName: "read", input: { path: ".env" } }, judge);
    expect(judge).not.toHaveBeenCalled();
    expect({ removed, written, edited, read }).toEqual({
      removed: { block: true, reason: "blocked by policy floor" },
      written: { block: true, reason: "blocked by policy floor" },
      edited: { block: true, reason: "blocked by policy floor" },
      read: { block: true, reason: "blocked by policy floor" },
    });
  });

  it("paths are normalised before the floor: .., case, absolute in-repo", async () => {
    const judge = vi.fn<Judge>(async () => "allow");
    const cwd = "/work/proj";
    const rows = [
      { toolName: "write", input: { path: "src/../.git/hooks/pre-commit", content: "x" } },
      { toolName: "write", input: { path: ".GIT/hooks/pre-commit", content: "x" } },
      { toolName: "edit", input: { path: "/work/proj/.git/hooks/pre-commit" } },
      { toolName: "read", input: { path: "src/../.env" } },
      { toolName: "read", input: { path: ".ENV" } },
      { toolName: "grep", input: { pattern: "x", path: ".ssh" } },
      { toolName: "ls", input: { path: "~/.aws" } },
    ];
    const out = [];
    for (const row of rows) out.push(await evaluateCall(row, { judge, cwd }));
    expect(judge).not.toHaveBeenCalled();
    expect(out).toEqual(rows.map(() => ({ block: true, reason: "blocked by policy floor" })));
  });

  it("read, grep, find and ls are gated by the read floor; in-tree reads pass without a judge", async () => {
    const judge = vi.fn<Judge>(async () => "deny");
    const cwd = "/work/proj";
    const inTree = [
      { toolName: "read", input: { path: "src/index.ts" } },
      { toolName: "grep", input: { pattern: "x" } },
      { toolName: "find", input: { pattern: "*.ts", path: "src" } },
      { toolName: "ls", input: {} },
    ];
    for (const call of inTree) expect(await evaluateCall(call, { judge, cwd })).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
    // Outside the project roots the floor says deny: that goes to the judge, which here refuses.
    const outside = await evaluateCall({ toolName: "read", input: { path: "/etc/hosts" } }, { judge, cwd });
    expect(judge).toHaveBeenCalledWith("/etc/hosts");
    expect(outside).toEqual({ block: true, reason: "not authorized" });
  });

  it("an unknown, extension or MCP tool goes to the judge unless trusted", async () => {
    const judge = vi.fn<Judge>(async () => "deny");
    const mcp = await evaluateCall({ toolName: "mcp_delete_repo", input: { repo: "x" } }, { judge });
    expect(judge).toHaveBeenCalledWith('mcp_delete_repo {"repo":"x"}');
    expect(mcp).toEqual({ block: true, reason: "not authorized" });
    const allowing = vi.fn<Judge>(async () => "allow");
    expect(await evaluateCall({ toolName: "todo", input: {} }, { judge: allowing })).toBeUndefined();
    expect(allowing).toHaveBeenCalledWith("todo {}");
    const trusted = vi.fn<Judge>(async () => "deny");
    expect(
      await evaluateCall({ toolName: "todo", input: {} }, { judge: trusted, trustedTools: ["todo"] }),
    ).toBeUndefined();
    expect(trusted).not.toHaveBeenCalled();
  });

  it("a judge that never answers is denied at the deadline", async () => {
    const hung: Judge = () => new Promise(() => undefined);
    const started = Date.now();
    const result = await evaluateCall(bash("rm file"), { judge: hung, deadlineMs: 30 });
    expect(result).toEqual({ block: true, reason: "authorization timed out" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a user program replaces the dist script", async () => {
    expect(await evaluateCall(bash("rm file"), { program: '"allow"' })).toBeUndefined();
    expect(await evaluateCall(bash("rm file"), { program: '"deny"' })).toEqual({
      block: true,
      reason: "not authorized",
    });
  });

  it("a trusted project can turn the gate off", async () => {
    const judge = vi.fn<Judge>(async () => "deny");
    expect(await evaluateCall(bash("sudo ls"), { judge, enabled: false })).toBeUndefined();
    expect(judge).not.toHaveBeenCalled();
  });

  it("powershell is the same floor as bash", async () => {
    const judge = vi.fn<Judge>(async () => "deny");
    const result = await evaluateCall({ toolName: "powershell", input: { command: "sudo ls" } }, judge);
    expect(judge).toHaveBeenCalledWith("sudo ls");
    expect(result).toEqual({ block: true, reason: "not authorized" });
  });

  it("a thrown judge blocks an ask", async () => {
    const judge = vi.fn<Judge>(async () => {
      throw new Error("judge down");
    });
    const result = await evaluateCall(bash("rm file"), judge);
    expect(judge.mock.calls).toEqual([["rm file"]]);
    expect(result).toEqual({ block: true, reason: "judge down" });
  });

  it("a tool with no command or path blocks before the judge", async () => {
    const judge = vi.fn<Judge>(async () => "allow");
    const shell = await evaluateCall({ toolName: "bash", input: {} }, judge);
    const written = await evaluateCall({ toolName: "write", input: { content: "x" } }, judge);
    expect(judge).not.toHaveBeenCalled();
    expect({ shell, written }).toEqual({
      shell: { block: true, reason: "missing command or path" },
      written: { block: true, reason: "missing command or path" },
    });
  });
});

describe("gateEnabled", () => {
  it("ignores a project switch until the project is trusted", () => {
    expect(gateEnabled(undefined, false, false)).toBe(true);
    expect(gateEnabled(undefined, false, true)).toBe(false);
    expect(readEnabled("{")).toBeUndefined();
    expect(readEnabled('{"enabled":"no"}')).toBeUndefined();
  });
});

describe("register", () => {
  const temps: string[] = [];

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function ctx(cwd: string, trusted: boolean, ui: PiCtx["ui"]): PiCtx {
    return { hasUI: true, cwd, isProjectTrusted: () => trusted, ui };
  }

  async function seated(): Promise<{
    dir: string;
    cwd: string;
    tool: (event: ToolCall, ctx: PiCtx) => Promise<{ block: true; reason: string } | undefined>;
    start: (event: unknown, ctx: PiCtx) => void;
    command: (args: string, ctx: PiCtx) => Promise<void>;
    commandName: string;
    notes: string[];
    ui: PiCtx["ui"];
    draft: { editor: string | undefined };
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), "policy-pi-"));
    temps.push(dir);
    const cwd = path.join(dir, "project");
    const notes: string[] = [];
    const draft = { editor: '"allow"' as string | undefined };
    const handlers: {
      tool?: (event: ToolCall, ctx: PiCtx) => Promise<{ block: true; reason: string } | undefined>;
      start?: (event: unknown, ctx: PiCtx) => void;
      command?: (args: string, ctx: PiCtx) => Promise<void>;
      commandName?: string;
    } = {};
    const ui: PiCtx["ui"] = {
      notify(message) {
        notes.push(message);
      },
      input: async () => "secret-key",
      editor: async () => draft.editor,
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
      registerCommand(name, command) {
        handlers.commandName = name;
        handlers.command = command.handler;
      },
    };
    register(pi, { agentDir: path.join(dir, "agent"), cwd, env: {} });
    if (
      handlers.tool === undefined ||
      handlers.start === undefined ||
      handlers.command === undefined ||
      handlers.commandName === undefined
    ) {
      throw new Error("policy-pi did not register");
    }
    return {
      dir,
      cwd,
      tool: handlers.tool,
      start: handlers.start,
      command: handlers.command,
      commandName: handlers.commandName,
      notes,
      ui,
      draft,
    };
  }

  it("an untrusted project file does not turn the gate off", async () => {
    const seat = await seated();
    await mkdir(path.join(seat.cwd, ".pi"), { recursive: true });
    await writeFile(path.join(seat.cwd, ".pi", "policy-pi.json"), '{"enabled":false}\n');
    const blocked = await seat.tool(
      { toolName: "write", input: { path: ".env", content: "SECRET=1" } },
      ctx(seat.cwd, false, seat.ui),
    );
    const opened = await seat.tool(
      { toolName: "write", input: { path: ".env", content: "SECRET=1" } },
      ctx(seat.cwd, true, seat.ui),
    );
    expect(blocked).toEqual({ block: true, reason: "blocked by policy floor" });
    expect(opened).toBeUndefined();
  });

  it("a directory where the project settings file should be does not throw: untrusted is ignored, trusted is reported once", async () => {
    const seat = await seated();
    await mkdir(path.join(seat.cwd, ".pi", SETTINGS_FILE), { recursive: true });
    const call: ToolCall = { toolName: "write", input: { path: ".env", content: "SECRET=1" } };
    const untrusted = await seat.tool(call, ctx(seat.cwd, false, seat.ui));
    expect(seat.notes).toEqual([]);
    const trusted = await seat.tool(call, ctx(seat.cwd, true, seat.ui));
    await seat.tool(call, ctx(seat.cwd, true, seat.ui));
    expect(untrusted).toEqual({ block: true, reason: "blocked by policy floor" });
    expect(trusted).toEqual({ block: true, reason: "blocked by policy floor" });
    expect(seat.notes).toHaveLength(1);
    expect(seat.notes[0]).toContain("policy-pi: cannot read");
  });

  it("an unreadable authorization program blocks the call instead of throwing", async () => {
    const seat = await seated();
    await mkdir(path.join(seat.dir, "agent", PROGRAM_FILE), { recursive: true });
    const blocked = await seat.tool({ toolName: "bash", input: { command: "rm file" } }, ctx(seat.cwd, false, seat.ui));
    expect(blocked?.block).toBe(true);
  });

  it("warns once at session start when no key is configured", async () => {
    const seat = await seated();
    seat.start(undefined, ctx(seat.cwd, false, seat.ui));
    expect(seat.notes).toEqual(["policy-pi has no model; judged calls block"]);
  });

  it("the registered command stores a program, then clears it", async () => {
    const seat = await seated();
    const here = ctx(seat.cwd, true, seat.ui);
    await seat.command("status", here);
    seat.draft.editor = undefined;
    await seat.command("program edit", here);
    seat.draft.editor = "  ";
    await seat.command("program edit", here);
    seat.draft.editor = '"allow"';
    await seat.command("program edit", here);
    const allowed = await seat.tool({ toolName: "bash", input: { command: "rm file" } }, here);
    await seat.command("program clear", here);
    await seat.command("", here);
    await seat.command("nope", here);
    expect({ command: seat.commandName, allowed, notes: seat.notes }).toEqual({
      command: "policy-pi",
      allowed: undefined,
      notes: [
        "structured output; dist program; gate on",
        "empty program not stored",
        "authorization program stored",
        "dist authorization program",
        "structured output; dist program; gate on",
        "usage: status | program edit|clear",
      ],
    });
  });

  it("a blank program file blocks the tool call", async () => {
    const seat = await seated();
    const agent = path.join(seat.dir, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, PROGRAM_FILE), " \n");
    const blocked = await seat.tool({ toolName: "bash", input: { command: "rm file" } }, ctx(seat.cwd, true, seat.ui));
    expect(blocked).toEqual({ block: true, reason: "authorization program is empty" });
  });

  it("the user settings file turns the gate off before the project is trusted", async () => {
    const seat = await seated();
    const agent = path.join(seat.dir, "agent");
    await mkdir(agent, { recursive: true });
    await writeFile(path.join(agent, SETTINGS_FILE), '{"enabled":false}\n');
    const opened = await seat.tool(
      { toolName: "write", input: { path: ".env", content: "SECRET=1" } },
      ctx(seat.cwd, false, seat.ui),
    );
    expect(opened).toBeUndefined();
  });

  it("without a UI the editor is not opened and session start stays quiet", async () => {
    const seat = await seated();
    const quiet: PiCtx = { hasUI: false, cwd: seat.cwd, isProjectTrusted: () => false, ui: seat.ui };
    await seat.command("program edit", quiet);
    seat.start(undefined, quiet);
    await seat.command("status", ctx(seat.cwd, true, seat.ui));
    expect(seat.notes).toEqual(["structured output; dist program; gate on"]);
  });

  describe("the judge on pi's own model", () => {
    const call: ToolCall = { toolName: "ext_deploy", input: { target: "prod" } };
    const reply = (text: string) => ({ content: [{ type: "text", text }], stopReason: "stop" });

    function modelCtx(seat: { cwd: string; ui: PiCtx["ui"] }, complete: PiModelRegistry["complete"] | undefined) {
      const registry = complete === undefined ? {} : { model: { id: "m" }, modelRegistry: { complete } };
      return { ...ctx(seat.cwd, false, seat.ui), ...registry };
    }

    it("allow allows, deny blocks, and the prompt carries the decide instructions", async () => {
      const seat = await seated();
      const complete = vi.fn<PiModelRegistry["complete"]>();
      complete
        .mockResolvedValueOnce(reply('{"value":"allow"}'))
        .mockResolvedValueOnce(reply('```json\n{"value":"deny"}\n```'));
      const here = modelCtx(seat, complete);
      const allowed = await seat.tool(call, here);
      const denied = await seat.tool(call, here);
      expect({ allowed, denied: denied?.block }).toEqual({ allowed: undefined, denied: true });
      const [model, context, options] = complete.mock.calls[0] ?? [];
      expect(model).toEqual({ id: "m" });
      expect(context?.systemPrompt).toContain('{"value": <answer>}');
      expect(context?.messages).toHaveLength(1);
      expect(context?.messages[0]?.role).toBe("user");
      expect(context?.messages[0]?.content).toContain("ext_deploy");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    });

    it("a failing call, an error reply or an unparsable answer blocks", async () => {
      const seat = await seated();
      const rows = [
        vi.fn<PiModelRegistry["complete"]>().mockRejectedValue(new Error("offline")),
        vi
          .fn<PiModelRegistry["complete"]>()
          .mockResolvedValue({ content: [], stopReason: "error", errorMessage: "429" }),
        vi.fn<PiModelRegistry["complete"]>().mockResolvedValue(reply("sure, go ahead")),
      ];
      const out = [];
      for (const complete of rows) out.push((await seat.tool(call, modelCtx(seat, complete)))?.block);
      expect(out).toEqual([true, true, true]);
    });

    it("no model blocks without calling anything", async () => {
      const seat = await seated();
      const blocked = await seat.tool(call, modelCtx(seat, undefined));
      expect(blocked?.block).toBe(true);
    });
  });
});
