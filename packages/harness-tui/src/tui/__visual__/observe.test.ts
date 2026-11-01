import { SessionSystemPrompt, SystemToolJob } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { localClient, openTea, seatTurn } from "./_helpers.js";

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
});

test("read_file ask", () => {
  const job = new SystemToolJob({
    toolCallId: "ra",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    policyResult: "ask",
  });
  using ui = mount("Read src/tea.ts and tell me the exports\nthe composer face actually uses.", job, { ask: true });
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
  expect(ui).toMatchScreenshot("read-file-md");
});
