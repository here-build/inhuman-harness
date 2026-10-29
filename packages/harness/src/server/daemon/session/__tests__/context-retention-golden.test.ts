/**
 * Golden projections for tail retention (design §7.2). The fixture is built
 * the production way: every round's `messages` come from `historyBehind`, the
 * R1 policy is stamped when the turn is minted, the R2 horizon when a tool is
 * admitted, and the R3 clock when a round opens.
 *
 * Three turns, three rounds each:
 *   T1  2 pictures. R1 grep + read_file. R2 failing shell, then a steer. R3 text.
 *   T2  R1 web_search + MCP. R2 write_file (+ system note). R3 scheme_repl (+ system note).
 *   T3  1 picture. R1 read_file, then an approval note. R2 agent__ask. R3 text.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  ReACTChunk,
  responseCall,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  ToolCallJob,
  TurnApprovalNoteChunk,
  TurnSteerChunk,
  userVisualsJson,
  WebSearchExpectation,
  WebSearchToolJob,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";
import * as Y from "yjs";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { recallContext } from "@inhuman.tools/turn/tool-runtime";

import {
  historyBehind,
  policyOfTurn,
  projectHistory,
  stampJobRetention,
  stampRetentionClock,
  turnRetentionJson,
  parseClock,
  type HistoryMessage,
  type HistoryUserPart,
} from "@/context";

beforeEach(() => resetLocalIDs());

const PIC = (id: string): UserVisualIdentity => ({
  id,
  mime: "image/png",
  width: 100,
  height: 50,
  resizedFrom: null,
  sourcePath: null,
});
const readVisual = (id: string) => (id.startsWith("pic") ? new Uint8Array([1, 2, 3]) : null);

type Job = ToolCallJob | ProgrammaticJob;
type Spec = {
  readonly text?: string;
  readonly calls?: ReadonlyArray<{ readonly job: Job; readonly name: string; readonly args?: string }>;
  readonly systemNote?: string;
  /** Cells claimed into the round's prelude before it opens. */
  readonly before?: readonly (TurnSteerChunk | TurnApprovalNoteChunk)[];
  readonly now?: number;
};

class Fixture {
  readonly plexus = SessionPlexus.create("ret-golden", "/work");
  /** Every request, by round label, projected the moment the round opened. */
  readonly requests = new Map<string, HistoryMessage[]>();
  readonly completions = new Map<string, CompletionExpectation>();
  turns: SessionTurn[] = [];
  clock = 1_000_000;

  constructor() {
    onTestFinished(() => this.plexus.destroy());
  }

  mint(promptText: string, opts: { visuals?: readonly UserVisualIdentity[]; config?: string; kvs?: Record<string, string> } = {}) {
    const tail = this.plexus.root.head ?? new SessionSystemPrompt({ env: { Mode: "act" } });
    const turn = new SessionTurn({
      turnTail: tail,
      prompt: prompt.user`${promptText}`,
      retentionJson: turnRetentionJson(opts.config ?? "", opts.kvs ?? {}),
      ...(opts.visuals === undefined ? {} : { visualsJson: userVisualsJson(opts.visuals) }),
    });
    this.plexus.root.seatHead(turn);
    this.turns.push(turn);
    return turn;
  }

  /** Open a round (production order), project its request, then settle it. */
  round(label: string, turn: SessionTurn, spec: Spec = {}): HistoryMessage[] {
    const first = !turn.doneWork.some((cell) => cell instanceof CompletionJob);
    if (first) turn.take();
    else {
      turn.enqueue(new ReACTChunk());
      turn.take();
    }
    for (const cell of spec.before ?? []) turn.doneWork.push(cell);
    const completion = new CompletionExpectation({
      connectionId: "c1",
      model: "gpt-5",
      promptText: first ? turn.completionMessage : prompt.user``,
      messages: historyBehind(turn, { kv: {} }),
    });
    if (spec.systemNote !== undefined) completion.systemNote = prompt.system`${spec.systemNote}`;
    turn.enqueue(new CompletionJob({ expectation: completion }));
    stampRetentionClock(completion, spec.now ?? this.clock);
    const rows = [...projectHistory(completion, { readVisual })];
    this.requests.set(label, rows);
    this.completions.set(label, completion);
    // The model answers; its calls become tool jobs admitted onto the tape.
    completion.responseText = spec.text ?? "";
    completion.setResponseCalls((spec.calls ?? []).map((call) => responseCall(call.job.toolCallId, call.name, call.args ?? "{}")));
    completion.warmUntilMs = (spec.now ?? this.clock) + 5 * 60_000;
    turn.take();
    for (const call of spec.calls ?? []) {
      stampJobRetention(call.job, policyOfTurn(turn), { entryClass: call.name === "read_file" ? "read" : undefined });
      turn.enqueue(call.job);
      turn.take();
    }
    this.clock += 1000;
    return rows;
  }
}

function sys(id: string, name: string, args: string, outcome: object): SystemToolJob {
  return new SystemToolJob({ toolCallId: id, name, argsJson: args, outcomeJson: JSON.stringify(outcome), completed: true });
}

const KB = (n: number, ch = "x") => ch.repeat(n * 1024);

function build(): Fixture {
  const f = new Fixture();
  const t1 = f.mint("fix the build", { visuals: [PIC("pic-a"), PIC("pic-b")] });
  f.round("T1R1", t1, {
    calls: [
      { job: sys("g1", "grep", '{"pattern":"foo","path":"src"}', { ok: true, text: KB(3, "g") }), name: "grep" },
      { job: sys("r1", "read_file", '{"path":"src/a.ts"}', { ok: true, text: KB(12, "r") }), name: "read_file" },
    ],
  });
  f.round("T1R2", t1, {
    calls: [
      {
        job: sys("s1", "shell", '{"command":"pnpm test"}', {
          ok: false,
          value: { exitCode: 1, stdout: `${KB(20, "o")}\nline-a\nFAIL src/a.test.ts`, stderr: "" },
        }),
        name: "shell",
      },
    ],
  });
  const steer = new TurnSteerChunk({ text: prompt.user`use pnpm` });
  f.round("T1R3", t1, { text: "Switching tooling.", before: [steer] });

  const t2 = f.mint("now add a feature");
  f.round("T2R1", t2, {
    calls: [
      {
        job: new WebSearchToolJob({
          toolCallId: "w1",
          name: "web_search",
          argsJson: '{"query":"zod"}',
          expectation: new WebSearchExpectation({ connectionId: "web_search", query: "zod", limit: 5 }),
          outcomeJson: JSON.stringify({ ok: true, text: `https://a.dev https://b.dev ${KB(2)}` }),
          completed: true,
        }),
        name: "web_search",
      },
      {
        job: new MCPToolJob({
          toolCallId: "m1",
          name: "mcp__github__search_issues",
          argsJson: "{}",
          connectionKey: "github",
          serverToolName: "search_issues",
          expectation: new McpToolExpectation({ connectionId: "github" }),
          outcomeJson: JSON.stringify({ ok: true, text: KB(9, "m") }),
          completed: true,
        }),
        name: "mcp__github__search_issues",
      },
    ],
  });
  f.round("T2R2", t2, {
    systemNote: "REMINDER-R2",
    calls: [
      {
        job: new FileMutateToolJob({
          toolCallId: "wf1",
          name: "write_file",
          argsJson: JSON.stringify({ path: "src/new.ts", content: KB(6, "w") }),
          outcomeJson: JSON.stringify({ ok: true, text: "wrote src/new.ts" }),
          completed: true,
        }),
        name: "write_file",
        args: JSON.stringify({ path: "src/new.ts", content: KB(6, "w") }),
      },
    ],
  });
  f.round("T2R3", t2, {
    systemNote: "REMINDER-R3",
    calls: [
      {
        job: new ProgrammaticJob({
          toolCallId: "p1",
          toolName: "scheme_repl",
          argsJson: '{"expr":"(compute)"}',
          outcomeJson: JSON.stringify({ ok: true, text: KB(40, "p") }),
          completed: true,
        }),
        name: "scheme_repl",
      },
    ],
  });

  const t3 = f.mint("one more thing", { visuals: [PIC("pic-c")] });
  f.round("T3R1", t3, {
    calls: [{ job: sys("r2", "read_file", '{"path":"src/b.ts"}', { ok: true, text: KB(4, "b") }), name: "read_file" }],
  });
  const note = new TurnApprovalNoteChunk({ leafId: "leaf", toolName: "edit_file", allowed: true, text: prompt.user`ok` });
  f.round("T3R2", t3, {
    before: [note],
    calls: [{ job: sys("a1", "agent__ask", "{}", { ok: true, text: KB(2, "a") }), name: "agent__ask" }],
  });
  f.round("T3R3", t3, { text: "done" });
  return f;
}

/** `role: head` lines, with tool-row ids. Readable and stable. */
function lines(rows: readonly HistoryMessage[], width = 150): string[] {
  return rows.map((row) => {
    const content =
      typeof row.content === "string"
        ? row.content
        : row.content == null
          ? "null"
          : row.content
              .map((part) => ("text" in part ? part.text : `<image ${part.id}${part.bytes ? "" : " no-bytes"}>`))
              .join(" | ");
    const head = content
      .replaceAll("\n", "⏎")
      .replaceAll(/job:\w{8}/g, "job:REF")
      .slice(0, width);
    const calls = row.toolCalls?.map((call) => `${call.name}(${call.argsJson.slice(0, 60)})`).join(", ");
    return `${row.role}${row.toolCallId ? `#${row.toolCallId}` : ""}${calls ? ` calls[${calls}]` : ""}: ${head}`;
  });
}

const text = (rows: readonly HistoryMessage[]) => lines(rows, Infinity).join("\n");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
type ImagePart = Extract<HistoryUserPart, { type: "image" }>;
const images = (rows: readonly HistoryMessage[]): ImagePart[] =>
  rows.flatMap((row) =>
    typeof row.content === "string" || row.content == null
      ? []
      : (row.content as readonly HistoryUserPart[]).filter((part): part is ImagePart => part.type === "image"),
  );

describe("golden: 3 turns x 3 rounds, built the production way", () => {
  it("G1/F11: pictures live only within their own turn; one line per picture", () => {
    const f = build();
    const t1r3 = f.requests.get("T1R3")!;
    const t3r3 = f.requests.get("T3R3")!;
    expect(images(t1r3).map((part) => part.id)).toEqual(["pic-a", "pic-b"]);
    expect(images(t3r3).map((part) => part.id)).toEqual(["pic-c"]);
    expect(text(t3r3)).toContain("[Image #1 elided: image/png 100x50 — recall visual:pic-a]");
    expect(text(t3r3)).toContain("[Image #2 elided: image/png 100x50 — recall visual:pic-b]");
    // No duplicate "omitted" line next to a described one, and no bytes:null image part anywhere.
    for (const rows of f.requests.values()) {
      expect(images(rows).every((part) => part.bytes !== null)).toBe(true);
    }
  });

  it("G2/F2: a steer and an approval note are emitted exactly once, at their own round", () => {
    const f = build();
    for (const label of ["T2R1", "T2R3", "T3R3"]) {
      expect(count(text(f.requests.get(label)!), "use pnpm"), label).toBe(1);
    }
    for (const label of ["T3R3"]) {
      expect(count(text(f.requests.get(label)!), "The user allowed this tool use (edit_file)"), label).toBe(1);
    }
    expect(count(text(f.requests.get("T1R3")!), "use pnpm")).toBe(1);
  });

  it("G11/N1: a system note is addressed to its own round and is never replayed", () => {
    const f = build();
    expect(text(f.requests.get("T2R2")!)).toContain("REMINDER-R2");
    expect(text(f.requests.get("T2R3")!)).not.toContain("REMINDER-R2");
    expect(text(f.requests.get("T2R3")!)).toContain("REMINDER-R3");
    for (const label of ["T3R1", "T3R2", "T3R3"]) {
      expect(text(f.requests.get(label)!), label).not.toMatch(/REMINDER-R[23]/);
    }
  });

  it("G5: the clock steps at a turn boundary and holds in between", () => {
    const f = build();
    const reasons = ["T1R1", "T1R2", "T1R3", "T2R1", "T2R2", "T2R3", "T3R1", "T3R2", "T3R3"].map((label) => {
      const clock = parseClock(f.completions.get(label)!.retentionClockJson)!;
      return `${label}:${clock.reason}${clock.at === f.completions.get(label)!.uuid ? "*" : ""}`;
    });
    expect(reasons).toEqual([
      "T1R1:turn*",
      "T1R2:hold",
      "T1R3:hold",
      "T2R1:turn*",
      "T2R2:hold",
      "T2R3:hold",
      "T3R1:turn*",
      "T3R2:hold",
      "T3R3:hold",
    ]);
  });

  it("G2/G3: within a turn nothing deep expires; across the boundary reads become stubs and the failure a summary", () => {
    const f = build();
    const t1r3 = text(f.requests.get("T1R3")!);
    // Held clock: grep (2 rounds) and the failing shell are still whole inside T1.
    expect(t1r3).toContain("g".repeat(100));
    expect(t1r3).toContain("o".repeat(100));
    const t2r1 = text(f.requests.get("T2R1")!);
    expect(t2r1).toContain("[read_file elided: src/a.ts, 1 lines, 12.0 KB — re-read or recall job:");
    expect(t2r1).toContain("[grep elided:");
    expect(t2r1).toMatch(/\[shell `pnpm test` exit 1, [\d.]+ KB elided; tail: .*FAIL src\/a\.test\.ts — recall job:/);
    expect(t2r1).toContain("use pnpm");
  });

  it("G12/N3: a large write's arguments are stubbed after the turn, still valid JSON, still answered", () => {
    const f = build();
    const within = f.requests.get("T2R3")!;
    const after = f.requests.get("T3R1")!;
    const callOf = (rows: readonly HistoryMessage[]) => rows.flatMap((row) => row.toolCalls ?? []).find((call) => call.name === "write_file")!;
    expect(callOf(within).argsJson.length).toBeGreaterThan(6000);
    const stubbed = JSON.parse(callOf(after).argsJson) as Record<string, string>;
    expect(stubbed.path).toBe("src/new.ts");
    expect(stubbed.content).toMatch(/^\[elided: 1 lines, 6\.0 KB — recall job:[0-9a-zA-Z]+#args\]$/);
    expect(after.some((row) => row.role === "tool" && row.toolCallId === "wf1")).toBe(true);
  });

  it("G13/F5: a huge program result is capped in its turn and keeps a head plus a stub after it", () => {
    const f = build();
    const programRow = (rows: readonly HistoryMessage[]) => rows.find((row) => row.toolCallId === "p1")!;
    const inTurn = programRow(f.requests.get("T3R1")!);
    expect(typeof inTurn.content).toBe("string");
    // T3R1 is already the next turn: head 400 + stub.
    expect(String(inTurn.content)).toMatch(/^p{400}\n\[scheme_repl elided: \(compute\)/);
  });

  it("G16: a per-server override keeps an MCP result through the next turn", () => {
    const f = new Fixture();
    const config = JSON.stringify({ tools: { "mcp:github/*": { keep: { turns: 2 } } } });
    const t1 = f.mint("a", { config });
    f.round("A1", t1, {
      calls: [
        {
          job: new MCPToolJob({
            toolCallId: "m1",
            name: "mcp__github__search_issues",
            argsJson: "{}",
            connectionKey: "github",
            serverToolName: "search_issues",
            expectation: new McpToolExpectation({ connectionId: "github" }),
            outcomeJson: JSON.stringify({ ok: true, text: KB(9, "m") }),
            completed: true,
          }),
          name: "mcp__github__search_issues",
        },
      ],
    });
    f.round("A2", t1, { text: "ok" });
    const t2 = f.mint("b", { config });
    f.round("B1", t2, { text: "next" });
    const t3 = f.mint("c", { config });
    f.round("C1", t3, { text: "later" });
    expect(text(f.requests.get("B1")!)).toContain("m".repeat(200));
    expect(text(f.requests.get("C1")!)).toContain("[mcp__github__search_issues elided:");
  });

  it("F13: every tool row answers a call in the same projection, in every request", () => {
    const f = build();
    for (const [label, rows] of f.requests) {
      const open = new Set<string>();
      for (const row of rows) {
        for (const call of row.toolCalls ?? []) open.add(call.id);
        if (row.role === "tool") expect(open.has(row.toolCallId ?? ""), `${label}: orphan ${row.toolCallId}`).toBe(true);
      }
    }
  });

  it("G4: between holds the earlier request is a byte prefix of the later one (bar the round-scoped prelude)", () => {
    const f = build();
    const r2 = f.requests.get("T2R2")!;
    const r3 = f.requests.get("T2R3")!;
    // T2R2 ends with its own prelude: the system note. Everything before it is stable.
    const stable = r2.slice(0, r2.length - 1);
    expect(JSON.stringify(r3.slice(0, stable.length))).toBe(JSON.stringify(stable));
  });

  it("G8: a restart re-projects byte-identically, and later config edits do not reach old turns", () => {
    const f = build();
    const tip = f.completions.get("T3R3")!;
    const before = JSON.stringify([...projectHistory(tip, { readVisual })]);
    const stamped = f.turns.map((turn) => turn.retentionJson);

    // Config and kv change after the fact: new turns see it, old turns do not.
    const changed = turnRetentionJson(JSON.stringify({ kinds: { "tool.read": { keep: "round" } } }), { "retention.tool.shell": '"round"' });
    expect(changed).not.toBe(stamped[0]);
    expect([...f.turns.map((turn) => turn.retentionJson)]).toEqual(stamped);
    expect(JSON.stringify([...projectHistory(tip, { readVisual })])).toBe(before);

    // Rehydrate the document into a fresh plexus.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(f.plexus.doc));
    const reborn = SessionPlexus.connect(doc, { undo: "stub" });
    onTestFinished(() => reborn.destroy());
    const rebornTip = reborn.loadEntity(tip.uuid);
    expect(rebornTip).toBeInstanceOf(CompletionExpectation);
    expect(JSON.stringify([...projectHistory(rebornTip as CompletionExpectation, { readVisual })])).toBe(before);
  });

  it("G9: a settings change affects only turns minted after it", () => {
    const f = new Fixture();
    const read = (id: string) => sys(id, "read_file", '{"path":"p.ts"}', { ok: true, text: KB(4, "z") });
    const t1 = f.mint("first");
    f.round("R1", t1, { calls: [{ job: read("a"), name: "read_file" }] });
    f.round("R2", t1, { text: "x" });
    // The user lowers tool.read to one round, then a new turn is minted.
    const t2 = f.mint("second", { config: JSON.stringify({ kinds: { "tool.read": { keep: "round" } } }) });
    f.round("S1", t2, { calls: [{ job: read("b"), name: "read_file" }] });
    f.round("S2", t2, { text: "y" });
    f.round("S3", t2, { text: "z" });
    // T1's read was admitted under the old rule (turn): present while T1 was current, and the
    // new turn's boundary step stubs it by the turn rule, not by the new one-round rule.
    expect(text(f.requests.get("R2")!)).toContain("z".repeat(100));
    // T2's read follows the new rule: whole for its consumer S2, a stub at S3.
    expect(text(f.requests.get("S2")!)).toContain("z".repeat(100));
    expect(text(f.requests.get("S3")!)).toContain("[read_file elided: p.ts");
  });

  it("session kv can only shorten retention", () => {
    const longer = turnRetentionJson("", { "retention.tool.read": '"forever"', "retention.shell": '"nonsense"' });
    const dist = turnRetentionJson("", {});
    expect(JSON.parse(longer).kinds["tool.read"]).toEqual(JSON.parse(dist).kinds["tool.read"]);
    const shorter = turnRetentionJson("", { "retention.tool.read": '"round"' });
    expect(JSON.parse(shorter).kinds["tool.read"].keep).toEqual(["turn", "round"]);
    expect(JSON.parse(shorter).kinds["tool.read"].leave).toEqual("stub");
  });

  it("the whole T3R3 request, as the model reads it", () => {
    const f = build();
    expect(lines(f.requests.get("T3R3")!, 110)).toMatchInlineSnapshot(`
      [
        "system: Reply in prose. You do not have tools.",
        "system: Workspace: /work⏎Mode: act",
        "user: fix the build | [Image #1 elided: image/png 100x50 — recall visual:pic-a] | [Image #2 elided: image/png 100x50",
        "assistant calls[grep({}), read_file({})]: null",
        "tool#g1: [grep elided: "foo" in src, 1 lines — recall job:REF]",
        "tool#r1: [read_file elided: src/a.ts, 1 lines, 12.0 KB — re-read or recall job:REF]",
        "assistant calls[shell({})]: null",
        "tool#s1: [shell \`pnpm test\` exit 1, 20.1 KB elided; tail: ooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo",
        "user: use pnpm",
        "assistant: Switching tooling.",
        "user: now add a feature",
        "assistant calls[web_search({}), mcp__github__search_issues({})]: null",
        "tool#w1: [web_search elided: "zod", 2 urls: https://a.dev, https://b.dev — recall job:REF]",
        "tool#m1: [mcp__github__search_issues elided: 9.0 KB — recall job:REF]",
        "assistant calls[write_file({"path":"src/new.ts","content":"[elided: 1 lines, 6.0 KB — r)]: null",
        "tool#wf1: wrote src/new.ts",
        "assistant calls[scheme_repl({})]: null",
        "tool#p1: pppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppppp",
        "user: one more thing | [Image #1: image/png, 100x50] | <image pic-c>",
        "assistant calls[read_file({})]: null",
        "tool#r2: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "user: The user allowed this tool use (edit_file) with this note:⏎<note>⏎ok⏎</note>",
        "assistant calls[agent__ask({})]: null",
        "tool#a1: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]
    `);
  });

  it("G15: context_recall reads a sealed result back, paged; unreachable refs are refused", () => {
    const f = build();
    const read = f.turns[0]!.doneWork.find((cell): cell is ToolCallJob => cell instanceof ToolCallJob && cell.toolCallId === "r1")!;
    const ref = `job:${read.uuid.slice(0, 8)}`;
    const root = f.plexus.root;
    const page1 = recallContext(root, { ref });
    expect(page1.ok).toBe(true);
    expect(String(page1.value)).toMatch(/^\[recall job:\w+ read_file: chars 0-5000 of 12288, page 1\/3; next offset 5000\]\n/);
    const page3 = recallContext(root, { ref, offset: 10000 });
    expect(String(page3.value)).toContain("chars 10000-12288 of 12288, page 3/3");
    expect(recallContext(root, { ref: "job:deadbeef" })).toMatchObject({ ok: false });
    expect(recallContext(root, { ref: "job:" })).toMatchObject({ ok: false });
    expect(recallContext(root, { ref: "visual:pic-a" })).toMatchObject({ ok: true, json: { visualId: "pic-a" } });
    expect(recallContext(root, { ref: "visual:nope" })).toMatchObject({ ok: false });
    const write = f.turns[1]!.doneWork.find((cell): cell is ToolCallJob => cell instanceof ToolCallJob && cell.toolCallId === "wf1")!;
    expect(String(recallContext(root, { ref: `job:${write.uuid.slice(0, 8)}#args` }).value)).toContain("src/new.ts");
  });

  it("G15: a ref on an abandoned branch (rewound head) is unreachable", () => {
    const f = build();
    const t3 = f.turns[2]!;
    const read = t3.doneWork.find((cell): cell is ToolCallJob => cell instanceof ToolCallJob && cell.toolCallId === "r2")!;
    f.plexus.root.head = f.turns[1]!;
    expect(recallContext(f.plexus.root, { ref: `job:${read.uuid.slice(0, 8)}` })).toMatchObject({ ok: false });
  });

  it("N2: an MCP image reaches the model as an image in its own turn and as a stub after it, never as base64 text", () => {
    const f = new Fixture();
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]).toString("base64");
    const shot = new MCPToolJob({
      toolCallId: "shot",
      name: "mcp__browser__screenshot",
      argsJson: "{}",
      connectionKey: "browser",
      serverToolName: "screenshot",
      expectation: new McpToolExpectation({ connectionId: "browser" }),
      outcomeJson: JSON.stringify({
        ok: true,
        value: [
          { type: "text", text: "viewport 800x600" },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      }),
      completed: true,
    });
    const t1 = f.mint("look");
    f.round("S1", t1, { calls: [{ job: shot, name: "mcp__browser__screenshot" }] });
    f.round("S2", t1, { text: "I see it" });
    const t2 = f.mint("again");
    f.round("N1", t2, { text: "ok" });
    const inTurn = f.requests.get("S2")!;
    expect(JSON.stringify(inTurn)).not.toContain(png);
    expect(text(inTurn)).toContain("[Image 1: image/png, 8 B]");
    expect(images(inTurn)).toHaveLength(1);
    const after = f.requests.get("N1")!;
    expect(JSON.stringify(after)).not.toContain(png);
    expect(images(after)).toHaveLength(0);
    expect(text(after)).toMatch(/\[Image 1 elided: image\/png, 8 B — recall job:\w+\]/);
  });

  it("an assistant row with nothing to say is never null-without-calls", () => {
    const f = new Fixture();
    const t1 = f.mint("q");
    f.round("E1", t1, { text: "" });
    f.round("E2", t1, { text: "done" });
    for (const row of f.requests.get("E2")!) {
      if (row.role === "assistant") expect(row.content === null && row.toolCalls === undefined).toBe(false);
    }
  });
});
