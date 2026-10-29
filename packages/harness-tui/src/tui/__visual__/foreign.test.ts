import {
  BotCallJob,
  AgentCallNotification,
  FailureOutcome,
  SessionOverview,
  MCPToolJob,
  McpToolExpectation,
  SessionSystemPrompt,
  SuccessfulOutcome,
  ToolCallJob,
  type CallOutcome,
} from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import {
  dumpTexts,
  findDisclosure,
  localClient,
  normalizeDump,
  openTea,
  seatTurn,
  type OpenTea,
  type TranscriptBlock,
} from "./_helpers.js";

const MCP_PROMPT = "Search mail for last week's invoices.\nI need the ones that are still unpaid.";
const AGENT_PROMPT = "Ask the reviewer bot to check the diff\nbefore I open the PR.";

const MCP_OK_OUTCOME = JSON.stringify({
  ok: true,
  text: "3 invoices from last week",
  value: {
    hits: [{ subject: "Invoice 1042", body: "line1\nline2\nline3" }],
  },
});

function mount(
  prompt: string,
  leaf: ToolCallJob | ReadonlyArray<ToolCallJob>,
  opts?: { ask?: boolean; model?: string },
) {
  const client = localClient();
  if (opts?.ask === true) {
    client.kernelRoot.approvalAskThrottleMs = 0;
    client.sessionRoot.permissionMode = "manual";
  }
  if (opts?.model !== undefined && opts.model !== "") {
    client.sessionRoot.applyKvs([{ form: "kv-set", key: "model", value: opts.model }]);
  }
  const leaves = Array.isArray(leaf) ? leaf : [leaf];
  for (const job of leaves) {
    if (!(job instanceof BotCallJob) || job.workerSessionId === "") continue;
    client.kernelRoot.sessions[job.workerSessionId] = new SessionOverview({
      title: "Reviewing the diff",
      recipeScope: "session",
      model: opts?.model ?? "",
    });
  }
  client.sessionRoot.head = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt,
    permissionMode: opts?.ask === true ? "manual" : undefined,
    doneWork: leaves,
    queue: [],
  });
  client.kernelRoot.approvalAskThrottleMs = 0;
  return openTea(client);
}

function clickExpand(ui: OpenTea, needle: string): void {
  const { col, row } = ui.hitOf(needle);
  ui.click(col, row);
}

function flattenBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  return blocks.flatMap((block) => [block, ...(block.children ? flattenBlocks(block.children) : [])]);
}

function gutterKind(blocks: TranscriptBlock[], kind: string): boolean {
  return flattenBlocks(blocks).some((block) => {
    const gutter = block.gutter;
    return typeof gutter === "object" && gutter !== null && (gutter as { kind?: string }).kind === kind;
  });
}

function mcpSearch() {
  return new MCPToolJob({
    toolCallId: "mcp-mail-search",
    name: "mcp__mail__search",
    connectionKey: "mail",
    serverToolName: "search",
    argsJson: '{"q":"invoices"}',
    expectation: new McpToolExpectation({
      connectionId: "mail",
      serverToolName: "search",
      argsJson: '{"q":"invoices"}',
    }),
  });
}

function reviewerCall(extra?: { readonly outcome?: CallOutcome; readonly completed?: boolean }) {
  return new BotCallJob({
    toolCallId: "call-reviewer-run",
    name: "agent__send",
    argsJson: '{"spec":"reviewer","message":"check the diff"}',
    workerSessionId: "w-reviewer",
    ...extra,
  });
}

function mcpFace(ui: OpenTea) {
  const frame = ui.dump();
  const texts = dumpTexts(frame.transcript);
  return {
    ...normalizeDump(frame),
    prompt: MCP_PROMPT.split("\n").every((line) => texts.includes(line)),
    mail: texts.includes("Mail"),
    search: texts.includes("search"),
    wire: texts.includes("mcp__mail__search"),
    invoice: texts.includes("Invoice 1042"),
    spinner: gutterKind(frame.transcript, "spinner"),
  };
}

function agentFace(ui: OpenTea) {
  const frame = ui.dump();
  const cell = findDisclosure(frame.transcript);
  const texts = dumpTexts(frame.transcript);
  const openTexts = cell?.collapsed === false ? dumpTexts(cell.children ?? []) : "";
  return {
    ...normalizeDump(frame),
    prompt: AGENT_PROMPT.split("\n").every((line) => texts.includes(line)),
    reviewer: texts.includes("reviewer"),
    glance: texts.includes("Reviewing the diff"),
    wire: texts.includes("agent__send"),
    ran: texts.includes("Ran 1 agent"),
    spinner: gutterKind(frame.transcript, "spinner"),
    model: texts.includes("Claude Haiku"),
    response: openTexts.includes("Response") && openTexts.includes("looks good"),
  };
}

test("mcp mail search — prompt, live, seal", () => {
  const job = mcpSearch();
  using ui = mount(MCP_PROMPT, job);

  expect(mcpFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "spinner", profile: "tool", rows: "top" },
    role: "foreground",
    annotation: "",
    prompt: true,
    mail: true,
    search: true,
    wire: false,
    invoice: false,
    spinner: true,
  });
  expect(ui).toMatchScreenshot("mcp-live");

  job.receiptJson = MCP_OK_OUTCOME;
  job.completed = true;
  expect(mcpFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "·" },
    role: "foreground",
    annotation: "",
    prompt: true,
    mail: true,
    search: true,
    wire: false,
    invoice: false,
    spinner: false,
  });
  expect(ui).toMatchScreenshot("mcp-ok");

  clickExpand(ui, "search");
  expect(mcpFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: false,
    gutter: { kind: "top", glyph: "·" },
    role: "foreground",
    annotation: "",
    prompt: true,
    mail: true,
    search: true,
    wire: false,
    invoice: false,
    spinner: false,
  });
  expect(ui).toMatchScreenshot("mcp-ok-open");
});

test("mcp mail search — ask, options in the composer stack", () => {
  const job = mcpSearch();
  job.policyResult = "ask";
  using ui = mount(MCP_PROMPT, job, { ask: true });
  const dump = ui.dump();
  const confirm = dump.composer.texts.join("\n");
  expect({
    ...normalizeDump(dump),
    ask: dump.ask,
    confirm: {
      q: confirm.includes("q"),
      invoices: confirm.includes("invoices"),
      askWord: confirm.includes("ask"),
    },
  }).toEqual({
    kinds: ["speech"],
    collapsed: null,
    gutter: null,
    role: null,
    annotation: "Ask · Mail **search**",
    ask: [],
    confirm: { q: true, invoices: true, askWord: false },
  });
  expect(ui).toMatchScreenshot("mcp-ask");
});

test("mcp mail search — fail", () => {
  const job = new MCPToolJob({
    toolCallId: "mcp-mail-search",
    name: "mcp__mail__search",
    connectionKey: "mail",
    serverToolName: "search",
    argsJson: '{"q":"invoices"}',
    outcomeJson: '{"ok":false,"text":"mail server timeout"}',
    completed: true,
    expectation: new McpToolExpectation({
      connectionId: "mail",
      serverToolName: "search",
      argsJson: '{"q":"invoices"}',
    }),
  });
  using ui = mount(MCP_PROMPT, job);
  expect(mcpFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "·" },
    role: "error",
    annotation: "",
    prompt: true,
    mail: true,
    search: true,
    wire: false,
    invoice: false,
    spinner: false,
  });
  expect(ui).toMatchScreenshot("mcp-fail");
});

test("mcp Gmail_SendEmail — ask, fat options", () => {
  const argsJson = JSON.stringify({
    recipient: "ada@example.com",
    subject: "Invoice 1042",
    body: [
      "Hi Ada,",
      "",
      "Please find last week's invoice.",
      "",
      "Line items:",
      "- Studio, 12 hours",
      "- Review, 4 hours",
      "",
      "Net 30 as usual.",
      "",
      "If the PO needs a different split, say so",
      "before Friday.",
      "",
      "Thanks",
    ].join("\n"),
    cc: ["bookkeeping@here.build"],
  });
  const job = new MCPToolJob({
    toolCallId: "mcp-gmail-send",
    name: "mcp__gmail__Gmail_SendEmail",
    connectionKey: "gmail",
    serverToolName: "Gmail_SendEmail",
    argsJson,
    policyResult: "ask",
    expectation: new McpToolExpectation({
      connectionId: "gmail",
      serverToolName: "Gmail_SendEmail",
      argsJson,
    }),
  });
  using ui = mount("Send Ada last week's invoice.\nCC bookkeeping so the ledger stays honest.", job, { ask: true });
  const dump = ui.dump();
  const confirm = dump.composer.texts.join("\n");
  expect({
    annotation: dump.composer.annotation,
    ask: dump.ask,
    fat: dump.composer.picker.rows.length > 13,
    confirm: {
      recipient: confirm.includes("recipient"),
      ada: confirm.includes("ada@example.com"),
      invoice: confirm.includes("Invoice 1042"),
      items: confirm.includes("Line items"),
      cc: confirm.includes("bookkeeping@here.build"),
      wire: confirm.includes("mcp__gmail"),
    },
  }).toEqual({
    annotation: "Ask · Gmail **send email**",
    ask: [],
    fat: true,
    confirm: {
      recipient: true,
      ada: true,
      invoice: true,
      items: true,
      cc: false,
      wire: false,
    },
  });
  expect(ui).toMatchScreenshot("mcp-gmail-send-ask");
});

test("named agent call — prompt, live, seal", () => {
  const job = reviewerCall();
  using ui = mount(AGENT_PROMPT, job, { model: "Claude Haiku" });

  expect(agentFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "spinner", profile: "tool", rows: "top" },
    role: "foreground",
    annotation: "",
    prompt: true,
    reviewer: true,
    glance: false,
    wire: false,
    ran: false,
    spinner: true,
    model: true,
    response: false,
  });
  expect(ui).toMatchScreenshot("agent-live");

  job.receiptJson = '{"ok":true,"value":"looks good"}';
  job.completed = true;
  expect(agentFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "·" },
    role: "foreground",
    annotation: "",
    prompt: true,
    reviewer: true,
    glance: false,
    wire: false,
    ran: false,
    spinner: false,
    model: true,
    response: false,
  });
  expect(ui).toMatchScreenshot("agent-ok");

  clickExpand(ui, "reviewer");
  expect(agentFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: false,
    gutter: { kind: "top", glyph: "·" },
    role: "foreground",
    annotation: "",
    prompt: true,
    reviewer: true,
    glance: false,
    wire: false,
    ran: false,
    spinner: false,
    model: true,
    response: true,
  });
  expect(ui).toMatchScreenshot("agent-ok-open");
});

test("named agent call — fail", () => {
  const job = reviewerCall({
    outcome: new FailureOutcome({ message: "reviewer unavailable" }),
    completed: true,
  });
  using ui = mount(AGENT_PROMPT, job);
  expect(agentFace(ui)).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "·" },
    role: "error",
    annotation: "",
    prompt: true,
    reviewer: true,
    glance: false,
    wire: false,
    ran: false,
    spinner: false,
    model: false,
    response: false,
  });
  expect(ui).toMatchScreenshot("agent-fail");
});

test("named agent notify is a yield, not a spinner", () => {
  const call = reviewerCall({
    completed: true,
    outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("looks good") }),
  });
  const note = new AgentCallNotification({ message: "diff looks good" });
  call.notifications.push(note);
  using ui = mount(AGENT_PROMPT, call);
  const frame = ui.dump();
  const texts = dumpTexts(frame.transcript);
  expect({
    collapsed: findDisclosure(frame.transcript)?.collapsed ?? null,
    yield: texts.includes("from reviewer: diff looks good"),
    spinner: gutterKind(frame.transcript, "spinner"),
    notifyWire: texts.includes("agent__notify"),
    ran: texts.includes("Ran 1 agent"),
  }).toEqual({
    collapsed: true,
    yield: true,
    spinner: false,
    notifyWire: false,
    ran: false,
  });
  expect(ui).toMatchScreenshot("agent-notify");
});
