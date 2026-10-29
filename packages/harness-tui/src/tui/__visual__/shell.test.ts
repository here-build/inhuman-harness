import { reportShellTail, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { formatShellCommandReady } from "@inhuman.tools/harness-sdk/text";
import { bootSyntax } from "@inhuman.tools/quickdraw/widgets";
import { beforeAll, expect, test } from "vitest";

import {
  dumpKinds,
  dumpTexts,
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

  const live = ui.dump();
  const liveCell = findDisclosure(live.transcript);
  expect({
    kinds: dumpKinds(live.transcript),
    collapsed: liveCell?.collapsed ?? null,
    gutter: liveCell?.gutter ?? null,
    timeout: JSON.stringify(liveCell).includes("30000"),
    turnTail: (liveCell?.texts ?? []).some((text) => text.includes("boom")),
  }).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: false,
    gutter: { kind: "spinner", profile: "tool", rows: "top" },
    timeout: false,
    turnTail: true,
  });
  expect(ui).toMatchScreenshot("shell-live");

  leaf.receiptJson = JSON.stringify({
    ok: true,
    value: { exitCode: 0, stdout: STDOUT, stderr: "" },
  });
  leaf.completed = true;
  const okCell = findDisclosure(ui.dump().transcript);
  expect({
    kinds: dumpKinds(ui.dump().transcript),
    collapsed: okCell?.collapsed ?? null,
    gutter: okCell?.gutter ?? null,
    identity: {
      exit: /\bexit\b/.test(identityTexts(okCell)),
      allow: identityTexts(okCell).includes("allow"),
    },
  }).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: true,
    gutter: { kind: "top", glyph: "$" },
    identity: { exit: false, allow: false },
  });
  expect(ui).toMatchScreenshot("shell-ok");

  clickExpand(ui, "git");
  const openTexts = dumpTexts(ui.dump().transcript);
  expect({
    kinds: dumpKinds(ui.dump().transcript),
    collapsed: findDisclosure(ui.dump().transcript)?.collapsed ?? null,
    stdout: openTexts.includes(" M src/tui/tea.ts"),
    extra: openTexts.includes("?? src/tui/work-cells.ts"),
  }).toEqual({
    kinds: ["speech", "disclosure"],
    collapsed: false,
    stdout: true,
    extra: true,
  });
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
  const asked = ui.dump();
  expect({
    kinds: dumpKinds(asked.transcript),
    disclosure: findDisclosure(asked.transcript) === undefined,
    ask: asked.ask,
    annotation: asked.composer.annotation,
    command: asked.composer.texts.join("\n").includes("git status --short"),
    tick: asked.composer.texts.join("\n").includes("run `git status --short`"),
  }).toEqual({
    kinds: ["speech"],
    disclosure: true,
    ask: [],
    annotation: "Ask · run command",
    command: true,
    tick: false,
  });
  expect(ui).toMatchScreenshot("shell-ask");

  leaf.args = {
    command: LONG_COMMAND,
  };
  const long = ui.dump();
  const stacked = long.composer.texts.join("\n");
  expect({
    annotation: long.composer.annotation,
    head: stacked.includes("head -80"),
    readme: stacked.includes("harness-server/README.md"),
    redir: stacked.includes("2> /dev/null"),
    ls: stacked.includes("ls && echo '=== server ==='"),
    glued: stacked.includes("=== server ===';"),
  }).toEqual({
    annotation: "Ask · run command",
    head: true,
    readme: true,
    redir: true,
    ls: true,
    glued: false,
  });
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
  const pair = ui.dump();
  const pairTexts = dumpTexts(pair.transcript);
  expect({
    kinds: dumpKinds(pair.transcript),
    diff: pairTexts.includes("diff"),
    stat: pairTexts.includes("--stat"),
    ran: pairTexts.includes("Ran "),
  }).toEqual({
    kinds: ["speech", "disclosure", "disclosure"],
    diff: true,
    stat: true,
    ran: false,
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
  const cell = findDisclosure(ui.dump().transcript);
  const caption = cell?.texts.join("\n") ?? "";
  expect({
    collapsed: cell?.collapsed ?? null,
    description: caption.includes("Show working tree status"),
    command: caption.includes("git status --short"),
  }).toEqual({ collapsed: true, description: true, command: false });
  expect(ui).toMatchScreenshot("shell-ok-caption");

  clickExpand(ui, "Show working tree status");
  const open = dumpTexts(ui.dump().transcript);
  expect({
    collapsed: findDisclosure(ui.dump().transcript)?.collapsed ?? null,
    command: open.includes("git status --short"),
    description: open.includes("Show working tree status"),
  }).toEqual({ collapsed: false, command: true, description: true });
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
  const open = dumpTexts(ui.dump().transcript);
  expect({
    leftover: open.includes("[31m") || open.includes("\u001b"),
    modified: open.includes(" M src/tui/tea.ts"),
    untracked: open.includes("?? src/tui/work-cells.ts"),
  }).toEqual({ leftover: false, modified: true, untracked: true });
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
  const stacked = ui.dump().composer.texts.join("\n");
  expect(stacked.includes("cat > greet.py")).toBe(true);
  expect(stacked.includes("def greet")).toBe(true);
  expect(stacked.includes("print(f'hi {name}')")).toBe(true);
  expect(stacked.includes("EOF")).toBe(true);
  expect(ui).toMatchScreenshot("shell-embed-py");
});
