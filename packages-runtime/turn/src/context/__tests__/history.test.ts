/**
 * Same history fixtures as openai-compat viewWire, before vendor encoding.
 */
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
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { BACKGROUND_TOOL, IN_FLIGHT_TOOL, NO_TOOLS_SYSTEM, projectHistory, type HistoryMessage } from "../index.js";
import { CONTEXT_NEED_REMINDER } from "../../session/side-channel-reminder.js";

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

function history(
  id: string,
  cells: Array<CompletionExpectation | ToolCallJob | CompactJob | ProgrammaticJob | TurnApprovalNoteChunk>,
  extra?: {
    readonly systemNote?: string;
    readonly emitNote?: string;
    readonly constitution?: string;
    readonly path?: string;
    readonly echoEmptyThought?: boolean;
  },
): HistoryMessage[] {
  const plexus = session(id, extra?.path ?? "");
  const last = cells.at(-1);
  if (!(last instanceof CompletionExpectation)) throw new Error("history: last cell is not a CompletionExpectation");
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
  return [...projectHistory(tip, { echoEmptyThought: extra?.echoEmptyThought })];
}

beforeEach(() => resetLocalIDs());

describe("projectHistory", () => {
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
        return history("lineage-wire", [prior, job, completion("next")]).filter((row) => row.role !== "system");
      },
      want: () => [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          thought: "",
          toolCalls: [{ id: "call_1", name: "read_file", argsJson: "{}" }],
        },
        { role: "tool", toolCallId: "call_1", content: "file-ok" },
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
        return history("lineage-bg", [prior, job, completion("next")]).find((row) => row.role === "tool");
      },
      want: () => ({
        role: "tool",
        toolCallId: "call_1",
        content: BACKGROUND_TOOL,
      }),
    },
    {
      name: "unresolved foreground emits in-flight",
      run: () => {
        const prior = completion("q", {
          calls: nativeCalls(["call_1", "shell"]),
        });
        const job = toolCall("call_1", "shell");
        return history("lineage-inflight", [prior, job, completion("next")]).find((row) => row.role === "tool");
      },
      want: () => ({
        role: "tool",
        toolCallId: "call_1",
        content: IN_FLIGHT_TOOL,
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
        const mixed = history("lineage-need", [mixedPrior, mixedNeed, read, meta, completion("next")]);
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
        const shell = history("lineage-need-only", [shellPrior, shellNeed, completion("next")]);
        return {
          mixedTools: mixed.filter((row) => row.role === "tool").map((row) => row.toolCallId),
          mixedNames: mixed.flatMap((row) => row.toolCalls?.map((call) => call.name) ?? []),
          shellAssistants: shell.filter((row) => row.role === "assistant"),
          shellTools: shell.filter((row) => row.role === "tool"),
        };
      },
      want: () => ({
        mixedTools: ["r1", "m1"],
        mixedNames: ["read_file", "update_metadata"],
        shellAssistants: [{ role: "assistant", content: "", thought: "" }],
        shellTools: [],
      }),
    },
    {
      name: "host systemNote is a system row on this round",
      run: () =>
        history("lineage-system-note", [completion("next")], {
          systemNote: "Call update_metadata in the same completion",
        })
          .filter((row) => row.role === "system")
          .map((row) => row.content),
      want: () => [NO_TOOLS_SYSTEM, "Mode: act", "Call update_metadata in the same completion"],
    },
    {
      name: "derivation.note is a later system row",
      run: () => {
        const chat = history("lineage-bot-note", [completion("next")], {
          constitution: "be brief",
          path: "/tmp/bot-note",
          emitNote: "new bot added: scout",
        });
        return chat.filter((row) => row.role === "system").map((row) => row.content);
      },
      want: () => [`be brief\n\n${NO_TOOLS_SYSTEM}`, "Workspace: /tmp/bot-note\nMode: act", "new bot added: scout"],
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
        return history("lineage-note", [prior, job, note, next]).filter((row) => row.role !== "system");
      },
      want: () => [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: null,
          thought: "",
          toolCalls: [{ id: "call_1", name: "edit_file", argsJson: "{}" }],
        },
        { role: "tool", toolCallId: "call_1", content: "wrote" },
        {
          role: "user",
          content: "The user allowed this tool use (edit_file) with this note:\n<note>\nkeep the export\n</note>",
        },
        { role: "user", content: "next" },
      ],
    },
  ])("$name", ({ run, want }) => {
    expect(run()).toEqual(want());
  });

  it("keeps the newest four pictures and names the older one", () => {
    const visuals = [1, 2, 3, 4, 5].map((n) => ({
      id: `pic-${n}`,
      mime: "image/png",
      width: 10 + n,
      height: 20,
      resizedFrom: n === 5 ? { width: 4000, height: 3000 } : null,
      sourcePath: n === 5 ? "shot.png" : null,
    }));
    const tip = new CompletionExpectation({ connectionId: "c1", promptText: prompt.user`see` });
    const plexus = session("pics", "/work");
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`see`,
      visualsJson: userVisualsJson(visuals),
      queue: [new TurnPromptChunk(), new CompletionJob({ expectation: tip })],
    });
    const rows = [
      ...projectHistory(tip, {
        readVisual: (id) => (id === "pic-5" ? new Uint8Array([1, 2, 3]) : null),
      }),
    ];
    const user = rows.find((row) => row.role === "user");
    const content = user?.content;
    if (typeof content === "string" || content == null) throw new Error("expected picture parts");
    const texts = content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const images = content.flatMap((part) => (part.type === "image" ? [part] : []));
    expect(texts[0]).toBe("see");
    expect(texts).toEqual([
      "see",
      "[Image #1 elided: image/png 11x20 — recall visual:pic-1]",
      // Still inside the cap, but the blob is missing: exactly one line, and no image part.
      "[Image #2 omitted: image/png, 12x20]",
      "[Image #3 omitted: image/png, 13x20]",
      "[Image #4 omitted: image/png, 14x20]",
      "[Image #5: image/png, 15x20, resized from 4000x3000, shot.png]",
    ]);
    expect(images.map((part) => part.id)).toEqual(["pic-5"]);
    expect(images[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});

it("the side-channel nag reaches the wire as a system row only, never a user row", () => {
  const rows = history("nag-role", [completion("next")], { systemNote: CONTEXT_NEED_REMINDER });
  const carrying = rows.filter((row) => String(row.content).includes("Call context_need"));
  expect(carrying.map((row) => row.role)).toEqual(["system"]);
  expect(rows.filter((row) => row.role === "user").some((row) => /next stretch|context_need/i.test(String(row.content)))).toBe(false);
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
  const systems = history("lineage-cutoff-nag", [buried, recent, cutoff, kept, tip])
    .filter((row) => row.role === "system")
    .map((row) => row.content)
    .join("\n");
  expect({
    buried: systems.includes("BURIED NAG"),
    kept: systems.includes("KEPT NAG"),
    tip: systems.includes("TIP NAG"),
  }).toEqual({ buried: false, kept: false, tip: true });
});

it("isolated assistant examples carry empty thought for the actor to encode", () => {
  const messages = [
    { role: "user" as const, content: "Example" },
    { role: "assistant" as const, content: "Answer" },
    { role: "user" as const, content: "Question" },
  ];
  const round = new CompletionExpectation({
    connectionId: "c1",
    completionMode: "isolated",
    promptMessages: messages.map((row) => new PromptMessage(row)),
  });
  round.responseThought = "not authored reasoning";
  expect([...projectHistory(round)]).toEqual([messages[0], { ...messages[1], thought: "" }, messages[2]]);
});

describe("bodies stored beside the document", () => {
  const SHA = "c".repeat(64);
  const OTHER = "d".repeat(64);
  const FULL = `${"Fold this conversation prefix.\n".repeat(400)}Emphasize: the open decisions.`;
  const HEAD = FULL.slice(0, 512);

  const storedBody = (sha256: string, text: string, head = text.slice(0, 512)) =>
    JSON.stringify({ sha256, bytes: Buffer.byteLength(text, "utf8"), mime: "text/plain", head });
  const reader =
    (objects: Record<string, string>) =>
    (sha256: string): Uint8Array | null =>
      sha256 in objects ? Buffer.from(objects[sha256]!, "utf8") : null;

  /** The summarizer's shape: a short system line and a user message whose body left the document. */
  function summarizer(): CompletionExpectation {
    return new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptMessages: [
        new PromptMessage({ role: "system", content: "Fold this conversation prefix into a snapshot." }),
        new PromptMessage({ role: "user", content: HEAD, contentBlobJson: storedBody(SHA, FULL) }),
      ],
    });
  }

  it("an isolated user message that is a blob projects the full text when readBlob serves it", () => {
    const asked: string[] = [];
    const serve = reader({ [SHA]: FULL });
    const rows = [
      ...projectHistory(summarizer(), {
        readBlob: (sha256) => {
          asked.push(sha256);
          return serve(sha256);
        },
      }),
    ];
    expect({ rows: rows.map((row) => [row.role, row.content === FULL ? "FULL" : row.content]), asked }).toEqual({
      rows: [
        ["system", "Fold this conversation prefix into a snapshot."],
        ["user", "FULL"],
      ],
      asked: [SHA],
    });
  });

  it("projects the head when the reader is missing, when it has nothing, and when it holds another blob", () => {
    const headOnly = [
      [...projectHistory(summarizer())],
      [...projectHistory(summarizer(), { readBlob: () => null })],
      [...projectHistory(summarizer(), { readBlob: reader({ [OTHER]: "unrelated" }) })],
    ].map((rows) => rows.map((row) => row.content));
    const system = "Fold this conversation prefix into a snapshot.";
    expect(headOnly).toEqual([
      [system, HEAD],
      [system, HEAD],
      [system, HEAD],
    ]);
  });

  it("never asks the reader for an inline message", () => {
    const asked: string[] = [];
    const round = new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptMessages: [new PromptMessage({ role: "user", content: "short" })],
    });
    const rows = [...projectHistory(round, { readBlob: (sha256) => (asked.push(sha256), null) })];
    expect({ rows: rows.map((row) => row.content), asked }).toEqual({ rows: ["short"], asked: [] });
  });

  it("reads multi-byte text and a byte-order mark back exactly", () => {
    const text = `\uFEFF${"héllo wörld 😀\n".repeat(700)}`;
    const round = new CompletionExpectation({
      connectionId: "c1",
      completionMode: "isolated",
      promptMessages: [
        new PromptMessage({ role: "user", content: text.slice(0, 512), contentBlobJson: storedBody(SHA, text) }),
      ],
    });
    const row = [...projectHistory(round, { readBlob: reader({ [SHA]: text }) })].at(0);
    expect(row?.content === text).toBe(true);
  });

  it("a session round's stored line that left is read back in full, for the tip and for a prior round", () => {
    const prior = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`${HEAD}`,
      promptTextBlobJson: storedBody(SHA, FULL),
    });
    prior.responseText = "answered";
    const tip = new CompletionExpectation({
      connectionId: "c1",
      promptText: prompt.user`${HEAD}`,
      promptTextBlobJson: storedBody(OTHER, `${FULL} (again)`),
    });
    const plexus = session("stored-line", "/work");
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`q`, queue: [] });
    mount(turn, prior, tip);
    plexus.root.head = turn;
    const users = (readBlob?: (sha256: string) => Uint8Array | null) =>
      [...projectHistory(tip, readBlob === undefined ? {} : { readBlob })]
        .filter((row) => row.role === "user")
        .map((row) => row.content);
    expect({
      served: users(reader({ [SHA]: FULL, [OTHER]: `${FULL} (again)` })),
      missing: users(),
    }).toEqual({
      served: [FULL, `${FULL} (again)`],
      missing: [HEAD, HEAD],
    });
  });

  it("a session round's authored user messages join with a blank line, each read in full", () => {
    const tip = new CompletionExpectation({
      connectionId: "c1",
      promptMessages: [
        new PromptMessage({ role: "user", content: "first" }),
        new PromptMessage({ role: "user", content: HEAD, contentBlobJson: storedBody(SHA, FULL) }),
      ],
    });
    const plexus = session("stored-messages", "/work");
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`q`, queue: [] });
    mount(turn, tip);
    plexus.root.head = turn;
    const user = [...projectHistory(tip, { readBlob: reader({ [SHA]: FULL }) })].find((row) => row.role === "user");
    expect(user?.content === `first\n\n${FULL}`).toBe(true);
  });
});
