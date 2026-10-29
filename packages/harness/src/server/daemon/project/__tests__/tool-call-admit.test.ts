/**
 * Admit stamps regenerateable from catalog class. Denied reads do not dump.
 */

import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  BotCallJob,
  CallJob,
  AskAgentSpec,
  AgentCallbackJob,
  AgentMessageJob,
  AgentNotifyJob,
  CONTEXT_NEED_TOOL_NAME,
  ContextNeedToolJob,
  FileMutateToolJob,
  MCPToolJob,
  SessionPlexus,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
  WebExtractToolJob,
  WebSearchToolJob,
} from "@inhuman.tools/harness-model";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { SQUEEZE_COMPACT_CHARS, squeezeToolCall } from "@/context";
import { catalogRecipe } from "@/tool-catalog";
import { ToolCallHandler } from "@/tool-runtime";

import { KernelToolCatalog } from "../../../toolkit/tool-table.js";

function invocation(name: string, args = "{}", id = "call_1"): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}

function recipes(catalog: KernelToolCatalog): void {
  catalog.replaceRecipes([
    catalogRecipe({
      name: "echo",
      recipeScope: "session",
      category: "internal",
      capabilities: [{ name: "ping", supportsNotify: true }, { name: "mute" }],
      invokes: [],
    }),
  ]);
}

function mcpHost(catalog: KernelToolCatalog): void {
  catalog.connectionHost = {
    connectionEntries: [
      {
        wireName: "mcp__mail__search",
        description: "search",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: { kind: "connection", connectionKey: "mail", serverToolName: "search" },
      },
    ],
  };
}

beforeEach(() => resetLocalIDs());

describe("ToolCallHandler.admit", () => {
  it.each([
    {
      name: "read regenerateable from class",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation("read_file", '{"path":"a.txt"}'),
        );
        return {
          job: job instanceof ToolCallJob,
          regenerateable: job instanceof ToolCallJob && job.regenerateable,
        };
      },
      want: { job: true, regenerateable: true },
    },
    {
      name: "write persistable",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation("edit_file", '{"path":"a.ts"}', "call_2"),
        );
        return {
          mutate: job instanceof FileMutateToolJob,
          system: job instanceof SystemToolJob,
          regenerateable: job instanceof ToolCallJob && job.regenerateable,
        };
      },
      want: { mutate: true, system: true, regenerateable: false },
    },
    {
      name: "effect persistable",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation("shell", '{"command":"echo hi"}', "call_3"),
        );
        return { regenerateable: job instanceof ToolCallJob && job.regenerateable };
      },
      want: { regenerateable: false },
    },
    {
      name: "web_search WebSearchToolJob",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation("web_search", '{"query":"tea"}'),
        );
        return {
          web: job instanceof WebSearchToolJob,
          system: job instanceof SystemToolJob,
          regenerateable: job instanceof ToolCallJob && job.regenerateable,
        };
      },
      want: { web: true, system: false, regenerateable: false },
    },
    {
      name: "web_extract WebExtractToolJob",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation("web_extract", '{"url":"https://tea.test"}'),
        );
        return {
          extract: job instanceof WebExtractToolJob,
          system: job instanceof SystemToolJob,
          regenerateable: job instanceof ToolCallJob && job.regenerateable,
        };
      },
      want: { extract: true, system: false, regenerateable: false },
    },
    {
      name: "standing agent__send BotCallJob",
      act: () => {
        const catalog = new KernelToolCatalog();
        recipes(catalog);
        const job = new ToolCallHandler({ catalog }).admit(
          invocation("agent__send", JSON.stringify({ spec: "echo", message: "hi" })),
        );
        return { known: job instanceof BotCallJob && job.name === "agent__send" && !job.completed };
      },
      want: { known: true },
    },
    {
      name: "agent__ask AgentCallJob",
      act: () => {
        const catalog = new KernelToolCatalog();
        recipes(catalog);
        const handler = new ToolCallHandler({ catalog });
        const ask = handler.admit(
          invocation("agent__ask", JSON.stringify({ message: "hi", responseSchema: { type: "string" } }), "call_3"),
        );
        const oneShot = handler.admit(
          invocation("agent__ask", JSON.stringify({ spec: "echo", message: "hi", oneShot: true }), "call_os"),
        );
        return {
          ask:
            ask instanceof AgentCallJob &&
            ask.voidLegal === false &&
            JSON.stringify(ask.responseSchema) === JSON.stringify({ type: "string" }) &&
            !ask.completed,
          oneShot:
            oneShot instanceof AgentCallJob && oneShot.voidLegal === false && oneShot.args?.oneShot === undefined,
        };
      },
      want: { ask: true, oneShot: true },
    },
    {
      name: "leftover call__ unknown",
      act: () => {
        const catalog = new KernelToolCatalog();
        recipes(catalog);
        const leftover = new ToolCallHandler({ catalog }).admit(
          invocation("call__echo__ping", '{"message":"hi"}', "call_2"),
        );
        const askWorker = new SessionRoot({ sessionId: "ask-w", path: "/tmp/ask-w" });
        askWorker.agent.spec = new AskAgentSpec();
        const hiddenVoid = new ToolCallHandler({ catalog }).admit(
          invocation("agent__void", JSON.stringify({ requestId: "x" }), "call_4"),
          catalog,
          { session: askWorker },
        );
        return {
          leftover: leftover instanceof SystemToolJob && leftover.name === "call__echo__ping",
          hiddenVoid:
            hiddenVoid instanceof SystemToolJob &&
            hiddenVoid.completed &&
            hiddenVoid.receiptJson === JSON.stringify({ ok: false, text: "outside worker tool ceiling" }),
        };
      },
      want: { leftover: true, hiddenVoid: true },
    },
    {
      name: "context_need ContextNeedToolJob",
      act: () => {
        const job = new ToolCallHandler({ catalog: new KernelToolCatalog() }).admit(
          invocation(CONTEXT_NEED_TOOL_NAME, JSON.stringify({ min_remaining_tokens: 8000 })),
        );
        return {
          kind: job instanceof ContextNeedToolJob,
          name: job instanceof ContextNeedToolJob ? job.name : "",
          system: job instanceof SystemToolJob,
        };
      },
      want: { kind: true, name: CONTEXT_NEED_TOOL_NAME, system: false },
    },
    {
      name: "MCP identity",
      act: () => {
        const catalog = new KernelToolCatalog();
        mcpHost(catalog);
        const handler = new ToolCallHandler({ catalog });
        const job = handler.admit(invocation("mcp__mail__search", '{"q":"hi"}'));
        const session = new SessionRoot({ sessionId: "s-block", path: "/tmp/block" });
        session.blockTool("mail", "search", "session");
        const blocked = handler.admit(invocation("mcp__mail__search", '{"q":"hi"}'), catalog, { session });
        return {
          live: {
            regenerateable: job instanceof ToolCallJob && job.regenerateable,
            kind: job instanceof MCPToolJob,
            connectionKey: job instanceof MCPToolJob ? job.connectionKey : "",
            serverToolName: job instanceof MCPToolJob ? job.serverToolName : "",
            args: job instanceof ToolCallJob ? job.args : null,
            orchestrated: job.orchestrated,
          },
          blocked: {
            kind: blocked instanceof MCPToolJob,
            completed: blocked.completed,
            humanApprove: blocked instanceof MCPToolJob ? blocked.humanApprove : null,
            text: blocked instanceof MCPToolJob ? JSON.parse(blocked.receiptJson ?? "{}") : {},
          },
        };
      },
      want: {
        live: {
          regenerateable: true,
          kind: true,
          connectionKey: "mail",
          serverToolName: "search",
          args: { q: "hi" },
          orchestrated: false,
        },
        blocked: {
          kind: true,
          completed: true,
          humanApprove: false,
          text: { ok: false, text: 'unknown MCP tool "search"' },
        },
      },
    },
  ])("admit class — $name", ({ act, want }) => {
    expect(act()).toEqual(want);
  });

  it.each(
    [
      { operation: "named bot send", name: "agent__send", args: { spec: "echo" }, ownership: "bot" },
      { operation: "named bot ask", name: "agent__ask", args: { spec: "echo" }, ownership: "bot" },
      {
        operation: "named child send",
        name: "agent__send",
        args: { spec: "echo", oneShot: true },
        ownership: "child",
      },
      {
        operation: "named child ask",
        name: "agent__ask",
        args: { spec: "echo", oneShot: true },
        ownership: "child",
      },
      { operation: "omitted-spec child ask", name: "agent__ask", args: {}, ownership: "child" },
    ].flatMap((row) => [false, true].map((background) => ({ ...row, background }))),
  )("$operation preserves ownership with background=$background", ({ name, args, ownership, background }) => {
    const catalog = new KernelToolCatalog();
    recipes(catalog);
    const job = new ToolCallHandler({ catalog }).admit(
      invocation(name, JSON.stringify({ ...args, message: "hi", background })),
    );
    expect(job instanceof BotCallJob).toBe(ownership === "bot");
    expect(job instanceof AgentCallJob).toBe(ownership === "child");
    expect(job).toBeInstanceOf(CallJob);
    if (!(job instanceof CallJob)) throw new Error("expected a call job");
    expect({
      completed: job.completed,
      background: job.background,
      walkBoundary: job.walkBoundary,
      voidLegal: job.voidLegal,
      oneShotArgument: job.args?.oneShot,
      botName: job instanceof BotCallJob ? job.botName : null,
    }).toEqual({
      completed: false,
      background,
      walkBoundary: background,
      voidLegal: name === "agent__send",
      oneShotArgument: undefined,
      botName: ownership === "bot" ? "echo" : null,
    });
  });

  it.each(
    [false, true].flatMap((packBackground) =>
      [false, true].map((requestBackground) => ({ packBackground, requestBackground })),
    ),
  )(
    "plugin bot tool stays BotCallJob with pack background=$packBackground and request background=$requestBackground",
    ({ packBackground, requestBackground }) => {
      const catalog = new KernelToolCatalog();
      recipes(catalog);
      catalog.replacePack([
        {
          wireName: "fixture_bot_call",
          description: "invoke the echo bot",
          parameters: { type: "object", properties: {} },
          class: "effect",
          source: { kind: "pack", pluginName: "fixture" },
          packMeta: {
            kind: "bot-call",
            pluginName: "fixture",
            target: "echo",
            background: packBackground,
            lifetime: "call",
            show: "result",
            supportsNotify: true,
          },
        },
      ]);
      const job = new ToolCallHandler({ catalog }).admit(
        invocation("fixture_bot_call", JSON.stringify({ message: "hi", background: requestBackground })),
      );
      expect(job).toBeInstanceOf(BotCallJob);
      expect(job).not.toBeInstanceOf(AgentCallJob);
      if (!(job instanceof BotCallJob)) throw new Error("expected a bot call job");
      expect({
        botName: job.botName,
        plugin: job.contributionPluginName,
        name: job.name,
        lifetime: job.delivery?.lifetime,
        background: job.background,
        walkBoundary: job.walkBoundary,
        completed: job.completed,
      }).toEqual({
        botName: "echo",
        plugin: "fixture",
        name: "fixture_bot_call",
        lifetime: "call",
        background: packBackground || requestBackground,
        walkBoundary: packBackground || requestBackground,
        completed: false,
      });
    },
  );

  it("a denied read carries no recall pointer: re-invoking is the address", () => {
    const sessionId = "admit-denied-read";
    const handler = new ToolCallHandler({ catalog: new KernelToolCatalog() });
    const job = handler.admit(invocation("read_file", '{"path":"/tmp/x"}'));
    const over = "x".repeat(SQUEEZE_COMPACT_CHARS + 50);
    if (job instanceof ToolCallJob) job.receiptJson = JSON.stringify({ ok: false, text: over });
    const plexus = SessionPlexus.create(sessionId);
    onTestFinished(() => plexus.destroy());
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [job],
      queue: [],
    });
    const painted = job instanceof ToolCallJob ? squeezeToolCall(job, "compact") : "";
    expect({
      regenerateable: job instanceof ToolCallJob && job.regenerateable,
      pointer: painted.includes(";;full response"),
    }).toEqual({ regenerateable: true, pointer: false });
  });

  it("callback/notify mint only with open row + supportsNotify", () => {
    const catalog = new KernelToolCatalog();
    recipes(catalog);
    const handler = new ToolCallHandler({ catalog });
    const open = new BotCallJob({ name: "agent__send", argsJson: JSON.stringify({ spec: "echo", message: "hi" }) });
    const mute = new BotCallJob({ name: "not-a-send" });
    const openDoc = Plexus.bootstrap(open);
    const muteDoc = Plexus.bootstrap(mute);
    onTestFinished(() => {
      openDoc.destroy();
      muteDoc.destroy();
    });
    const session = new SessionRoot({ sessionId: "worker", path: "/tmp/w" });
    session.agentCallbacks[open.uuid] = "caller";
    const loadAgentCall = (uuid: string) => (uuid === open.uuid ? open : uuid === mute.uuid ? mute : undefined);
    const respond = handler.admit(
      invocation("agent__respond", JSON.stringify({ requestId: open.uuid, response: "ok" })),
      catalog,
      { session, loadAgentCall },
    );
    const guess = handler.admit(
      invocation("agent__respond", JSON.stringify({ requestId: mute.uuid, response: "no" }), "call_2"),
      catalog,
      { session, loadAgentCall },
    );
    const notify = handler.admit(
      invocation("agent__notify", JSON.stringify({ requestId: open.uuid, message: "n" }), "call_3"),
      catalog,
      { session, loadAgentCall },
    );
    session.agentCallbacks[mute.uuid] = "caller";
    const muteNotify = handler.admit(
      invocation("agent__notify", JSON.stringify({ requestId: mute.uuid, message: "n" }), "call_4"),
      catalog,
      { session, loadAgentCall },
    );
    const message = handler.admit(invocation("agent__message", '{"message":"hi","targetId":"s"}', "call_5"));
    expect({
      respond: respond instanceof AgentCallbackJob && !respond.completed,
      guess:
        guess instanceof AgentCallbackJob &&
        guess.completed &&
        guess.humanApprove === false &&
        !(guess instanceof SystemToolJob),
      notify: notify instanceof AgentNotifyJob && !notify.completed,
      muteNotify: muteNotify instanceof AgentNotifyJob && muteNotify.completed && muteNotify.humanApprove === false,
      message: message instanceof AgentMessageJob,
    }).toEqual({ respond: true, guess: true, notify: true, muteNotify: true, message: true });
  });
});
