import { SessionSystemPrompt, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { dumpTexts, findDisclosure, localClient, normalizeDump, openTea, seatTurn, type OpenTea } from "./_helpers.js";

function mount(prompt: string, leaf: SystemToolJob, opts?: { ask?: boolean }) {
  const client = localClient();
  if (opts?.ask === true) {
    client.kernelRoot.approvalAskThrottleMs = 0;
    client.sessionRoot.permissionMode = "manual";
  }
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt,
    permissionMode: opts?.ask === true ? "manual" : undefined,
    doneWork: [leaf],
    queue: [],
  });
  turn.pushChild(leaf);
  client.sessionRoot.head = turn;
  return openTea(client);
}

function observeFace(ui: OpenTea) {
  const frame = ui.dump();
  const texts = dumpTexts(frame.transcript);
  const cell = findDisclosure(frame.transcript);
  return {
    collapsed: cell?.collapsed ?? null,
    kinds: frame.transcript.filter((block) => block.band !== "gap").map((block) => block.type ?? "unknown"),
    annotation: frame.composer.annotation,
    ask: frame.ask,
    identity: texts.includes("Read **src/tea.ts**") || texts.includes("Read **README.md**"),
    path: texts.includes("src/tea.ts") || texts.includes("README.md"),
    body: texts.includes("export function openTea") || texts.includes("# Harness"),
  };
}

test("read_file", () => {
  const job = new SystemToolJob({
    toolCallId: "r",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
  });
  using ui = mount("Read src/tea.ts and tell me the exports\nthe composer face actually uses.", job);
  expect(ui).toMatchScreenshot("read-file-live");
  job.receiptJson = '{"ok":true,"text":"export function openTea() {}\\nexport class Tea {}"}';
  job.completed = true;
  expect(ui).toMatchScreenshot("read-file-ok");
  expect(observeFace(ui)).toEqual({
    collapsed: null,
    kinds: ["box", "box"],
    annotation: "",
    ask: [],
    identity: true,
    path: true,
    body: false,
  });
});

test("read_file ask", () => {
  const job = new SystemToolJob({
    toolCallId: "ra",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    policyResult: "ask",
  });
  using ui = mount("Read src/tea.ts and tell me the exports\nthe composer face actually uses.", job, { ask: true });
  const frame = ui.dump();
  expect({
    ...normalizeDump(frame),
    ask: frame.ask,
    wire: dumpTexts(frame.transcript).includes("read_file"),
  }).toEqual({
    kinds: ["speech"],
    collapsed: null,
    gutter: null,
    role: null,
    annotation: "Ask · Read **src/tea.ts**",
    ask: [],
    wire: false,
  });
  expect(ui).toMatchScreenshot("read-file-ask");
});

test("grep ask", () => {
  const job = new SystemToolJob({
    toolCallId: "ga",
    name: "grep",
    argsJson: '{"pattern":"TODO","path":"packages/harness/src"}',
    policyResult: "ask",
  });
  using ui = mount("Grep for TODO in packages/harness/src\nand show the matching lines.", job, { ask: true });
  const frame = ui.dump();
  expect({
    ...normalizeDump(frame),
    ask: frame.ask,
    wire: dumpTexts(frame.transcript).includes("grep  TODO"),
  }).toEqual({
    kinds: ["speech"],
    collapsed: null,
    gutter: null,
    role: null,
    annotation: "Ask · grep **TODO** in **packages/harness/src**",
    ask: [],
    wire: false,
  });
  expect(ui).toMatchScreenshot("grep-ask");
});

test("read_file fail", () => {
  const job = new SystemToolJob({
    toolCallId: "rf",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
  });
  using ui = mount("Read src/tea.ts and tell me the exports\nthe composer face actually uses.", job);
  job.receiptJson = '{"ok":false,"text":"no such path under the project root: src/tea.ts"}';
  job.completed = true;
  expect(ui).toMatchScreenshot("read-file-fail");
});

test("read_file markdown", () => {
  const job = new SystemToolJob({
    toolCallId: "rm",
    name: "read_file",
    argsJson: '{"path":"README.md"}',
    outcomeJson: '{"ok":true,"text":"# Harness\\nTea is the TUI."}',
    completed: true,
  });
  using ui = mount("Read README.md and summarize\nwhat Tea is supposed to be.", job);
  expect(observeFace(ui)).toEqual({
    collapsed: null,
    kinds: ["box", "box"],
    annotation: "",
    ask: [],
    identity: true,
    path: true,
    body: false,
  });
  expect(ui).toMatchScreenshot("read-file-md");
});
