import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  AskAgentSpec,
  FileMutateToolJob,
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { catalogRecipe, KernelToolCatalog, type CatalogEntry } from "../../tool-catalog/index.js";
import { ToolCallHandler } from "../index.js";

function invocation(name: string, args = "{}", id = "call_1"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function packEntry(wireName: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    wireName,
    description: extra.description ?? wireName,
    parameters: extra.parameters ?? { type: "object", properties: {} },
    class: extra.class ?? "effect",
    source: extra.source ?? { kind: "pack", pluginName: "toolkit" },
    execute: extra.execute,
    packMeta: extra.packMeta,
    triggersReactLoop: extra.triggersReactLoop,
    tapeHidden: extra.tapeHidden,
    exam: extra.exam,
  };
}

function seeded(): KernelToolCatalog {
  const catalog = new KernelToolCatalog();
  catalog.replacePack([
    packEntry("read_file", { class: "read" }),
    packEntry("write_file", { class: "write" }),
    packEntry("edit_file", { class: "write" }),
    packEntry("shell"),
    packEntry("scheme_repl", { class: "meta" }),
  ]);
  return catalog;
}

beforeEach(() => resetLocalIDs());

describe("ToolCallHandler.admit", () => {
  it("appends the constructed job onto parent", () => {
    const catalog = seeded();
    const parent = new ProgrammaticJob({ toolCallId: "program", argsJson: "{}" });
    const handler = new ToolCallHandler({ catalog });
    const read = handler.admit(invocation("read_file", '{"path":"a.txt"}'), catalog, { parent });
    const ask = handler.admit(invocation("agent__ask", JSON.stringify({ message: "hi" }), "call_2"), catalog, {
      parent,
    });
    expect([...parent.children]).toEqual([read, ask]);
  });

  it("stamps regenerateable from registered catalog class", () => {
    const catalog = seeded();
    const handler = new ToolCallHandler({ catalog });
    const read = handler.admit(invocation("read_file", '{"path":"a.txt"}'));
    const write = handler.admit(invocation("write_file", '{"path":"a.ts"}', "call_2"));
    const shell = handler.admit(invocation("shell", '{"command":"echo hi"}', "call_3"));
    expect({
      read: read instanceof ToolCallJob && read.regenerateable,
      write: write instanceof FileMutateToolJob && !write.regenerateable,
      shell: shell instanceof SystemToolJob && !shell.regenerateable,
    }).toEqual({ read: true, write: true, shell: true });
  });

  it("peels a leading cwd-only cd into cwd; bare cd does not spawn", () => {
    const handler = new ToolCallHandler({ catalog: seeded() });
    const peeled = handler.admit(invocation("shell", JSON.stringify({ command: "cd ./scripts && npm test" })));
    const quoted = handler.admit(invocation("shell", JSON.stringify({ command: 'cd "../bin" && ./tool' }), "call_q"));
    const clash = handler.admit(
      invocation("shell", JSON.stringify({ command: "cd other && ls", cwd: "src" }), "call_c"),
    );
    const bare = handler.admit(invocation("shell", JSON.stringify({ command: "cd dest" }), "call_b"));
    const pipe = handler.admit(invocation("shell", JSON.stringify({ command: "cd dest | cmd" }), "call_p"));
    expect({
      peeled: peeled instanceof SystemToolJob ? peeled.args : null,
      quoted: quoted instanceof SystemToolJob ? quoted.args : null,
      clash: clash instanceof SystemToolJob ? clash.args : null,
      bare:
        bare instanceof SystemToolJob
          ? {
              args: bare.args,
              completed: bare.completed,
              outcome: JSON.parse(bare.receiptJson ?? "null"),
            }
          : null,
      pipe: pipe instanceof SystemToolJob ? pipe.args : null,
    }).toEqual({
      peeled: { command: "npm test", cwd: "./scripts" },
      quoted: { command: "./tool", cwd: "../bin" },
      clash: { command: "cd other && ls", cwd: "src" },
      bare: {
        args: { command: "cd dest" },
        completed: true,
        outcome: { ok: false, text: "cwd only; use the cwd arg on the next call" },
      },
      pipe: { command: "cd dest | cmd" },
    });
  });

  it("connection identity is connectionKey + serverToolName; a blocklist denies at admit", () => {
    const catalog = seeded();
    catalog.connectionHost = {
      connectionEntries: [
        {
          wireName: "mcp__mail__search",
          description: "search",
          parameters: { type: "object", properties: {} },
          class: "read",
          source: {
            kind: "connection",
            connectionKey: "mail",
            serverToolName: "search",
          },
        },
      ],
    };
    const handler = new ToolCallHandler({ catalog });
    const job = handler.admit(invocation("mcp__mail__search", '{"q":"hi"}'));
    const session = new SessionRoot({
      sessionId: "s-block",
      path: "/tmp/block",
    });
    session.blockTool("mail", "search", "session");
    const blocked = handler.admit(invocation("mcp__mail__search", '{"q":"hi"}'), catalog, { session });
    expect({
      live: job instanceof MCPToolJob && job.connectionKey === "mail" && job.expectation instanceof McpToolExpectation,
      blocked: blocked instanceof MCPToolJob && blocked.completed && blocked.humanApprove === false,
    }).toEqual({ live: true, blocked: true });
  });

  it("worker ceiling reads privateWorkerEntries from the passed catalog, not the kernel table", () => {
    const kernel = seeded();
    kernel.replaceRecipes([
      catalogRecipe({
        name: "worker",
        category: "internal",
        tools: ["read_file"],
      }),
    ]);
    const view = kernel.view();
    view.privateWorkerEntries = [
      {
        wireName: "mcp__memory__find",
        description: "find",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: {
          kind: "connection",
          connectionKey: "memory",
          serverToolName: "find",
        },
      },
    ];
    const session = new SessionRoot({ sessionId: "w", path: "/tmp/w" });
    session.agent.spec.name = "worker";
    const handler = new ToolCallHandler({ catalog: kernel });
    const denied = handler.admit(invocation("mcp__memory__find", '{"q":"x"}'), kernel, { session });
    const allowed = handler.admit(invocation("mcp__memory__find", '{"q":"x"}', "call_2"), view, { session });
    expect({
      denied:
        denied instanceof SystemToolJob &&
        denied.completed &&
        denied.receiptJson === JSON.stringify({ ok: false, text: "outside worker tool ceiling" }),
      allowed: allowed instanceof MCPToolJob && !allowed.completed && allowed.connectionKey === "memory",
    }).toEqual({ denied: true, allowed: true });
  });

  it("AskAgentSpec hides agent__void at the worker ceiling", () => {
    const catalog = seeded();
    const askWorker = new SessionRoot({
      sessionId: "ask-w",
      path: "/tmp/ask-w",
    });
    askWorker.agent.spec = new AskAgentSpec();
    const hiddenVoid = new ToolCallHandler({ catalog }).admit(
      invocation("agent__void", JSON.stringify({ requestId: "x" }), "call_4"),
      catalog,
      { session: askWorker },
    );
    expect(
      hiddenVoid instanceof SystemToolJob &&
        hiddenVoid.completed &&
        hiddenVoid.receiptJson === JSON.stringify({ ok: false, text: "outside worker tool ceiling" }),
    ).toBe(true);
  });

  it("scheme_repl is a ProgrammaticJob bag; exam admit copies the frozen program", () => {
    const catalog = seeded();
    catalog.packEntries = [
      ...catalog.packEntries,
      packEntry("exam_probe", {
        class: "meta",
        source: { kind: "pack", pluginName: "exam-probe" },
        exam: {
          program: (_state, input) => {
            const id = typeof input === "object" && input != null && "id" in input ? String(input.id) : "";
            return id === "ok" ? "(frozen)" : { error: `cannot exam ${id}` };
          },
          admit: (_state, input) => ({
            type: "limbo",
            id: typeof input === "object" && input != null && "id" in input ? input.id : "",
          }),
        },
      }),
    ];
    const handler = new ToolCallHandler({ catalog });
    const repl = handler.admit(invocation("scheme_repl", '{"expr":"(+ 1 2)"}'));
    const session = new SessionRoot({ sessionId: "s-exam", path: "/tmp/exam" });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      queue: [],
    });
    session.head = turn;
    const ctx = { session, originTurn: turn };
    const copied = handler.admit(
      invocation("exam_probe", JSON.stringify({ id: "ok", expr: '(shell "rm -rf /")', background: true })),
      catalog,
      ctx,
    );
    const doorBad = handler.admit(invocation("exam_probe", JSON.stringify({ id: "bad" }), "call_2"), catalog, ctx);
    const doorNoSession = handler.admit(invocation("exam_probe", JSON.stringify({ id: "ok" }), "call_3"), catalog);
    const metaRaw = copied instanceof ProgrammaticJob ? copied.pluginMeta["exam-probe"] : undefined;
    let admit = false;
    if (typeof metaRaw === "string" && metaRaw !== "") {
      const parsed: unknown = JSON.parse(metaRaw);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed) && "action" in parsed) {
        const action = parsed.action;
        admit =
          "sealed" in parsed &&
          parsed.sealed === true &&
          action != null &&
          typeof action === "object" &&
          "type" in action &&
          action.type === "limbo";
      }
    }
    expect({
      repl: repl instanceof ProgrammaticJob && !repl.completed,
      bag: copied instanceof ProgrammaticJob && !copied.completed,
      args: copied instanceof ProgrammaticJob ? copied.args : null,
      background: copied instanceof ProgrammaticJob && copied.background && copied.walkBoundary,
      admit,
      doorBad: doorBad.completed && JSON.parse(doorBad.receiptJson ?? "null"),
      doorNoSession: doorNoSession.completed && JSON.parse(doorNoSession.receiptJson ?? "null"),
      child: turn.children.includes(copied),
    }).toEqual({
      repl: true,
      bag: true,
      args: { id: "ok", expr: "(frozen)", background: true, description: "exam_probe" },
      background: true,
      admit: true,
      doorBad: { ok: false, text: "cannot exam bad" },
      doorNoSession: { ok: false, text: "exam_probe: missing session" },
      child: true,
    });
  });

  it("agent__send peels oneShot off the message bag", () => {
    const catalog = seeded();
    const job = new ToolCallHandler({ catalog }).admit(
      invocation("agent__send", JSON.stringify({ spec: "echo", message: "hi", oneShot: true })),
    );
    expect(job instanceof AgentCallJob && job.args?.oneShot === undefined).toBe(true);
    const doc = Plexus.bootstrap(job);
    onTestFinished(() => doc.destroy());
  });
});
