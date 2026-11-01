import { reportShellTail, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { formatShellCommandReady } from "@inhuman.tools/harness-sdk/text";
import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { beforeAll, expect, test } from "vitest";

import {
  dumpKinds,
  findDisclosure,
  localClient,
  openTea,
  seatTurn,
  type OpenTea,
  type TranscriptBlock,
} from "./_helpers.js";

const LONG_COMMAND = "ls && echo '=== server ==='; head -80 ./harness-server/README.md 2>/dev/null";

beforeAll(async () => {
  await bootSyntax("dark");
  await Promise.all([
    formatShellCommandReady("git status --short"),
    formatShellCommandReady(LONG_COMMAND),
    formatShellCommandReady("git diff --stat"),
  ]);
});

const PROMPT = "Run git status --short so I can see\nwhat's still dirty in the TUI.";

const STDOUT = [
  " M src/tui/tea.ts",
  " M src/tui/identity.ts",
  "?? src/tui/work-cells.ts",
  "?? packages/harness/src/tui/__visual__/plans/shell-scheme.md",
].join("\n");

function mountTurn(opts: {
  prompt: string;
  doneWork: SessionTurn["doneWork"];
  queue?: SessionTurn["queue"];
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
  return openTea(client);
}

function clickExpand(ui: OpenTea, needle: string): void {
  const { col, row } = ui.hitOf(needle);
  ui.click(col, row);
}

function identityTexts(block: TranscriptBlock | undefined): string {
  const id = block?.children?.find((child) => child.key?.endsWith(":id"));
  return (id?.texts ?? []).join(" ");
}

test("shell tape: prompt → live → seal", () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: JSON.stringify({
      command: "git status --short",
      cwd: "/tmp/p",
      timeoutMs: 30_000,
    }),
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [leaf],
  });
  reportShellTail(leaf, {
    text: "FAIL src/foo.test.ts\nError: boom",
    totalBytes: 40_000,
  });

  expect(ui).toMatchScreenshot("shell-live");

  leaf.receiptJson = JSON.stringify({
    ok: true,
    value: { exitCode: 0, stdout: STDOUT, stderr: "" },
  });
  leaf.completed = true;
  expect(ui).toMatchScreenshot("shell-ok");

  clickExpand(ui, "git");
  expect(ui).toMatchScreenshot("shell-ok-expanded");
});

test("shell ask", async () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: '{"command":"git status --short"}',
    policyResult: "ask",
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [leaf],
  });
  expect(ui).toMatchScreenshot("shell-ask");

  leaf.args = {
    command: LONG_COMMAND,
  };
  expect(ui).toMatchScreenshot("shell-ask-long");
});

test("shell fail", () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: '{"command":"git status --short"}',
    outcomeJson: '{"ok":false,"value":{"exitCode":1,"stdout":"","stderr":"fatal: not a git repository"}}',
    completed: true,
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [leaf],
  });
  const failCell = findDisclosure(ui.dump().transcript);
  expect({
    kinds: dumpKinds(ui.dump().transcript),
    collapsed: failCell?.collapsed ?? null,
    gutter: failCell?.gutter ?? null,
    role: failCell?.role ?? null,
    exit: /\bexit\b/.test(identityTexts(failCell)),
  }).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "$" },
    role: "error",
    exit: false,
  });
  expect(ui).toMatchScreenshot("shell-fail");
});

test("shell pair", () => {
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [
      new SystemToolJob({
        toolCallId: "sh1",
        name: "shell",
        argsJson: '{"command":"git status --short"}',
        outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":" M src/tui/tea.ts\\n","stderr":""}}',
        completed: true,
      }),
      new SystemToolJob({
        toolCallId: "sh2",
        name: "shell",
        argsJson: '{"command":"git diff --stat"}',
        outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":" src/tui/tea.ts | 2 +-\\n","stderr":""}}',
        completed: true,
      }),
    ],
  });
  expect(ui).toMatchScreenshot("shell-pair");
});

test("shell caption: collapsed description, expand command", () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: JSON.stringify({
      command: "git status --short",
      description: "Show working tree status",
    }),
    outcomeJson: JSON.stringify({
      ok: true,
      value: { exitCode: 0, stdout: STDOUT, stderr: "" },
    }),
    completed: true,
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [leaf],
  });
  expect(ui).toMatchScreenshot("shell-ok-caption");

  clickExpand(ui, "Show working tree status");
  expect(ui).toMatchScreenshot("shell-ok-caption-expanded");
});

test("shell color: ANSI stdout is theme ink", () => {
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: '{"command":"git status --short"}',
    outcomeJson: JSON.stringify({
      ok: true,
      value: {
        exitCode: 0,
        stdout: ["\u001b[31m M src/tui/tea.ts\u001b[0m", "\u001b[32m?? src/tui/work-cells.ts\u001b[0m"].join("\n"),
        stderr: "",
      },
    }),
    completed: true,
  });
  using ui = mountTurn({
    prompt: PROMPT,
    doneWork: [leaf],
  });
  clickExpand(ui, "git");
  expect(ui).toMatchScreenshot("shell-ok-color");
});

test("shell command with an embedded language colors the heredoc body", async () => {
  const command = "cat > greet.py << 'EOF'\ndef greet(name):\n    print(f'hi {name}')\nEOF";
  await formatShellCommandReady(command);
  const leaf = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: JSON.stringify({ command }),
    policyResult: "ask",
  });
  using ui = mountTurn({
    prompt: "Write a python greeter to greet.py",
    doneWork: [],
    queue: [leaf],
  });
  // The ask stack renders the whole command, embedded body included.
  expect(ui).toMatchScreenshot("shell-embed-py");
});
