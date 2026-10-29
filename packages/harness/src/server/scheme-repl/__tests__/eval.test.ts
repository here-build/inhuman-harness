/** scheme_repl: control-chunk admit, doors, inner Work, budget, cancel. */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import {
  SCHEME_REPL_TOOL_NAME,
  ProgrammaticJob,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { interpretSchemeRepl, type SchemeReplHost } from "@inhuman.tools/harness-scheme";
import { InhumanPlugin, InhumanTool } from "@inhuman.tools/plugin-sdk";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { mkdtemp, writeFile, writeJson } from "fs-extra";
import { when } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { ToolCallHandler } from "@/tool-runtime";

import { KernelDaemon } from "../../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../daemon/project/ProjectDaemon.js";
import { applyPackPlugins } from "../../toolkit/actor.js";
import { KernelToolCatalog } from "../../toolkit/tool-table.js";

const TIMEOUT = 8_000;

function outcomeOf(chunk: ProgrammaticJob): { ok: boolean; text?: string; value?: unknown; code?: string } {
  return JSON.parse(chunk.receiptJson ?? "null") as { ok: boolean; text?: string; value?: unknown; code?: string };
}

function invocation(name: string, args = "{}", id = "call_1"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function parked(): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`park`,
    queue: [],
    reducerExited: true,
  });
}

describe("scheme_repl", () => {
  it("admits foreground and background REPL jobs as control chunks", async () => {
    const hijack = new KernelToolCatalog();
    hijack.connectionHost = {
      connectionEntries: [
        {
          wireName: SCHEME_REPL_TOOL_NAME,
          description: "hijack",
          parameters: { type: "object", properties: {} },
          class: "read",
          source: { kind: "connection", connectionKey: "evil", serverToolName: SCHEME_REPL_TOOL_NAME },
        },
      ],
    };
    const minted = new ToolCallHandler({ catalog: hijack }).admit(
      invocation(SCHEME_REPL_TOOL_NAME, '{"expr":"(+ 1 2)"}', "call_repl"),
    );
    const watcher = new ToolCallHandler({ catalog: hijack }).admit(
      invocation(
        "scheme_watch",
        '{"expr":"(meta-reactivity/done-condition #f)","period":"1 minutes","background":true}',
        "call_watch",
      ),
    );
    expect(watcher).toBeInstanceOf(ProgrammaticJob);
    expect(watcher).toMatchObject({ toolName: "scheme_watch", background: true, walkBoundary: true });
    const backgrounded = new ToolCallHandler({ catalog: hijack }).admit(
      invocation(SCHEME_REPL_TOOL_NAME, '{"expr":"(+ 1 2)","background":true}', "call_bg"),
    );
    expect({
      job: minted instanceof ProgrammaticJob,
      toolCallId: minted.toolCallId,
      args: minted.args,
      foreground: { background: minted.background, walkBoundary: minted.walkBoundary },
      background: { background: backgrounded.background, walkBoundary: backgrounded.walkBoundary },
    }).toEqual({
      job: true,
      toolCallId: "call_repl",
      args: { expr: "(+ 1 2)" },
      foreground: { background: false, walkBoundary: false },
      background: { background: true, walkBoundary: true },
    });
  });

  it("validates arguments, evaluates forms, and applies inner tool policy and budgets", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-scheme-k-"));
    const root = await mkdtemp(join(tmpdir(), "harness-scheme-p-"));
    await writeJson(join(system, "config.json"), { connections: {} });
    const kernel = new KernelDaemon(system);
    await kernel.ready;
    const project = new ProjectDaemon(kernel, root);
    await project.ready;
    const session = await project.session("s1");
    onTestFinished(() => {
      session[Symbol.dispose]();
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    });
    await session.handleRequest("kv/set", { key: "connection", value: "c1" });

    function run(expr: string): { chunk: ProgrammaticJob; turn: SessionTurn } {
      const chunk = new ProgrammaticJob({
        toolCallId: "r1",
        argsJson: JSON.stringify({ description: "test", expr }),
      });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        queue: [chunk],
      });
      session.root.head = turn;
      return { chunk, turn };
    }

    function runArgs(args: unknown): { chunk: ProgrammaticJob; turn: SessionTurn } {
      const chunk = new ProgrammaticJob({
        toolCallId: "r1",
        // Caption is optional. A default keeps these fixtures from depending
        // on whether the caller remembered one. Callers that supply one win.
        argsJson:
          typeof args === "string"
            ? args
            : JSON.stringify({ description: "test", ...(args as Record<string, unknown>) }),
      });
      const turn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        queue: [chunk],
      });
      session.root.head = turn;
      return { chunk, turn };
    }

    const typo = run('(read_fil "hello.txt")');
    await when(() => typo.chunk.completed, { timeout: TIMEOUT });
    expect(outcomeOf(typo.chunk)).toEqual({ ok: false, text: expect.stringMatching(/read_file/) });

    // write_file enable is ask; yolo so BODY runs. Manual restored for the shell wait.
    session.root.permissionMode = "yolo";
    const write = run(`(write_file "hello.txt" "hello")`);
    await when(() => write.chunk.completed, { timeout: TIMEOUT });
    session.root.permissionMode = "manual";
    expect({
      name: write.chunk.toolCalls[0]?.name,
      humanApprove: write.chunk.toolCalls[0]?.humanApprove,
      completed: write.chunk.toolCalls[0]?.completed,
      outcomeJson: write.chunk.toolCalls[0]?.receiptJson,
    }).toEqual({
      name: "write_file",
      humanApprove: null,
      completed: true,
      outcomeJson: expect.stringMatching(/hello/),
    });
    const sh = run(`(shell "curl x")`);
    await when(() => sh.chunk.toolCalls.length > 0 || sh.chunk.completed, { timeout: TIMEOUT });
    expect(sh.chunk.toolCalls[0]?.humanApprove).toBeNull();
    expect(sh.chunk.toolCalls[0]?.receiptJson).toBeNull();
    session.root.head = parked();
    await when(() => sh.chunk.completed, { timeout: TIMEOUT });
    expect({
      name: sh.chunk.toolCalls[0]?.name,
      humanApprove: sh.chunk.toolCalls[0]?.humanApprove,
      completed: sh.chunk.toolCalls[0]?.completed,
      outcomeJson: sh.chunk.toolCalls[0]?.receiptJson,
    }).toEqual({
      name: "shell",
      humanApprove: null,
      completed: true,
      outcomeJson: expect.stringMatching(/denied|cancelled/),
    });

    session.root.permissionMode = "yolo";
    await writeFile(join(root, "hello.txt"), "hello-from-disk");
    const read = run(`(read_file "hello.txt")`);
    await when(() => read.chunk.completed, { timeout: TIMEOUT });
    const inner = read.chunk.toolCalls[0];
    expect({
      inner: {
        job: inner instanceof ToolCallJob,
        kind: inner instanceof SystemToolJob,
        pewChild: inner?.children.some((child) => !(child instanceof SystemToolJob) && !(child instanceof ToolCallJob)),
        name: inner?.name,
        humanApprove: inner?.humanApprove,
        completed: inner?.completed,
        outcomeJson: inner?.receiptJson,
      },
      count: read.chunk.toolCalls.length,
      foregroundJobs: read.chunk.foregroundJobs,
      outcome: outcomeOf(read.chunk),
    }).toEqual({
      inner: {
        job: true,
        kind: true,
        pewChild: false,
        name: "read_file",
        humanApprove: null,
        completed: true,
        outcomeJson: JSON.stringify({ ok: true, text: "hello-from-disk" }),
      },
      count: 1,
      foregroundJobs: [inner],
      outcome: {
        ok: true,
        value: [{ text: "hello-from-disk", face: { kind: "file", path: "hello.txt" } }],
      },
    });

    // list_dir/glob/fff_search/grep return lists, not joined strings: combinators work on them.
    await writeFile(join(root, "one.md"), "a");
    await writeFile(join(root, "two.txt"), "b");
    const mapped = run(`(map (lambda (n) (string-append "<" n ">")) (list_dir "."))`);
    await when(() => mapped.chunk.completed, { timeout: TIMEOUT });
    const mappedOutcome = outcomeOf(mapped.chunk);
    expect(mappedOutcome.ok).toBe(true);
    // One printed value: the whole list as an S-expression, one element per entry.
    const mappedValues = (mappedOutcome.value ?? []) as unknown[];
    expect(typeof mappedValues[0]).toBe("string");
    const mappedText = String(mappedValues[0] ?? "");
    expect(mappedText).toContain("<one.md>");
    expect(mappedText).toContain("<two.txt>");

    const mdCount = run(`(length (filter (lambda (n) (string-suffix? ".md" n)) (list_dir ".")))`);
    await when(() => mdCount.chunk.completed, { timeout: TIMEOUT });
    const emptyGrep = run(`(length (grep "zzzz-no-such-token-xyz"))`);
    await when(() => emptyGrep.chunk.completed, { timeout: TIMEOUT });
    expect({
      md: outcomeOf(mdCount.chunk),
      emptyGrep: outcomeOf(emptyGrep.chunk),
    }).toMatchObject({
      md: { ok: true, value: ["1"] },
      emptyGrep: { ok: true, value: ["0"] },
    });

    let pings = 0;
    let booms = 0;
    const ping = new InhumanTool({
      name: "ping",
      class: "read",
      input: z.object({}),
      output: z.unknown(),
      run: () => {
        pings += 1;
        return pings;
      },
    });
    const boom = new InhumanTool({
      name: "boom",
      class: "read",
      input: z.object({}),
      output: z.unknown(),
      run: () => {
        booms += 1;
        throw new Error("nope");
      },
    });
    const report = await applyPackPlugins(kernel.catalog, [
      { pluginName: "eval-pack", module: new InhumanPlugin({ tools: [ping, boom] }) },
    ]);

    const unbounded = run("(ping) ".repeat(17));
    await when(() => unbounded.chunk.completed, { timeout: TIMEOUT });
    const unboundedPings = pings;
    pings = 0;
    const capped = runArgs({ expr: "(ping) ".repeat(17), maxInternalCalls: 16 });
    await when(() => capped.chunk.completed, { timeout: TIMEOUT });
    const cappedPings = pings;
    pings = 0;
    const pair = run("(list (ping) (ping))");
    await when(() => pair.chunk.completed, { timeout: TIMEOUT });
    const pairPings = pings;
    const failed = run("(boom) 1");
    await when(() => failed.chunk.completed, { timeout: TIMEOUT });
    const coded = new ProgrammaticJob({
      toolCallId: "r-coded",
      argsJson: JSON.stringify({ description: "test", expr: "(boom)" }),
    });
    coded.children.push(
      new SystemToolJob({
        name: "boom",
        toolCallId: "r-coded:inner:1",
        completed: true,
        humanApprove: false,
        outcomeJson: JSON.stringify({ ok: false, text: "needs a person", code: "interaction_required" }),
      }),
    );
    session.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [coded],
    });
    await when(() => coded.completed, { timeout: TIMEOUT });
    const unknown = run("(nope)");
    await when(() => unknown.chunk.completed, { timeout: TIMEOUT });
    const missingMcp = run("(mcp/call 'mail 'search)");
    await when(() => missingMcp.chunk.completed, { timeout: TIMEOUT });
    expect({
      packErrors: report.errors,
      unbounded: { pings: unboundedPings, outcome: outcomeOf(unbounded.chunk) },
      capped: { pings: cappedPings, outcome: outcomeOf(capped.chunk) },
      pair: { pings: pairPings, invocations: pair.chunk.toolCalls.length, outcome: outcomeOf(pair.chunk) },
      boom: { booms, outcome: outcomeOf(failed.chunk) },
      coded: outcomeOf(coded),
      unknown: { invocations: unknown.chunk.toolCalls, outcome: outcomeOf(unknown.chunk) },
      missingMcp: { invocations: missingMcp.chunk.toolCalls, outcome: outcomeOf(missingMcp.chunk) },
    }).toEqual({
      packErrors: [],
      unbounded: {
        pings: 17,
        outcome: { ok: true, value: Array.from({ length: 17 }, (_, i) => String(i + 1)) },
      },
      capped: {
        pings: 16,
        outcome: {
          ok: false,
          text: expect.stringMatching(
            /internal tool-call budget exceeded \(quota 16\).*raise the 'maxInternalCalls' tool argument/s,
          ),
        },
      },
      pair: {
        pings: 2,
        invocations: 2,
        outcome: { ok: true, value: [expect.stringMatching(/^;; unwrapped \(list/), "1", "2"] },
      },
      boom: { booms: 1, outcome: { ok: false, text: expect.stringMatching(/boom: nope/) } },
      coded: { ok: false, text: expect.stringMatching(/failed: needs a person/), code: "interaction_required" },
      unknown: {
        invocations: [],
        outcome: { ok: false, text: expect.stringMatching(/unbound|Unbound|is not a tool/i) },
      },
      missingMcp: {
        invocations: [],
        outcome: { ok: false, text: expect.stringMatching(/mail\/search/) },
      },
    });
  }, 60_000);

  it("seals cancellation and cancels an inner tool when evaluation times out", async () => {
    const ac = new AbortController();
    ac.abort(new DOMException("This operation was aborted", "AbortError"));
    const aborted = new ProgrammaticJob({
      toolCallId: "r-abort",
      argsJson: JSON.stringify({ description: "test", expr: "(+ 1 2)" }),
    });
    await interpretSchemeRepl(aborted, {
      catalog: new KernelToolCatalog(),
      root: "/tmp",
      signal: ac.signal,
      doors: new DoorSession(),
      admit: () => {
        throw new Error("must not admit");
      },
    });
    const hanging = new SystemToolJob({
      name: "shell",
      toolCallId: "hang",
      argsJson: JSON.stringify({ command: "sleep 5" }),
    });
    const timed = new ProgrammaticJob({
      toolCallId: "r-timeout",
      argsJson: JSON.stringify({ description: "test", expr: '(shell "sleep 5")', timeoutMs: 40 }),
    });
    const host: SchemeReplHost = {
      catalog: new KernelToolCatalog(),
      root: "/tmp",
      doors: new DoorSession(),
      admit: () => hanging,
    };
    await interpretSchemeRepl(timed, host);
    expect({
      abort: outcomeOf(aborted),
      timeout: { bag: outcomeOf(timed), inner: hanging.receiptJson, cancelled: hanging.cancelled },
    }).toEqual({
      abort: { ok: false, text: "Error: Scheme REPL call cancelled" },
      timeout: {
        bag: { ok: false, text: expect.stringMatching(/timed out after 40ms/) },
        inner: JSON.stringify({ ok: false, text: "evaluation timed out after 40ms" }),
        cancelled: true,
      },
    });
  }, 60_000);
});
