/** harness/scheme-repl: positional toolkit, identity-as-data dispatch, trampoline fan-out. */
import { exec, execState } from "@here.build/arrival";
import { AString } from "@here.build/arrival/reflect-internals";
import {
  AGENT_ASK,
  AGENT_SEND,
  BotCallJob,
  CallJob,
  ProgrammaticJob,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import {
  boundToolsOf,
  replRuntimeOf,
  type SchemeReplHost,
  filePathOf,
  interpretSchemeRepl,
} from "@inhuman.tools/harness-scheme";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { reaction } from "mobx";
import { describe, expect, it } from "vitest";

import { catalogRecipe } from "@/tool-catalog";

import { KernelToolCatalog } from "../../toolkit/tool-table.js";

const YES_NO = {
  type: "object",
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
  required: ["answer"],
  additionalProperties: false,
} as const;

type Tape = Array<{ kind: string; payload: unknown }>;

function catalogOf(pack: boolean): KernelToolCatalog {
  const catalog = new KernelToolCatalog();
  catalog.connectionHost = {
    connectionEntries: [
      {
        wireName: "mcp__mail__search",
        description: "search mail",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: { kind: "connection", connectionKey: "mail", serverToolName: "search" },
      },
      {
        wireName: "mcp__mail__send",
        description: "send mail",
        parameters: { type: "object", properties: {} },
        class: "write",
        source: { kind: "connection", connectionKey: "mail", serverToolName: "send" },
      },
    ],
  };
  if (pack) {
    catalog.replacePack([
      {
        wireName: "ping",
        description: "ping",
        parameters: { type: "object", properties: {} },
        class: "read",
        source: { kind: "pack", pluginName: "eval-pack" },
      },
    ]);
  }
  return catalog;
}

function hostOf(
  tape: Tape,
  opts?: { readonly pack?: boolean; readonly readonly?: boolean; readonly admit?: SchemeReplHost["admit"] },
): SchemeReplHost {
  return {
    catalog: catalogOf(opts?.pack === true),
    root: "/tmp",
    doors: new DoorSession(),
    readonly: opts?.readonly === true,
    connectionModels(connection) {
      tape.push({ kind: "connectionModels", payload: { connection } });
      if (connection === "missing") throw new Error(`unknown connection ${connection}`);
      return connection === "openai" ? ["chatgpt-5.6-luna", "chatgpt-5.6-terra"] : [];
    },
    notify(note) {
      tape.push({ kind: "notify", payload: note.message });
    },
    admit:
      opts?.admit ??
      ((call) => {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;
        tape.push({ kind: "invoke", payload: { name: call.function.name, args } });
        const value =
          call.function.name === "shell"
            ? { command: args.command, cwd: args.cwd }
            : call.function.name === "grep"
              ? ["src/a.ts"]
              : `${call.function.name}:${call.function.arguments}`;
        return new SystemToolJob({
          name: call.function.name,
          toolCallId: call.id,
          completed: true,
          humanApprove: true,
          outcomeJson: JSON.stringify({ ok: true, value }),
        });
      }),
  };
}

let jobs = 0;

/** Scheme verbs parent the call themselves. Settle it here so the verb can return. */
function watchSpawns(job: ProgrammaticJob, tape: Tape): () => void {
  return reaction(
    () => [...job.children],
    (children) => {
      for (const node of children) {
        if (!(node instanceof CallJob) || node.completed) continue;
        tape.push({
          kind: "spawn",
          payload: {
            name: node.name,
            kind: node instanceof BotCallJob ? "bot" : "agent",
            args: { ...(node.args ?? {}) },
            voidLegal: node.voidLegal,
            readonly: node.readonly,
            responseSchema: node.responseSchema,
            botName: node instanceof BotCallJob ? node.botName : null,
          },
        });
        node.settleResult(
          new SuccessfulOutcome({
            valueJson: JSON.stringify(`${node.name}:${JSON.stringify(node.args ?? {})}`),
          }),
        );
      }
    },
  );
}

function spawned(
  name: string,
  kind: "bot" | "agent",
  args: Record<string, unknown>,
  flags: {
    readonly desk?: boolean;
    readonly schema?: Readonly<Record<string, unknown>>;
    readonly botName?: string;
  } = {},
): {
  name: string;
  kind: "bot" | "agent";
  args: Record<string, unknown>;
  voidLegal: boolean;
  readonly: boolean;
  responseSchema: Readonly<Record<string, unknown>> | null;
  botName: string | null;
} {
  return {
    name,
    kind,
    args,
    voidLegal: name === AGENT_SEND,
    readonly: flags.desk === true,
    responseSchema: flags.schema ?? null,
    botName: flags.botName ?? null,
  };
}

function joined(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`;
}

async function run(expr: string, tape: Tape, writable = true, pack = false): Promise<unknown> {
  const host = hostOf(tape, { pack, readonly: !writable });
  const job = new ProgrammaticJob({ toolCallId: `env-${(jobs += 1)}`, argsJson: "{}" });
  const stop = watchSpawns(job, tape);
  try {
    const runtime = replRuntimeOf(job, host);
    runtime.arm({ watching: false, moduleRoot: undefined });
    const signal = new AbortController().signal;
    runtime.beginTick({ signal, origin: 0, maxInternalCalls: undefined });
    const values = await exec(expr, { capabilities: runtime.capabilities, config: runtime.config, signal });
    return values[values.length - 1];
  } finally {
    stop();
  }
}

async function door(act: () => Promise<unknown>): Promise<string> {
  try {
    await act();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("harness/scheme-repl", () => {
  it("grep record rest accepts :path and :glob as keywords", async () => {
    const tape: Tape = [];
    const result = await run('(grep "assumptions" :glob "*.ts" :path "kley")', tape);
    const invokes = tape
      .filter((row) => row.kind === "invoke")
      .map((row) => row.payload as { name: string; args: Record<string, unknown> });
    expect({ result, invokes }).toEqual({
      result: ["src/a.ts"],
      invokes: [{ name: "grep", args: { pattern: "assumptions", glob: "*.ts", path: "kley" } }],
    });
  });

  it("web_search record rest accepts :numResults without leaking provenance", async () => {
    const tape: Tape = [];
    const result = await run('(web_search "tea" :numResults 3)', tape);
    const invokes = tape
      .filter((row) => row.kind === "invoke")
      .map((row) => row.payload as { name: string; args: Record<string, unknown> });
    expect({ result, invokes }).toEqual({
      result: 'web_search:{"query":"tea","numResults":3}',
      invokes: [{ name: "web_search", args: { query: "tea", numResults: 3 } }],
    });
  });

  it("dispatch: toolkit positionals, MCP/pack identity, bot/send/ask and agent/call/ask; readonly desk drops write_file; doors the rest", async () => {
    const calls: Tape = [];

    const read = await run('(read_file "src/a.ts" :offset 2 :limit 10)', calls);
    const written = await run('(write_file "out.txt" "hello")', calls);
    const edited = await run('(edit_file "out.txt" "hello" "hi" :replace_all #t)', calls);
    const sh = await run('(shell "echo hi" :cwd "bin")', calls);
    const mcp = await run("(mcp/call 'mail 'search :q \"inbox\")", calls);
    const mcpDict = await run("(mcp/call 'mail 'search (dict :q \"inbox\"))", calls);
    const pack = await run("(ping)", calls, true, true);
    const wire = await run("(mcp/call 'mail 'search :q \"inbox\")", calls);
    const sent = await run('(bot/send \'reviewer "look at the diff")', calls);
    const asked = await run('(bot/ask \'reviewer "look at the diff")', calls);
    const messaged = await run('(agent/message \'reviewer "aside")', calls);
    const responded = await door(() => run('(agent/respond "req-1" "pong")', calls));
    const voided = await run('(agent/void "req-1")', calls);
    const notified = await run('(agent/notify "req-1" "tick")', calls);
    const omittedAsk = await run('(bot/ask "classify this")', calls);
    const typedAsk = await run('(bot/ask "pick" (dict :answer (s/enum "yes" "no")))', calls);
    const askRoOmitted = await run('(bot/ask "classify this" :readonly #t)', calls);
    const askRoNamed = await run('(bot/ask \'reviewer "look at the diff" :readonly #t)', calls);
    const askRoFlag = await run('(bot/ask "pick" :readonly #t)', calls);
    const askRoTyped = await run('(bot/ask "pick" (dict :answer (s/enum "yes" "no")) :readonly #t)', calls);
    const askRoOff = await run('(bot/ask "classify this" :readonly #f)', calls);
    const writtenOpen = await run('(write_file "out.txt" "hello")', calls);
    const shReadonly = await run('(shell "echo hi")', calls, false);
    const oneShotSent = await run('(agent/call \'reviewer "look at the diff")', calls);
    const oneShotAsked = await run('(agent/ask \'reviewer "look at the diff")', calls);
    const oneShotRoNamed = await run('(agent/ask \'reviewer "look at the diff" :readonly #t)', calls);
    const oneShotRoFlag = await run('(agent/ask \'reviewer "pick" :readonly #t)', calls);
    const oneShotRoTyped = await run(
      '(agent/ask \'reviewer "pick" (dict :answer (s/enum "yes" "no")) :readonly #t)',
      calls,
    );
    const oneShotSchema = await run('(agent/ask \'reviewer "pick" (dict :answer (s/enum "yes" "no")))', calls);
    const oneShotRoOff = await run('(agent/ask \'reviewer "look at the diff" :readonly #f)', calls);
    const modelSent = await run('(agent/call \'reviewer "look" :model "openai/chatgpt-5.6-luna")', calls);
    const modelAsked = await run('(agent/ask \'reviewer "look" :readonly #t :model "openai/chatgpt-5.6-luna")', calls);
    const listed = await run("(connection/models 'openai)", calls);
    const notifiedSelf = await run('(self/notify "merged #412")', calls);

    const nested = await door(() => run("(scheme_repl)", calls));
    const toolkit = await door(() => run("(read_file)", calls));
    const awaitSym = await door(() => run("(await)", calls));
    const deskWrite = await door(() => run('(write_file "out.txt" "hello")', calls, false));
    const deskEdit = await door(() => run('(edit_file "out.txt" "hello" "hi")', calls, false));
    const oneShotOmitted = await door(() => run('(agent/ask "just a message")', calls));
    const oneShotStray = await door(() => run('(agent/ask \'reviewer :readonly "look")', calls));
    const oneShotMissing = await door(() => run("(agent/ask :readonly #t)", calls));
    const oneShotMisplaced = await door(() => run('(agent/ask :readonly "classify")', calls));
    const askStray = await door(() => run('(bot/ask \'reviewer :readonly "look")', calls));
    const askMissing = await door(() => run("(bot/ask :readonly #t)", calls));
    const askMisplaced = await door(() => run('(bot/ask :readonly "classify")', calls));
    const askPin = await door(() => run('(bot/ask \'reviewer "look" :readonli #t)', calls));
    const modelsMissing = await door(() => run("(connection/models 'missing)", calls));
    const modelBare = await door(() => run('(agent/call \'reviewer "look" :model)', calls));

    let live = 0;
    let peak = 0;
    const host = hostOf([], {
      admit(call) {
        live += 1;
        peak = Math.max(peak, live);
        const args = JSON.parse(call.function.arguments) as { path?: string };
        const inner = new SystemToolJob({
          name: call.function.name,
          toolCallId: call.id,
          humanApprove: true,
          outcomeJson: JSON.stringify({
            ok: true,
            value: `${call.function.name}:${args.path ?? ""}`,
          }),
        });
        setTimeout(() => {
          live -= 1;
          inner.markComplete();
        }, 40);
        return inner;
      },
    });
    const mapJob = new ProgrammaticJob({ toolCallId: "map", argsJson: "{}" });
    const mapRuntime = replRuntimeOf(mapJob, host);
    mapRuntime.arm({ watching: false, moduleRoot: undefined });
    const mapSignal = new AbortController().signal;
    mapRuntime.beginTick({ signal: mapSignal, origin: 0, maxInternalCalls: undefined });
    const mapped = (
      await exec('(map read_file \'("a.ts" "b.ts" "c.ts"))', {
        capabilities: mapRuntime.capabilities,
        config: mapRuntime.config,
        signal: mapSignal,
      })
    ).at(-1);

    const stampJob = new ProgrammaticJob({ toolCallId: "stamp", argsJson: "{}" });
    const stampRuntime = replRuntimeOf(stampJob, hostOf(calls));
    stampRuntime.arm({ watching: false, moduleRoot: undefined });
    const stampSignal = new AbortController().signal;
    stampRuntime.beginTick({ signal: stampSignal, origin: 0, maxInternalCalls: undefined });
    const kept = await execState('(read_file "src/a.ts")', {
      capabilities: stampRuntime.capabilities,
      config: stampRuntime.config,
      signal: stampSignal,
    });
    const dropped = await execState('(string-append (read_file "src/a.ts") "!")', {
      capabilities: stampRuntime.capabilities,
      config: stampRuntime.config,
      signal: stampSignal,
    });
    const keptValue = kept.values[0];
    const droppedValue = dropped.values[0];
    const restamped = keptValue instanceof AString ? keptValue.withProvenance(new Set([1])) : keptValue;

    const recipeCatalog = new KernelToolCatalog();
    recipeCatalog.replaceRecipes([
      catalogRecipe({
        name: "echo",
        recipeScope: "session",
        category: "internal",
        capabilities: [{ name: "ping" }],
        invokes: [],
      }),
    ]);
    const mail = new KernelToolCatalog();
    mail.connectionHost = {
      connectionEntries: [
        {
          wireName: "mcp__mail__search",
          description: "search mail",
          parameters: { type: "object", properties: {} },
          class: "read",
          source: { kind: "connection", connectionKey: "mail", serverToolName: "search" },
        },
        {
          wireName: "mcp__mail__send",
          description: "send mail",
          parameters: { type: "object", properties: {} },
          class: "write",
          source: { kind: "connection", connectionKey: "mail", serverToolName: "send" },
        },
      ],
    };
    const open = boundToolsOf(mail);
    const readonlyDesk = boundToolsOf(mail, { readonly: true });

    const catalog = new KernelToolCatalog();
    const admitted: string[] = [];
    function interpretHost(readonly: boolean): SchemeReplHost {
      return {
        catalog,
        root: "/tmp",
        doors: new DoorSession(),
        readonly,
        admit: (call) => {
          admitted.push(call.function.name);
          return new SystemToolJob({
            name: call.function.name,
            toolCallId: call.id,
            completed: true,
            humanApprove: true,
            outcomeJson: JSON.stringify({ ok: true, value: "ok" }),
          });
        },
      };
    }
    const writeRo = new ProgrammaticJob({
      toolCallId: "w-ro",
      argsJson: JSON.stringify({ description: "test", expr: '(write_file "x" "y")' }),
    });
    await interpretSchemeRepl(writeRo, interpretHost(true));
    const roAdmitted = [...admitted];
    admitted.length = 0;
    const writeOpen = new ProgrammaticJob({
      toolCallId: "w-open",
      argsJson: JSON.stringify({ description: "test", expr: '(write_file "x" "y")' }),
    });
    await interpretSchemeRepl(writeOpen, interpretHost(false));
    const openAdmitted = [...admitted];
    admitted.length = 0;
    const shRo = new ProgrammaticJob({
      toolCallId: "sh",
      argsJson: JSON.stringify({ description: "test", expr: '(shell "true")' }),
    });
    await interpretSchemeRepl(shRo, interpretHost(true));

    expect({
      toolkit: { read, written, edited, sh },
      identity: { mcp, mcpDict, pack, wire },
      agent: { sent, asked, messaged, responded, voided, notified, omittedAsk, typedAsk },
      readonlyAsk: { askRoOmitted, askRoNamed, askRoFlag, askRoTyped, askRoOff, writtenOpen, shReadonly },
      oneShot: {
        oneShotSent,
        oneShotAsked,
        oneShotRoNamed,
        oneShotRoFlag,
        oneShotRoTyped,
        oneShotSchema,
        oneShotRoOff,
        modelSent,
        modelAsked,
        listed,
      },
      notify: { value: notifiedSelf, notes: calls.filter((row) => row.kind === "notify") },
      map: { value: mapped, peak },
      path: {
        kept: filePathOf(keptValue),
        restamped: filePathOf(restamped),
        dropped: filePathOf(droppedValue),
        droppedText: String(
          droppedValue != null && typeof droppedValue === "object" && "valueOf" in droppedValue
            ? (droppedValue as { valueOf: () => unknown }).valueOf()
            : droppedValue,
        ),
      },
      desk: {
        write: open.has("write_file"),
        edit: open.has("edit_file"),
        shell: open.has("shell"),
        send: open.has("mcp__mail__send"),
        search: open.has("mcp__mail__search"),
        deskWrite: readonlyDesk.has("write_file"),
        deskEdit: readonlyDesk.has("edit_file"),
        deskShell: readonlyDesk.has("shell"),
        deskSend: readonlyDesk.has("mcp__mail__send"),
        deskSearch: readonlyDesk.has("mcp__mail__search"),
        askSig: open.get("agent__ask")?.signature().signatureText,
      },
      wires: {
        callEcho: recipeCatalog.catalogEntry("call__echo__ping"),
        boundCall: boundToolsOf(recipeCatalog).has("call__echo__ping"),
        boundSend: boundToolsOf(recipeCatalog).has("agent__send"),
      },
      interpret: {
        catalogWrite: catalog.catalogEntry("write_file") != null,
        roOk: JSON.parse(writeRo.receiptJson ?? "null").ok,
        roText: JSON.parse(writeRo.receiptJson ?? "null").text,
        roInv: writeRo.toolCalls.map((row) => row.name),
        roAdmitted,
        openOk: JSON.parse(writeOpen.receiptJson ?? "null").ok,
        openInv: writeOpen.toolCalls.map((row) => row.name),
        openAdmitted,
        shOk: JSON.parse(shRo.receiptJson ?? "null").ok,
        shAdmitted: admitted,
      },
      spawns: calls.filter((row) => row.kind === "spawn").map((row) => row.payload),
      modelCalls: calls.filter((row) => row.kind === "connectionModels"),
      doors: {
        nested,
        toolkit,
        awaitSym,
        deskWrite,
        deskEdit,
        oneShotOmitted,
        oneShotStray,
        oneShotMissing,
        oneShotMisplaced,
        askStray,
        askMissing,
        askMisplaced,
        askPin,
        modelsMissing,
        modelBare,
      },
    }).toEqual({
      toolkit: {
        read: 'read_file:{"path":"src/a.ts","offset":2,"limit":10}',
        written: 'write_file:{"path":"out.txt","content":"hello"}',
        edited: 'edit_file:{"path":"out.txt","old_string":"hello","new_string":"hi","replace_all":true}',
        sh: { command: "echo hi", cwd: "bin" },
      },
      identity: {
        mcp: 'mcp__mail__search:{"q":"inbox"}',
        mcpDict: 'mcp__mail__search:{"q":"inbox"}',
        pack: "ping:{}",
        wire: 'mcp__mail__search:{"q":"inbox"}',
      },
      agent: {
        sent: joined(AGENT_SEND, { spec: "reviewer", message: "look at the diff" }),
        asked: joined(AGENT_ASK, { spec: "reviewer", message: "look at the diff" }),
        messaged: 'agent__message:{"targetName":"reviewer","message":"aside"}',
        responded: expect.stringMatching(/agent__respond JSON tool/),
        voided: 'agent__void:{"requestId":"req-1"}',
        notified: 'agent__notify:{"requestId":"req-1","message":"tick"}',
        omittedAsk: joined(AGENT_ASK, { message: "classify this" }),
        typedAsk: joined(AGENT_ASK, { message: "pick" }),
      },
      readonlyAsk: {
        askRoOmitted: joined(AGENT_ASK, { message: "classify this" }),
        askRoNamed: joined(AGENT_ASK, { spec: "reviewer", message: "look at the diff" }),
        askRoFlag: joined(AGENT_ASK, { message: "pick" }),
        askRoTyped: joined(AGENT_ASK, { message: "pick" }),
        askRoOff: joined(AGENT_ASK, { message: "classify this" }),
        writtenOpen: 'write_file:{"path":"out.txt","content":"hello"}',
        shReadonly: { command: "echo hi" },
      },
      oneShot: {
        oneShotSent: joined(AGENT_SEND, { spec: "reviewer", message: "look at the diff" }),
        oneShotAsked: joined(AGENT_ASK, { spec: "reviewer", message: "look at the diff" }),
        oneShotRoNamed: joined(AGENT_ASK, { spec: "reviewer", message: "look at the diff" }),
        oneShotRoFlag: joined(AGENT_ASK, { spec: "reviewer", message: "pick" }),
        oneShotRoTyped: joined(AGENT_ASK, { spec: "reviewer", message: "pick" }),
        oneShotSchema: joined(AGENT_ASK, { spec: "reviewer", message: "pick" }),
        oneShotRoOff: joined(AGENT_ASK, { spec: "reviewer", message: "look at the diff" }),
        modelSent: joined(AGENT_SEND, { spec: "reviewer", message: "look", model: "openai/chatgpt-5.6-luna" }),
        modelAsked: joined(AGENT_ASK, { spec: "reviewer", message: "look", model: "openai/chatgpt-5.6-luna" }),
        listed: ["chatgpt-5.6-luna", "chatgpt-5.6-terra"],
      },
      notify: { value: undefined, notes: [{ kind: "notify", payload: "merged #412" }] },
      map: { value: ["read_file:a.ts", "read_file:b.ts", "read_file:c.ts"], peak: 3 },
      path: {
        kept: "src/a.ts",
        restamped: "src/a.ts",
        dropped: undefined,
        droppedText: 'read_file:{"path":"src/a.ts"}!',
      },
      desk: {
        write: true,
        edit: true,
        shell: true,
        send: true,
        search: true,
        deskWrite: false,
        deskEdit: false,
        deskShell: true,
        deskSend: false,
        deskSearch: true,
        askSig:
          "(bot/ask spec message :readonly) | (bot/ask message [schema] :readonly) | (agent/ask spec message [schema] :readonly :model)",
      },
      wires: {
        callEcho: undefined,
        boundCall: false,
        boundSend: true,
      },
      interpret: {
        catalogWrite: true,
        roOk: false,
        roText: expect.stringMatching(/writable/),
        roInv: [],
        roAdmitted: [],
        openOk: true,
        openInv: ["write_file"],
        openAdmitted: ["write_file"],
        shOk: true,
        shAdmitted: ["shell"],
      },
      spawns: [
        spawned(AGENT_SEND, "bot", { spec: "reviewer", message: "look at the diff" }, { botName: "reviewer" }),
        spawned(AGENT_ASK, "bot", { spec: "reviewer", message: "look at the diff" }, { botName: "reviewer" }),
        spawned(AGENT_ASK, "agent", { message: "classify this" }),
        spawned(AGENT_ASK, "agent", { message: "pick" }, { schema: YES_NO }),
        spawned(AGENT_ASK, "agent", { message: "classify this" }, { desk: true }),
        spawned(
          AGENT_ASK,
          "bot",
          { spec: "reviewer", message: "look at the diff" },
          { desk: true, botName: "reviewer" },
        ),
        spawned(AGENT_ASK, "agent", { message: "pick" }, { desk: true }),
        spawned(AGENT_ASK, "agent", { message: "pick" }, { desk: true, schema: YES_NO }),
        spawned(AGENT_ASK, "agent", { message: "classify this" }),
        spawned(AGENT_SEND, "agent", { spec: "reviewer", message: "look at the diff" }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "look at the diff" }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "look at the diff" }, { desk: true }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "pick" }, { desk: true }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "pick" }, { desk: true, schema: YES_NO }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "pick" }, { schema: YES_NO }),
        spawned(AGENT_ASK, "agent", { spec: "reviewer", message: "look at the diff" }),
        spawned(AGENT_SEND, "agent", { spec: "reviewer", message: "look", model: "openai/chatgpt-5.6-luna" }),
        spawned(
          AGENT_ASK,
          "agent",
          { spec: "reviewer", message: "look", model: "openai/chatgpt-5.6-luna" },
          { desk: true },
        ),
      ],
      modelCalls: [
        { kind: "connectionModels", payload: { connection: "openai" } },
        { kind: "connectionModels", payload: { connection: "missing" } },
      ],
      doors: {
        nested: expect.stringMatching(/unbound|Unbound/i),
        toolkit: expect.stringMatching(/arity|argument|required/i),
        awaitSym: expect.stringMatching(/unbound|Unbound/i),
        deskWrite: expect.stringMatching(/write_file|writable|door/i),
        deskEdit: expect.stringMatching(/edit_file|writable|door/i),
        oneShotOmitted: expect.stringMatching(/agent\/ask: arguments rejected[\s\S]*arg 2 — missing/),
        oneShotStray: expect.stringMatching(/agent\/ask: arguments rejected[\s\S]*arg 2 — expected AString/),
        oneShotMissing: expect.stringMatching(/agent\/ask: arguments rejected[\s\S]*arg 2 — expected AString/),
        oneShotMisplaced: "agent/ask: the worker spec comes before keywords, got :readonly",
        askStray: "bot/ask: :readonly — Invalid input: expected ABool, received AString",
        askMissing: "bot/ask: a message comes before keywords",
        askMisplaced: "bot/ask: a message comes before keywords",
        askPin: "bot/ask: unknown keyword :readonli (known: :readonly)",
        modelsMissing: expect.stringMatching(/unknown connection missing/),
        modelBare: expect.stringMatching(/dangling keyword/),
      },
    });
  });

  it("update_metadata accepts positionals, keywords, or one dict", async () => {
    const title = "Review database architecture";
    const description = "Investigate database design";
    const bag = { current_turn_title: title, current_turn_description: description };
    const forms = [
      `(update_metadata "${title}" "${description}")`,
      `(update_metadata :current_turn_title "${title}" :current_turn_description "${description}")`,
      `(update_metadata (dict :current_turn_title "${title}" :current_turn_description "${description}"))`,
      `(update_metadata "${title}" :current_turn_description "${description}")`,
    ];
    const admitted = [];
    for (const expr of forms) {
      const tape: Tape = [];
      await run(expr, tape);
      admitted.push(tape.find((row) => row.kind === "invoke")?.payload);
    }
    const bare: Tape = [];
    await run(`(update_metadata "${title}")`, bare);
    const nilled: Tape = [];
    await run(`(update_metadata "${title}" ())`, nilled);
    expect({
      forms: admitted,
      titleOnly: bare.find((row) => row.kind === "invoke")?.payload,
      nilDescription: nilled.find((row) => row.kind === "invoke")?.payload,
      signature: boundToolsOf(catalogOf(false)).get("update_metadata")?.signature().signatureText,
    }).toEqual({
      forms: [
        { name: "update_metadata", args: bag },
        { name: "update_metadata", args: bag },
        { name: "update_metadata", args: bag },
        { name: "update_metadata", args: bag },
      ],
      titleOnly: { name: "update_metadata", args: { current_turn_title: title } },
      nilDescription: { name: "update_metadata", args: { current_turn_title: title } },
      signature: "(update_metadata current_turn_title [current_turn_description])",
    });
  });
});
