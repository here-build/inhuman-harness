import {
  CONTEXT_NEED_DESCRIPTION,
  CONTEXT_NEED_INPUT_SCHEMA,
  METADATA_SAME_ROUND_TEXT,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
} from "@inhuman.tools/activity";
import { describe, expect, it } from "vitest";

import {
  agentDirectory,
  type CompactEvent,
  type ContextNeedDetails,
  type ContextNeedInput,
  contextNeedLine,
  keptHistory,
  type PiCtx,
  type PiEntry,
  type PiHost,
  type PiMessage,
  type PiTool,
  readEnabled,
  register,
  STATUS_KEY,
  summaryLine,
  wantsCompaction,
} from "../index.js";

function fake(settings?: string) {
  const tools: PiTool[] = [];
  const handlers = new Map<string, ((event: never, ctx: PiCtx) => void)[]>();
  const ui = {
    status: [] as (string | undefined)[],
    working: [] as (string | undefined)[],
    names: [] as string[],
    notes: [] as string[],
  };
  const host = {
    usage: undefined as { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
    compactions: [] as { customInstructions?: string }[],
  };
  const ctx: PiCtx = {
    getContextUsage: () => host.usage,
    compact: (options) => {
      host.compactions.push({ customInstructions: options?.customInstructions });
    },
    ui: {
      notify(message) {
        ui.notes.push(message);
      },
      setStatus(key, text) {
        expect(key).toBe(STATUS_KEY);
        ui.status.push(text);
      },
      setWorkingMessage(message) {
        ui.working.push(message);
      },
    },
  };
  const pi = {
    registerTool: (tool: PiTool) => tools.push(tool),
    setSessionName: (name: string) => ui.names.push(name),
    on(event: string, handler: (event: never, ctx: PiCtx) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as PiHost;
  register(pi, { agentDir: "/x", readFile: () => settings });
  return {
    tool: tools[0] as PiTool,
    need: tools[1] as unknown as PiTool<ContextNeedInput, ContextNeedDetails>,
    host,
    tools,
    ui,
    ctx,
    emit(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload as never, ctx);
    },
  };
}

function assistant(text: string, calls: { id: string; name: string }[]): PiMessage {
  return {
    role: "assistant",
    content: [
      ...(text === "" ? [] : [{ type: "text", text }]),
      ...calls.map((call) => ({ type: "toolCall", ...call, arguments: {} })),
    ],
  };
}

const ARGS = { current_turn_title: "Fixing auth", current_turn_description: "Reading the token code" };

describe("activity-pi", () => {
  it("spoken text plus the call terminates and paints the UI", async () => {
    const h = fake();
    h.emit("message_end", { message: assistant("All done.", [{ id: "1", name: "update_metadata" }]) });
    const result = await h.tool.execute("1", ARGS, undefined, undefined, h.ctx);
    expect(result.terminate).toBe(true);
    expect(result.content[0]?.text).toBe("Recorded.");
    expect(h.ui.names).toEqual(["Fixing auth"]);
    expect(h.ui.working).toEqual(["Fixing auth"]);
    expect(h.ui.status).toEqual(["Reading the token code"]);
  });

  it("thinking-only text does not count as speech", async () => {
    const h = fake();
    h.emit("message_end", { message: assistant("<think>hmm</think>", [{ id: "1", name: "update_metadata" }]) });
    expect((await h.tool.execute("1", ARGS, undefined, undefined, h.ctx)).terminate).toBe(false);
  });

  it("no text and the call alone: no terminate, the note rides in the result", async () => {
    const h = fake();
    h.emit("message_end", { message: assistant("", [{ id: "1", name: "update_metadata" }]) });
    const result = await h.tool.execute("1", ARGS, undefined, undefined, h.ctx);
    expect(result.terminate).toBe(false);
    expect(result.content[0]?.text).toContain(METADATA_SAME_ROUND_TEXT);
  });

  it("beside a real tool: no note; the batch continues because the other result does not terminate", async () => {
    const h = fake();
    h.emit("message_end", {
      message: assistant("Looking.", [
        { id: "1", name: "read" },
        { id: "2", name: "update_metadata" },
      ]),
    });
    const result = await h.tool.execute("2", ARGS, undefined, undefined, h.ctx);
    // pi stops only when every result terminates; `read` never does.
    expect(result.terminate).toBe(true);
    const batch = [{ terminate: undefined }, result];
    expect(batch.every((r) => r.terminate === true)).toBe(false);

    h.emit("message_end", {
      message: assistant("", [
        { id: "3", name: "read" },
        { id: "4", name: "update_metadata" },
      ]),
    });
    const silent = await h.tool.execute("4", ARGS, undefined, undefined, h.ctx);
    expect(silent.terminate).toBe(false);
    expect(silent.content[0]?.text).toBe("Recorded.");
  });

  it("an unknown call id never terminates", async () => {
    const h = fake();
    expect((await h.tool.execute("zz", ARGS, undefined, undefined, h.ctx)).terminate).toBe(false);
  });

  it("clamps title and description", async () => {
    const h = fake();
    const result = await h.tool.execute(
      "1",
      {
        current_turn_title: "t".repeat(SESSION_TITLE_MAX_CHARS + 10),
        current_turn_description: "d".repeat(SESSION_DESCRIPTION_MAX_CHARS + 10),
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.details.title).toHaveLength(SESSION_TITLE_MAX_CHARS);
    expect(result.details.description).toHaveLength(SESSION_DESCRIPTION_MAX_CHARS);
    expect(h.ui.names[0]).toHaveLength(SESSION_TITLE_MAX_CHARS);
  });

  it("clears the working message at agent_end", () => {
    const h = fake();
    h.emit("agent_end", {});
    expect(h.ui.working).toEqual([undefined]);
  });

  it("registers the tool with the schema, a guideline and a one-line transcript row", () => {
    const h = fake();
    expect(h.tool.name).toBe("update_metadata");
    expect(h.tool.promptGuidelines).toHaveLength(1);
    const theme = { fg: (_c: string, t: string) => t };
    expect(h.tool.renderCall(ARGS, theme).render(80)).toEqual(["Fixing auth — Reading the token code"]);
    expect(h.tool.renderCall(ARGS, theme).render(10)).toEqual(["Fixing au…"]);
    expect(h.tool.renderCall({}, theme).render(80)).toEqual([]);
    expect(h.tool.renderResult().render(80)).toEqual([]);
  });

  it("disabled: the tool is not registered", () => {
    expect(fake('{"enabled":false}').tools).toHaveLength(0);
    expect(fake("{bad").tools).toHaveLength(2);
  });
});

const theme = { fg: (_c: string, t: string) => t };

function entry(id: string, role: "user" | "assistant", withCall = false): PiEntry {
  return {
    id,
    type: "message",
    message: {
      role,
      content: withCall ? [{ type: "toolCall", id: `c${id}`, name: "read" }] : [{ type: "text", text: "x" }],
    },
  };
}

// u1 a1(call) u2 a2(call) a3(call) u3 a4(call)
const BRANCH: PiEntry[] = [
  entry("u1", "user"),
  entry("a1", "assistant", true),
  entry("u2", "user"),
  entry("a2", "assistant", true),
  entry("a3", "assistant", true),
  entry("u3", "user"),
  entry("a4", "assistant", true),
];

function compactEvent(firstKept: string, over: Partial<CompactEvent> = {}): CompactEvent {
  return { branchEntries: BRANCH, preparation: { firstKeptEntryId: firstKept }, reason: "threshold", ...over };
}

describe("context_need", () => {
  it("registers with the core description and schema", () => {
    const h = fake();
    expect(h.need.name).toBe("context_need");
    expect(h.need.description).toBe(CONTEXT_NEED_DESCRIPTION);
    expect(h.need.parameters).toBe(CONTEXT_NEED_INPUT_SCHEMA);
  });

  it("terminates only when the issuing message spoke; never nudges", async () => {
    const h = fake();
    h.emit("message_end", { message: assistant("Done for now.", [{ id: "1", name: "context_need" }]) });
    const spoken = await h.need.execute("1", { current_phase_settled: true }, undefined, undefined, h.ctx);
    expect(spoken.terminate).toBe(true);
    expect(spoken.content[0]?.text).toBe("Recorded.");

    h.emit("message_end", { message: assistant("", [{ id: "2", name: "context_need" }]) });
    const silent = await h.need.execute("2", { current_phase_settled: true }, undefined, undefined, h.ctx);
    expect(silent.terminate).toBe(false);
    expect(silent.content[0]?.text).toBe("Recorded.");

    h.emit("message_end", { message: assistant("<think>x</think>", [{ id: "3", name: "context_need" }]) });
    expect((await h.need.execute("3", { current_phase_settled: true }, undefined, undefined, h.ctx)).terminate).toBe(
      false,
    );
    expect((await h.need.execute("zz", { current_phase_settled: true }, undefined, undefined, h.ctx)).terminate).toBe(
      false,
    );
  });

  it("keeps the latest valid need and ignores an invalid one", async () => {
    const h = fake();
    const first = await h.need.execute("1", { min_remaining_tokens: 10 }, undefined, undefined, h.ctx);
    expect(first.details.need).toEqual({ min_remaining_tokens: 10 });
    const bad = await h.need.execute("2", { focus: "only focus" }, undefined, undefined, h.ctx);
    expect(bad.details.need).toBeNull();
    h.host.usage = { tokens: 95, contextWindow: 100, percent: 95 };
    await h.need.execute("3", { min_remaining_tokens: 50, current_phase_settled: true }, undefined, undefined, h.ctx);
    await h.need.execute("4", { focus: "bad" } as ContextNeedInput, undefined, undefined, h.ctx);
    h.emit("agent_settled", { aborted: false });
    expect(h.host.compactions).toHaveLength(1);
  });

  it("renders one line", () => {
    expect(contextNeedLine({ preserve: { rounds: 3 } })).toBe("context: keep 3 rounds");
    expect(
      contextNeedLine({
        preserve: { user_turns: 2, rounds: 3 },
        min_remaining_tokens: 5000,
        focus: "the auth\nrefactor",
        current_phase_settled: true,
      }),
    ).toBe("context: keep 2 turns, 3 rounds · need 5000 tokens · focus the auth refactor · phase settled");
    expect(contextNeedLine({})).toBe("");
    expect(contextNeedLine(undefined)).toBe("");
    const h = fake();
    expect(h.need.renderCall({ preserve: { rounds: 3 }, focus: "a long focus" }, theme).render(80)).toEqual([
      "context: keep 3 rounds · focus a long focus",
    ]);
    expect(h.need.renderCall({ focus: "a long focus here" }, theme).render(14)).toEqual(["context: focu…"]);
    expect(h.need.renderResult().render(80)).toEqual([]);
  });

  it("counts the kept tail by user turns and tool rounds", () => {
    expect(keptHistory(BRANCH, "u3")).toEqual({
      kept: { userTurns: 1, rounds: 1 },
      total: { userTurns: 3, rounds: 4 },
    });
    expect(keptHistory(BRANCH, "a2").kept).toEqual({ userTurns: 1, rounds: 3 });
  });

  it("preserve: warns when pi's cut keeps less than asked, silent when it keeps enough", async () => {
    const h = fake();
    await h.need.execute(
      "1",
      { min_remaining_tokens: 1, preserve: { user_turns: 2, rounds: 3 } },
      undefined,
      undefined,
      h.ctx,
    );
    h.emit("session_before_compact", compactEvent("u3"));
    expect(h.ui.notes).toHaveLength(1);
    expect(h.ui.notes[0]).toContain("keeps 1 user turns and 1 rounds, 2 and 3 were asked");
    h.emit("session_before_compact", compactEvent("u2"));
    expect(h.ui.notes).toHaveLength(1);
  });

  it("preserve is capped by the history that exists", async () => {
    const h = fake();
    await h.need.execute(
      "1",
      { min_remaining_tokens: 1, preserve: { user_turns: 50, rounds: 50 } },
      undefined,
      undefined,
      h.ctx,
    );
    h.emit("session_before_compact", compactEvent("u1"));
    expect(h.ui.notes).toEqual([]);
  });

  it("focus: reported as not applied unless it already rides in the instructions", async () => {
    const h = fake();
    await h.need.execute("1", { focus: "keep the schema", min_remaining_tokens: 1 }, undefined, undefined, h.ctx);
    h.emit("session_before_compact", compactEvent("u1"));
    expect(h.ui.notes[0]).toContain("focus was not passed");
    h.emit("session_before_compact", compactEvent("u1", { customInstructions: "keep the schema", reason: "manual" }));
    expect(h.ui.notes).toHaveLength(1);
  });

  it("no need: nothing to say", () => {
    const h = fake();
    h.emit("session_before_compact", compactEvent("u3"));
    expect(h.ui.notes).toEqual([]);
  });

  it("decides compaction from settled, the floor and measured free context", () => {
    const usage = (tokens: number | null) => ({ tokens, contextWindow: 1000 });
    const need = { current_phase_settled: true as const, min_remaining_tokens: 300 };
    expect(wantsCompaction(need, usage(800))).toBe(true);
    expect(wantsCompaction(need, usage(700))).toBe(false);
    expect(wantsCompaction(need, usage(null))).toBe(false);
    expect(wantsCompaction(need, undefined)).toBe(false);
    expect(wantsCompaction({ min_remaining_tokens: 300 }, usage(900))).toBe(false);
    expect(wantsCompaction({ current_phase_settled: true }, usage(900))).toBe(false);
    expect(wantsCompaction(null, usage(900))).toBe(false);
  });

  it("compacts at agent_settled with the focus as instructions, once", async () => {
    const h = fake();
    h.host.usage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await h.need.execute(
      "1",
      { min_remaining_tokens: 300, current_phase_settled: true, focus: "the open bug" },
      undefined,
      undefined,
      h.ctx,
    );
    h.emit("agent_settled", { aborted: true });
    expect(h.host.compactions).toEqual([]);
    h.emit("agent_settled", { aborted: false });
    h.emit("agent_settled", { aborted: false });
    expect(h.host.compactions).toEqual([{ customInstructions: "the open bug" }]);
  });

  it("does not compact while there is room, or when the phase is not settled", async () => {
    const h = fake();
    h.host.usage = { tokens: 100, contextWindow: 1000, percent: 10 };
    await h.need.execute("1", { min_remaining_tokens: 300, current_phase_settled: true }, undefined, undefined, h.ctx);
    h.emit("agent_settled", { aborted: false });
    h.host.usage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await h.need.execute("2", { min_remaining_tokens: 300 }, undefined, undefined, h.ctx);
    h.emit("agent_settled", { aborted: false });
    expect(h.host.compactions).toEqual([]);
  });

  it("a finished compaction drops the need", async () => {
    const h = fake();
    h.host.usage = { tokens: 900, contextWindow: 1000, percent: 90 };
    await h.need.execute("1", { min_remaining_tokens: 300, current_phase_settled: true }, undefined, undefined, h.ctx);
    h.emit("agent_settled", { aborted: false });
    h.emit("session_compact", {});
    h.emit("agent_settled", { aborted: false });
    expect(h.host.compactions).toHaveLength(1);
  });
});

describe("settings", () => {
  it("resolves the agent dir and the flag", () => {
    expect(agentDirectory({ PI_CODING_AGENT_DIR: " /a " }, "/h")).toBe("/a");
    expect(agentDirectory({}, "/h")).toBe("/h/.pi/agent");
    expect(readEnabled(undefined)).toBe(true);
    expect(readEnabled('{"enabled":false}')).toBe(false);
  });

  it("summaryLine collapses whitespace", () => {
    expect(summaryLine({ current_turn_title: "a", current_turn_description: "b\n c" })).toBe("a — b c");
  });
});
