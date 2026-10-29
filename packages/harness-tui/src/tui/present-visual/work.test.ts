import { ProgrammaticJob, SessionSystemPrompt, SystemToolJob, type SessionTurn } from "@inhuman.tools/harness-model";
import { test } from "vitest";

import { approve } from "./approve.js";
import { localClient, openTea, seatTurn } from "../__visual__/_helpers.js";

const SHELL_PROMPT = "Run git status --short so I can see\nwhat's still dirty in the TUI.";
const SCHEME_PROMPT = 'Eval (read_file "src/tea.ts")\nand show me the bindings it returns.';
const EDIT_PROMPT = "Replace the greeting in src/hello.ts.\nKeep the export name.";

const editArgs = {
  path: "src/hello.ts",
  old_string: 'export function greet() {\n  return "hello";\n}',
  new_string: 'export function greet() {\n  return "hi, world";\n}',
};

function mountTurn(prompt: string, doneWork: SessionTurn["doneWork"]) {
  const client = localClient();
  const turn = seatTurn({
    turnTail: new SessionSystemPrompt(),
    prompt,
    doneWork,
    queue: [],
  });
  client.sessionRoot.head = turn;
  client.kernelRoot.approvalAskThrottleMs = 0;
  return openTea(client);
}

test("shell-ok", async () => {
  using ui = mountTurn(SHELL_PROMPT, [
    new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: JSON.stringify({ command: "echo hi" }),
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout: "hi", stderr: "" } }),
      completed: true,
    }),
  ]);
  await approve("shell-ok", ui.tea);
});

test("scheme-ok", async () => {
  const inner = new SystemToolJob({
    toolCallId: "call_inner",
    name: "read_file",
    argsJson: '{"path":"src/tea.ts"}',
    outcomeJson: '{"ok":true,"text":"export const Tea"}',
    completed: true,
  });
  const outer = new ProgrammaticJob({
    toolCallId: "call_repl",
    argsJson: JSON.stringify({ expr: '(read_file "src/tea.ts")' }),
    outcomeJson: '{"ok":true,"value":"export const Tea"}',
    completed: true,
  });
  outer.pushInvocation(inner);
  using ui = mountTurn(SCHEME_PROMPT, [outer]);
  await approve("scheme-ok", ui.tea);
});

test("edit-ok", async () => {
  using ui = mountTurn(EDIT_PROMPT, [
    new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify(editArgs),
      outcomeJson: '{"ok":true}',
      completed: true,
    }),
  ]);
  await approve("edit-ok", ui.tea);
});
