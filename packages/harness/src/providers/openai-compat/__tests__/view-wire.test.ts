/**
 * Wire is the PEW spine encoded as chat messages.
 * Unresolved / background tools still emit a correlator.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { asSystemPrompt, prompt } from "@inhuman.tools/harness-commons";
import {
  CONTEXT_NEED_TOOL_NAME,
  CompletionExpectation,
  CompletionJob,
  ContextNeedToolJob,
  emitSystemPrompt,
  ProgrammaticJob,
  PromptMessage,
  responseCall,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
  TurnApprovalNoteChunk,
  TurnPromptChunk,
  CompactJob,
  userVisualsJson,
} from "@inhuman.tools/harness-model";
import { PNG } from "pngjs";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { BACKGROUND_TOOL, IN_FLIGHT_TOOL, NO_TOOLS_SYSTEM } from "@/context";
import { bindVisualStore, writeVisual } from "@/server/daemon/session/visual-store";

import { viewWire, type ChatMessage } from "../actor.js";
import type { ReasoningDialect } from "../reasoning-flavor.js";

function nativeCalls(...rows: Array<[id: string, name: string, args?: string]>) {
  return rows.map(([id, name, args]) => responseCall(id, name, args ?? "{}"));
}

function completion(
  promptText: string,
  extra?: {
    readonly responseText?: string;
    readonly calls?: ReturnType<typeof nativeCalls>;
    readonly thought?: string;
  },
): CompletionExpectation {
  const node = new CompletionExpectation({
    connectionId: "c1",
    promptText: prompt.user`${promptText}`,
  });
  if (extra?.responseText !== undefined) node.responseText = extra.responseText;
  if (extra?.calls !== undefined) node.setResponseCalls(extra.calls);
  if (extra?.thought !== undefined) node.responseThought = extra.thought;
  return node;
}

function toolCall(
  id: string,
  name: string,
  extra?: {
    readonly outcomeJson?: string;
    readonly background?: boolean;
    readonly humanApprove?: true | false | null;
    readonly regenerateable?: boolean;
  },
): SystemToolJob {
  return new SystemToolJob({
    toolCallId: id,
    name,
    argsJson: "{}",
    ...(extra?.outcomeJson === undefined ? {} : { outcomeJson: extra.outcomeJson }),
    ...(extra?.background === true ? { background: true } : {}),
    ...(extra?.regenerateable === true ? { regenerateable: true } : {}),
    ...(extra?.humanApprove === undefined ? {} : { humanApprove: extra.humanApprove }),
  });
}

function mount(
  turn: SessionTurn,
  ...cells: Array<CompletionExpectation | ToolCallJob | CompactJob | ProgrammaticJob | TurnApprovalNoteChunk>
): void {
  for (const cell of cells) {
    const row = cell instanceof CompletionExpectation ? new CompletionJob({ expectation: cell }) : cell;
    turn.enqueue(row);
    turn.doneWork.push(turn.queue.shift()!);
  }
}

function session(id: string, path = ""): SessionPlexus {
  const plexus = SessionPlexus.create(id, path);
  onTestFinished(() => plexus.destroy());
  return plexus;
}

function wire(
  id: string,
  cells: Array<CompletionExpectation | ToolCallJob | CompactJob | ProgrammaticJob | TurnApprovalNoteChunk>,
  extra?: {
    readonly systemNote?: string;
    readonly emitNote?: string;
    readonly constitution?: string;
    readonly path?: string;
    readonly dialect?: Pick<ReasoningDialect, "echo" | "chatField">;
  },
): { chat: ChatMessage[]; turn: SessionTurn; tip: CompletionExpectation } {
  const plexus = session(id, extra?.path ?? "");
  const last = cells.at(-1);
  if (!(last instanceof CompletionExpectation)) throw new Error("wire: last cell is not a CompletionExpectation");
  const tip = last;
  if (extra?.systemNote !== undefined) tip.systemNote = prompt.system`${extra.systemNote}`;
  const turn = new SessionTurn({
    // `Mode` is a fact the daemon stamps into the genesis env, not a live read of the root.
    turnTail: new SessionSystemPrompt({
      env: { Mode: "act" },
      ...(extra?.constitution === undefined ? {} : { constitution: asSystemPrompt(extra.constitution) }),
    }),
    prompt: prompt.user`q`,
    queue: [],
  });
  if (extra?.emitNote !== undefined)
    emitSystemPrompt(turn, {
      reason: "bots changed",
      note: prompt.system`${extra.emitNote}`,
    });
  mount(turn, ...cells);
  plexus.root.head = turn;
  return { chat: [...viewWire(tip, { dialect: extra?.dialect })], turn, tip };
}

beforeEach(() => resetLocalIDs());

describe("viewWire", () => {
  it.each([
    {
      name: "assistant tool_calls plus matching role:tool",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "read_file"]),
        });
        const job = toolCall("call_1", "read_file", {
          outcomeJson: JSON.stringify({ ok: true, text: "file-ok" }),
          humanApprove: false,
          regenerateable: true,
        });
        job.completed = true;
        return wire("lineage-wire", [prior, job, completion("next")]).chat.filter((row) => row.role !== "system");
      },
      want: () => [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "file-ok" },
        { role: "user", content: "next" },
      ],
    },
    {
      name: "unresolved background emits running in background",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "shell"]),
        });
        const job = toolCall("call_1", "shell", { background: true });
        const { chat } = wire("lineage-bg", [prior, job, completion("next")]);
        return {
          chat: chat.find((row) => row.role === "tool"),
          completed: job.completed,
        };
      },
      want: () => ({
        chat: {
          role: "tool",
          tool_call_id: "call_1",
          content: BACKGROUND_TOOL,
        },
        completed: false,
      }),
    },
    {
      name: "unresolved foreground emits in-flight",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "shell"]),
        });
        const job = toolCall("call_1", "shell");
        const { chat } = wire("lineage-inflight", [prior, job, completion("next")]);
        return chat.find((row) => row.role === "tool");
      },
      want: () => ({
        role: "tool",
        tool_call_id: "call_1",
        content: IN_FLIGHT_TOOL,
      }),
    },
    {
      name: "update_metadata stays append-only",
      run: () => {
        const first = completion("q", {
          calls: nativeCalls(["m1", "update_metadata", JSON.stringify({ current_turn_title: "First" })]),
        });
        const stale = toolCall("m1", "update_metadata", {
          outcomeJson: JSON.stringify({ ok: true }),
        });
        stale.completed = true;
        stale.args = { current_turn_title: "First" };
        const second = completion("again", {
          calls: nativeCalls(["m2", "update_metadata", JSON.stringify({ current_turn_title: "Later" })]),
        });
        const live = toolCall("m2", "update_metadata", {
          outcomeJson: JSON.stringify({ ok: true }),
        });
        live.completed = true;
        live.args = { current_turn_title: "Later" };
        const { chat } = wire("lineage-meta", [first, stale, second, live, completion("next")]);
        return {
          tools: chat.filter((row) => row.role === "tool"),
          assistants: chat.filter((row) => row.role === "assistant"),
        };
      },
      want: () => ({
        tools: [
          { role: "tool", tool_call_id: "m1", content: "" },
          { role: "tool", tool_call_id: "m2", content: "" },
        ],
        assistants: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "m1",
                type: "function",
                function: {
                  name: "update_metadata",
                  arguments: JSON.stringify({ current_turn_title: "First" }),
                },
              },
            ],
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "m2",
                type: "function",
                function: {
                  name: "update_metadata",
                  arguments: JSON.stringify({ current_turn_title: "Later" }),
                },
              },
            ],
          },
        ],
      }),
    },
    {
      name: "strips context_need; need-only prior is an empty assistant shell",
      run: () => {
        const needArgs = JSON.stringify({ min_remaining_tokens: 8000 });
        const metaArgs = JSON.stringify({ current_turn_title: "Fix login" });
        const mixedPrior = completion("q", {
          calls: nativeCalls(
            ["n1", CONTEXT_NEED_TOOL_NAME, needArgs],
            ["r1", "read_file", JSON.stringify({ path: "a.ts" })],
            ["m1", "update_metadata", metaArgs],
          ),
        });
        const mixedNeed = new ContextNeedToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "n1",
          name: CONTEXT_NEED_TOOL_NAME,
          argsJson: needArgs,
          outcomeJson: JSON.stringify({ ok: true }),
          completed: true,
        });
        const read = toolCall("r1", "read_file", {
          outcomeJson: JSON.stringify({ ok: true, text: "file-ok" }),
          humanApprove: true,
          regenerateable: true,
        });
        read.completed = true;
        read.args = { path: "a.ts" };
        const meta = toolCall("m1", "update_metadata", {
          outcomeJson: JSON.stringify({ ok: true }),
        });
        meta.completed = true;
        meta.args = { current_turn_title: "Fix login" };
        const mixed = wire("lineage-need", [mixedPrior, mixedNeed, read, meta, completion("next")]);
        const shellPrior = completion("q", {
          calls: nativeCalls(["n1", CONTEXT_NEED_TOOL_NAME, needArgs]),
        });
        const shellNeed = new ContextNeedToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "n1",
          name: CONTEXT_NEED_TOOL_NAME,
          argsJson: needArgs,
          outcomeJson: JSON.stringify({ ok: true }),
          completed: true,
        });
        const shell = wire("lineage-need-only", [shellPrior, shellNeed, completion("next")]);
        return {
          mixedTools: mixed.chat.filter((row) => row.role === "tool").map((row) => row.tool_call_id),
          mixedNames: mixed.chat.flatMap((row) => row.tool_calls?.map((call) => call.function.name) ?? []),
          shellAssistants: shell.chat.filter((row) => row.role === "assistant"),
          shellTools: shell.chat.filter((row) => row.role === "tool"),
        };
      },
      want: () => ({
        mixedTools: ["r1", "m1"],
        mixedNames: ["read_file", "update_metadata"],
        shellAssistants: [{ role: "assistant", content: "" }],
        shellTools: [],
      }),
    },
    {
      name: "host systemNote is a system row on this round",
      run: () =>
        wire("lineage-system-note", [completion("next")], {
          systemNote: "Call update_metadata in the same completion",
        })
          .chat.filter((row) => row.role === "system")
          .map((row) => row.content),
      want: () => [NO_TOOLS_SYSTEM, "Mode: act", "Call update_metadata in the same completion"],
    },
    {
      name: "derivation.note is a later system row",
      run: () => {
        const { chat, turn } = wire("lineage-bot-note", [completion("next")], {
          constitution: "be brief",
          path: "/tmp/bot-note",
          emitNote: "new bot added: scout",
        });
        return {
          chat: chat.filter((row) => row.role === "system").map((row) => row.content),
          reloadTools: turn.reloadTools,
        };
      },
      want: () => ({
        chat: [`be brief\n\n${NO_TOOLS_SYSTEM}`, "Workspace: /tmp/bot-note\nMode: act", "new bot added: scout"],
        reloadTools: false,
      }),
    },
    {
      name: "echoes prior encrypted reasoning on the assistant row",
      run: () => {
        const prior = completion("q", { responseText: "ok" });
        prior.responseThought = "plan";
        prior.responseReasoningEncrypted = "enc-blob";
        const thoughtOnly = completion("q");
        thoughtOnly.responseReasoningEncrypted = "enc-only";
        return {
          spoken: wire("lineage-reason-enc", [prior, completion("next")]).chat.find((row) => row.role === "assistant"),
          silent: wire("lineage-reason-enc-only", [thoughtOnly, completion("next")]).chat.find(
            (row) => row.role === "assistant",
          ),
        };
      },
      want: () => ({
        spoken: {
          role: "assistant",
          content: "ok",
          reasoning_content: "plan",
          reasoning_encrypted: "enc-blob",
        },
        silent: {
          role: "assistant",
          content: "",
          reasoning_encrypted: "enc-only",
        },
      }),
    },
    {
      name: "echoes prior reasoning_content; empty thought omits the key",
      run: () => {
        const withThought = completion("q", { responseText: "ok" });
        withThought.responseThought = "plan";
        const thought = wire("lineage-reason", [withThought, completion("next")]);
        const emptyThought = completion("q", {
          responseText: "ok",
          calls: nativeCalls(["call_1", "read_file"]),
        });
        emptyThought.responseThought = "";
        const empty = wire("lineage-reason-empty", [emptyThought, completion("next")]);
        const assistant = empty.chat.find((row) => row.role === "assistant");
        return {
          thought: thought.chat.find((row) => row.role === "assistant"),
          empty: assistant,
          emptyHasKey: assistant !== undefined && "reasoning_content" in assistant,
        };
      },
      want: () => ({
        thought: {
          role: "assistant",
          content: "ok",
          reasoning_content: "plan",
        },
        empty: {
          role: "assistant",
          content: "ok",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        emptyHasKey: false,
      }),
    },
    {
      name: "always echo sends empty reasoning_content; openrouter uses reasoning",
      run: () => {
        const emptyThought = completion("q", {
          responseText: "ok",
          calls: nativeCalls(["call_1", "read_file"]),
        });
        emptyThought.responseThought = "";
        const always = wire("lineage-reason-always", [emptyThought, completion("next")], {
          dialect: { echo: "always", chatField: "reasoning_content" },
        });
        const alwaysRow = always.chat.find((row) => row.role === "assistant");
        const aliased = completion("q", { responseText: "ok" });
        aliased.responseThought = "plan";
        const or = wire("lineage-reason-or", [aliased, completion("next")], {
          dialect: { echo: "omit-empty", chatField: "reasoning" },
        });
        return {
          always: {
            row: alwaysRow,
            hasKey: alwaysRow !== undefined && "reasoning_content" in alwaysRow,
          },
          openrouter: or.chat.find((row) => row.role === "assistant"),
        };
      },
      want: () => ({
        always: {
          row: {
            role: "assistant",
            content: "ok",
            reasoning_content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read_file", arguments: "{}" },
              },
            ],
          },
          hasKey: true,
        },
        openrouter: { role: "assistant", content: "ok", reasoning: "plan" },
      }),
    },
    {
      name: "scheme_repl tool row is one text part per printed statement",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "scheme_repl"]),
        });
        const job = new ProgrammaticJob({
          toolCallId: "call_1",
          argsJson: JSON.stringify({
            description: "test",
            expr: '(+ 1 2)\n(string-append "hello" " " "world")',
          }),
          outcomeJson: JSON.stringify({
            ok: true,
            value: ["3", "hello world"],
          }),
          completed: true,
        });
        return wire("lineage-scheme", [prior, job, completion("next")]).chat.find((row) => row.role === "tool");
      },
      want: () => ({
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "3" },
          { type: "text", text: "hello world" },
        ],
      }),
    },
    {
      name: "approval note is a user message after the tool result",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "edit_file"]),
        });
        const job = toolCall("call_1", "edit_file", {
          outcomeJson: JSON.stringify({ ok: true, text: "wrote" }),
          humanApprove: true,
        });
        job.completed = true;
        job.approvalComment = "keep the export";
        const note = new TurnApprovalNoteChunk({
          leafId: "leaf-1",
          toolName: "edit_file",
          allowed: true,
          text: prompt.user`keep the export`,
        });
        const next = completion("next");
        next.messages = [note];
        return wire("lineage-note", [prior, job, note, next]).chat.filter((row) => row.role !== "system");
      },
      want: () => [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "edit_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "wrote" },
        {
          role: "user",
          content: "The user allowed this tool use (edit_file) with this note:\n<note>\nkeep the export\n</note>",
        },
        { role: "user", content: "next" },
      ],
    },
  ])("$name", ({ run, want }) => {
    const got = run();
    expect(got).toEqual(want());
  });

  it("encodes a seated picture as a data url and names a missing one", () => {
    const root = mkdtempSync(join(tmpdir(), "wire-pics-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    bindVisualStore(root);
    const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
    writeVisual("wire-pics", "kept", png);
    const tip = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`see` });
    const plexus = session("wire-pics", "/work");
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`see`,
      visualsJson: userVisualsJson([
        { id: "old", mime: "image/png", width: 9, height: 8, resizedFrom: null, sourcePath: null },
        {
          id: "kept",
          mime: "image/png",
          width: 2,
          height: 2,
          resizedFrom: { width: 9, height: 8 },
          sourcePath: "shot.png",
        },
      ]),
      queue: [new TurnPromptChunk(), new CompletionJob({ expectation: tip })],
    });
    const user = [...viewWire(tip)].find((row) => row.role === "user");
    const content = user?.content;
    if (typeof content === "string" || content == null) throw new Error("expected image parts");
    expect(content.find((part) => part.type === "image_url")).toEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from(png).toString("base64")}` },
    });
    expect(
      content.some((part) => part.type === "text" && part.text.includes("[Image #1 omitted: image/png, 9x8]")),
    ).toBe(true);
    expect(content.some((part) => part.type === "text" && part.text.includes("resized from 9x8, shot.png"))).toBe(true);
  });
});

it("a systemNote is addressed to its own round: neither a buried nor a kept one replays", () => {
  const buried = completion("old", { responseText: "old work" });
  buried.systemNote = prompt.system`BURIED NAG`;
  const recent = completion("recent", { responseText: "recent work" });
  recent.messages = [buried];
  const kept = completion("kept", { responseText: "kept work" });
  kept.systemNote = prompt.system`KEPT NAG`;
  const tip = completion("next");
  tip.systemNote = prompt.system`TIP NAG`;
  const cutoff = new CompactJob({
    completed: true,
    standIn: completion("summary", { responseText: "the summary" }).responseText || "summary",
  });
  const systems = wire("lineage-cutoff-nag", [buried, recent, cutoff, kept, tip])
    .chat.filter((row) => row.role === "system")
    .map((row) => row.content)
    .join("\n");
  expect({
    buried: systems.includes("BURIED NAG"),
    kept: systems.includes("KEPT NAG"),
    tip: systems.includes("TIP NAG"),
  }).toEqual({ buried: false, kept: false, tip: true });
});

it("isolated assistant examples honor the dialect empty-thought echo without ambient reasoning", () => {
  const messages = [
    { role: "user", content: "Example" },
    { role: "assistant", content: "Answer" },
    { role: "user", content: "Question" },
  ] as const;
  const round = new CompletionExpectation({
    connectionId: "c1",
    completionMode: "isolated",
    promptMessages: messages.map((row) => new PromptMessage(row)),
  });
  round.responseThought = "not authored reasoning";
  for (const chatField of ["reasoning_content", "reasoning"] as const) {
    expect([...viewWire(round, { dialect: { echo: "always", chatField } })]).toEqual([
      messages[0],
      { ...messages[1], [chatField]: "" },
      messages[2],
    ]);
    expect([...viewWire(round, { dialect: { echo: "omit-empty", chatField } })]).toEqual(messages);
  }
});
