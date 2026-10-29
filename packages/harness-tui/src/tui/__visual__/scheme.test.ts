/** scheme_repl tape goldens. Prompt band on every PNG. */
import {
  AgentCallJob,
  ProgrammaticJob,
  ReACTChunk,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { findDisclosure, localClient, openTea, seatTurn, type OpenTea, type TranscriptBlock } from "./_helpers.js";

const PROMPT = 'Eval (read_file "src/tea.ts")\nand show me the bindings it returns.';
const EXPR = '(read_file "src/tea.ts")';

function mountTurn(opts: {
  prompt: string;
  doneWork: SessionTurn["doneWork"];
  queue?: SessionTurn["queue"];
  /** Compact is the product default; goldens run expanded. */
  tapeExpanded?: boolean;
}): ReturnType<typeof openTea> {
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: opts.prompt,
    doneWork: opts.doneWork,
    queue: opts.queue ?? [],
  });
  client.sessionRoot.head = turn;
  client.kernelRoot.approvalAskThrottleMs = 0;
  return openTea(client, { tapeExpanded: opts.tapeExpanded });
}

function dumpTexts(ui: OpenTea): string {
  return ui
    .dump()
    .transcript.flatMap((block) => block.texts)
    .join("\n");
}

function clickExpand(ui: OpenTea, needle: string): void {
  const { col, row } = ui.hitOf(needle);
  ui.click(col, row);
}

function findIndentDisclosure(blocks: TranscriptBlock[]): TranscriptBlock | undefined {
  for (const block of blocks) {
    if (block.type === "box") {
      const inner = findDisclosure(block.children ?? []);
      if (inner !== undefined) return inner;
    }
    if (block.children !== undefined) {
      const nested = findIndentDisclosure(block.children);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * read_file is a single path line, not a disclosure (53cfb0147). The inner row
 * is an indented box whose indication carries the gutter.
 */
function findIndentLineGutter(blocks: TranscriptBlock[]): unknown {
  for (const block of blocks) {
    if (block.type === "box" && block.key?.endsWith(":indent") === true) {
      const line = findIndication(block);
      if (line !== undefined) return line.gutter ?? null;
    }
    const nested = findIndentLineGutter(block.children ?? []);
    if (nested !== null) return nested;
  }
  return null;
}

function findIndication(block: TranscriptBlock): TranscriptBlock | undefined {
  if (block.type === "indication") return block;
  for (const child of block.children ?? []) {
    const found = findIndication(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function dumpKinds(transcript: TranscriptBlock[]): string[] {
  return transcript
    .filter((block) => block.band !== "gap")
    .map((block) => {
      if (block.band === "input" || block.type === "speech") return "speech";
      if (
        block.texts.some(
          (text) =>
            text.includes("using tools") || text.includes("waiting for response") || text.includes("responding"),
        )
      ) {
        return "loop";
      }
      if (block.key === "call_repl" || block.texts.join("").includes("read_file")) return "scheme";
      if (block.type === "box" || block.texts.some((text) => text.includes("Read **"))) {
        return "tool";
      }
      return block.type ?? "unknown";
    });
}

function mintScheme(inner: SystemToolJob): ProgrammaticJob {
  const outer = new ProgrammaticJob({
    toolCallId: "call_repl",
    argsJson: JSON.stringify({ expr: EXPR }),
  });
  outer.pushInvocation(inner);
  return outer;
}

test("scheme_repl tape: prompt → live → seal", () => {
  const inner = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
  });
  const outer = mintScheme(inner);
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [outer],
    queue: [new ReACTChunk()],
  });

  const live = ui.dump();
  const liveOuter = findDisclosure(live.transcript);
  const liveInner = findIndentLineGutter(live.transcript);
  expect({
    kinds: dumpKinds(live.transcript),
    outer: { collapsed: liveOuter?.collapsed ?? null, gutter: liveOuter?.gutter ?? null },
    inner: { gutter: liveInner },
  }).toEqual({
    kinds: ["speech", "scheme", "tool"],
    outer: { collapsed: true, gutter: { kind: "top", glyph: "⒪" } },
    inner: { gutter: { kind: "spinner", profile: "tool", rows: "top" } },
  });
  expect(ui).toMatchScreenshot("scheme-live");

  const turn = ui.client.sessionRoot.head;
  expect(turn).not.toBeNull();
  turn?.queue.splice(0);
  inner.receiptJson = '{"ok":true,"text":"export const Tea"}';
  inner.completed = true;
  outer.receiptJson = '{"ok":true,"value":"export const Tea"}';
  outer.completed = true;

  const ok = ui.dump();
  const okOuter = findDisclosure(ok.transcript);
  const okInner = findIndentLineGutter(ok.transcript);
  expect({
    kinds: dumpKinds(ok.transcript),
    outer: { collapsed: okOuter?.collapsed ?? null, gutter: okOuter?.gutter ?? null },
    inner: { gutter: okInner },
  }).toEqual({
    kinds: ["speech", "scheme", "tool"],
    outer: { collapsed: true, gutter: { kind: "top", glyph: "⒪" } },
    inner: { gutter: { kind: "top", glyph: "·" } },
  });
  expect(ui).toMatchScreenshot("scheme-ok");

  clickExpand(ui, "read_file");
  expect({
    kinds: dumpKinds(ui.dump().transcript),
    outerFolded: findDisclosure(ui.dump().transcript)?.collapsed ?? null,
    innerFolded: findIndentDisclosure(ui.dump().transcript)?.collapsed ?? null,
    body: dumpTexts(ui).includes("export const Tea"),
  }).toEqual({
    kinds: ["speech", "scheme", "tool"],
    outerFolded: false,
    innerFolded: null, // read_file is one line, never a disclosure
    body: true,
  });
  expect(ui).toMatchScreenshot("scheme-ok-expanded");
});

test("scheme_repl caption: collapsed description, expand expr", () => {
  const outer = new ProgrammaticJob({
    toolCallId: "call_repl",
    argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "Add one and two" }),
    outcomeJson: '{"ok":true,"value":["3"]}',
    completed: true,
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [outer],
  });
  const cell = findDisclosure(ui.dump().transcript);
  const caption = cell?.texts.join("\n") ?? "";
  expect({
    collapsed: cell?.collapsed ?? null,
    caption: caption.includes("Add one and two"),
    expr: caption.includes("{1 + 2}"),
  }).toEqual({ collapsed: true, caption: true, expr: false });
  expect(ui).toMatchScreenshot("scheme-ok-caption");

  clickExpand(ui, "Add one and two");
  const openTexts = dumpTexts(ui);
  expect({
    collapsed: findDisclosure(ui.dump().transcript)?.collapsed ?? null,
    one: openTexts.includes("1"),
    plus: openTexts.includes("+"),
    two: openTexts.includes("2"),
  }).toEqual({ collapsed: false, one: true, plus: true, two: true });
  expect(ui).toMatchScreenshot("scheme-ok-caption-expanded");
});

test("scheme_repl inner ask", () => {
  const inner = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    policyResult: "ask",
  });
  const outer = mintScheme(inner);
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [outer],
  });
  const asked = ui.dump();
  const askedOuter = findDisclosure(asked.transcript);
  expect({
    kinds: dumpKinds(asked.transcript),
    outer: { collapsed: askedOuter?.collapsed ?? null, gutter: askedOuter?.gutter ?? null },
    inner: findIndentDisclosure(asked.transcript) === undefined,
    ask: asked.ask,
    annotation: asked.composer.annotation,
  }).toEqual({
    kinds: ["speech", "scheme"],
    outer: { collapsed: true, gutter: { kind: "top", glyph: "⒪" } },
    inner: true,
    ask: [],
    annotation: "Ask · Read **src/tea.ts**",
  });
  expect(ui).toMatchScreenshot("scheme-inner-ask");
});

test("scheme_repl compact tape: floor-allow inner and agent start render under the bag", () => {
  // Both of these fuse at top level — floor-allow into thinking, comm-first
  // (agent) unconditionally. Inside a bag the bag row is their host parent, so
  // the compact tape must show them instead of absorbing them.
  const read = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    policyResult: "policyApprove",
    completed: true,
    outcomeJson: '{"ok":true,"text":"export const Tea"}',
  });
  const agent = new AgentCallJob({
    toolCallId: "call_agent",
    name: "agent__ask",
    argsJson: JSON.stringify({ spec: "explore", message: "map the repo" }),
    workerSessionId: "w-explore",

    completed: true,
    outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("mapped") }),
  });
  const outer = new ProgrammaticJob({
    toolCallId: "call_repl",
    argsJson: JSON.stringify({
      expr: '(read_file "src/tea.ts") (agent/ask "map the repo")',
      description: "Read tea and delegate",
    }),
    completed: true,
    outcomeJson: '{"ok":true,"value":"export const Tea"}',
  });
  outer.pushInvocation(read);
  outer.pushInvocation(agent);
  using ui = mountTurn({ prompt: PROMPT, doneWork: [outer], tapeExpanded: false });

  const texts = dumpTexts(ui);
  expect({
    bag: texts.includes("Read tea and delegate"),
    innerTool: texts.includes("src/tea.ts"),
    agentStart: texts.includes("explore"),
    program: texts.includes("read_file"),
  }).toEqual({ bag: true, innerTool: true, agentStart: true, program: true });
  expect(ui).toMatchScreenshot("scheme-compact-inners");
});

test("scheme_repl fail", () => {
  const inner = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    outcomeJson: '{"ok":true,"text":"export const Tea"}',
    completed: true,
  });
  const outer = mintScheme(inner);
  outer.receiptJson = '{"ok":false,"text":"boom"}';
  outer.completed = true;
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [outer],
  });
  const fail = ui.dump();
  const failOuter = findDisclosure(fail.transcript);
  expect({
    kinds: dumpKinds(fail.transcript),
    outer: {
      collapsed: failOuter?.collapsed ?? null,
      gutter: failOuter?.gutter ?? null,
      role: failOuter?.role ?? null,
    },
  }).toEqual({
    kinds: ["speech", "scheme", "tool"],
    outer: { collapsed: true, gutter: { kind: "top", glyph: "⒪" }, role: "error" },
  });
  expect(ui).toMatchScreenshot("scheme-fail");
});
