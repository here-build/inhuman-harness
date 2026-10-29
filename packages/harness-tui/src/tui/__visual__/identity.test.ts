import {
  AgentCallJob,
  AgentMessageJob,
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  FileMutateToolJob,
  storedBlobJson,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import {
  agentAskStackedBody,
  agentExpandBlock,
  agentRecipeDescription,
  formatWaitingForAgents,
  formatShellCommandReady,
  captionFromArgs,
  coverAskAnnotation,
  identityLine,
  mutateArgsHaveDiff,
  SCHEME_REPL_NAME,
  shellAskCommand,
  tailEllipsis,
} from "@inhuman.tools/harness-sdk/text";
import { expect, test } from "vitest";

import { parseArgs } from "../parse-args.js";
import { workCellFace } from "../work-cells.js";

test.each([
  {
    name: "read",
    actual: () =>
      identityLine(
        new SystemToolJob({
          toolCallId: "r",
          name: "read_file",
          argsJson: '{"path":"src/tea.ts"}',
        }),
      ),
    line: {
      name: "read_file",
      object: "Read **src/tea.ts**",
      status: "",
      pretty: true,
      block: "",
    },
    exact: true,
  },
  {
    name: "grep",
    actual: () =>
      identityLine(
        new SystemToolJob({
          toolCallId: "g",
          name: "grep",
          argsJson: '{"pattern":"TODO","path":"src"}',
        }),
      ),
    line: {
      name: "grep",
      object: "grep **TODO** in **src**",
      status: "",
      pretty: true,
      block: "",
    },
    exact: true,
  },
  {
    name: "shell",
    actual: () =>
      identityLine(
        new SystemToolJob({
          toolCallId: "s",
          name: "shell",
          argsJson: '{"command":"ls"}',
          outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":"","stderr":""}}',
          completed: true,
        }),
      ),
    line: { name: "shell", object: "ls", status: "" },
    exact: true,
  },
  {
    name: "edit",
    actual: () =>
      identityLine(
        new SystemToolJob({
          toolCallId: "e",
          name: "edit_file",
          argsJson: JSON.stringify({
            path: "a.ts",
            old_string: "a\nb\nc",
            new_string: "a\nb\nc\nd",
          }),
        }),
      ),
    line: {
      name: "edit_file",
      object: "a.ts",
      status: "",
    },
    exact: true,
  },
  {
    name: "agent send",
    actual: () =>
      identityLine(
        new AgentCallJob({
          toolCallId: "a",
          name: "agent__send",
          argsJson: '{"spec":"reviewer","message":"check the diff"}',
        }),
      ),
    line: {
      name: "reviewer",
      object: "",
      status: "",
      agent: true,
      block: "check the diff",
    },
    exact: true,
  },
  {
    name: "agent anon",
    actual: () =>
      identityLine(
        new AgentCallJob({
          toolCallId: "anon",
          name: "agent__ask",
          argsJson: '{"message":"classify this"}',
        }),
      ),
    line: {
      name: "agent",
      object: "",
      status: "",
      agent: true,
      block: "classify this",
    },
    exact: true,
  },
  {
    name: "mcp",
    actual: () =>
      identityLine(
        new MCPToolJob({
          toolCallId: "m",
          name: "mcp__gmail__Gmail_GetEmail",
          connectionKey: "gmail",
          serverToolName: "Gmail_GetEmail",
          argsJson: '{"email_id":"18c2a1b0f3e4d5c6"}',
          expectation: new McpToolExpectation({
            connectionId: "gmail",
            serverToolName: "Gmail_GetEmail",
            argsJson: '{"email_id":"18c2a1b0f3e4d5c6"}',
          }),
        }),
      ),
    line: { name: "Gmail", object: "get email", status: "" },
    exact: true,
  },
  {
    name: "agent cover",
    actual: () =>
      workCellFace(
        new AgentCallJob({
          toolCallId: "a",
          name: "agent__ask",
          argsJson: '{"spec":"reviewer","message":"check the diff"}',
        }),
        "a",
        false,
        true,
        "Reviewing the diff",
      ),
    line: {
      name: "reviewer",
      object: "Reviewing the diff",
      agent: true,
      prettyBlock: "check the diff",
    },
    exact: false,
  },
  {
    name: "agent glance",
    actual: () =>
      workCellFace(
        new AgentCallJob({
          toolCallId: "a",
          name: "agent__ask",
          argsJson: '{"spec":"explore","message":"map the tui"}',
        }),
        "a",
        false,
        false,
        { status: "active", model: "Claude Haiku" },
      ),
    line: {
      name: "explore",
      object: "active",
      agent: true,
      prettyBlock: "map the tui\nClaude Haiku",
    },
    exact: false,
  },
])("identityLine names the object, never a file count ($name)", ({ actual, line, exact }) => {
  if (exact) expect(actual()).toEqual(line);
  else expect(actual()).toMatchObject(line);
});

test("shell cwd token is the object status", () => {
  expect(
    Object.fromEntries(
      (
        [
          ["omitted", { command: "ls" }],
          ["dot", { command: "ls", cwd: "." }],
          ["scripts", { command: "ls", cwd: "scripts" }],
          ["dotScripts", { command: "ls", cwd: "./scripts" }],
          ["parent", { command: "ls", cwd: "../bin" }],
          ["abs", { command: "ls", cwd: "/etc" }],
        ] as const
      ).map(([key, args]) => [
        key,
        identityLine(
          new SystemToolJob({
            toolCallId: key,
            name: "shell",
            argsJson: JSON.stringify(args),
            outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":"","stderr":""}}',
            completed: true,
          }),
        ).status,
      ]),
    ),
  ).toEqual({
    omitted: "",
    dot: "",
    scripts: "./scripts",
    dotScripts: "./scripts",
    parent: "../bin",
    abs: "/etc",
  });
});

test("identityLine treats a null replica name as empty", () => {
  const work = new SystemToolJob({
    toolCallId: "boot",
    name: "read_file",
    argsJson: '{"path":"a.ts"}',
  });
  (work as { name: string | null }).name = null;
  expect({
    line: identityLine(work),
    face: workCellFace(work, "boot", false, true),
  }).toMatchObject({
    line: { name: "", object: "a.ts" },
    face: { name: "", object: "a.ts" },
  });
});

test("glob and fff_search keep an optional cwd; path is the ingest alias", () => {
  expect({
    cwd: identityLine(
      new SystemToolJob({
        toolCallId: "g",
        name: "glob",
        argsJson: '{"pattern":"*.ts","cwd":"src"}',
      }),
    ).object,
    path: identityLine(
      new SystemToolJob({
        toolCallId: "g2",
        name: "glob",
        argsJson: '{"pattern":"*.ts","path":"src"}',
      }),
    ).object,
    search: identityLine(
      new SystemToolJob({
        toolCallId: "f",
        name: "fff_search",
        argsJson: '{"query":"Tea"}',
      }),
    ).object,
  }).toEqual({
    cwd: "glob `*.ts` in **src**",
    path: "glob `*.ts` in **src**",
    search: "search **Tea**",
  });
});

test("unparsable args fall back to invocation / truncated JSON and keep the name", () => {
  const job = new SystemToolJob({
    toolCallId: "x",
    name: "read_file",
    argsJson: "not-json",
  });
  expect({
    line: identityLine(job),
    parsed: parseArgs("not-json"),
  }).toEqual({
    line: { name: "read_file", object: "not-json", status: "" },
    parsed: null,
  });
});

test.each([
  [null, undefined],
  [{ command: "ls" }, undefined],
  [{ description: "" }, undefined],
  [{ description: "  \n\t " }, undefined],
  [{ description: 1 }, undefined],
  [{ description: "Show working\ntree   status" }, "Show working tree status"],
  [{ description: "x".repeat(81) }, `${"x".repeat(79)}…`],
] as const)("captionFromArgs %#", (args, out) => {
  expect(captionFromArgs(args as Record<string, unknown> | null)).toBe(out);
});

test("shell identity and ask stack use the shfmt reprint", async () => {
  const command = "if true;then echo x; echo y;fi";
  const formatted = await formatShellCommandReady(command);
  const job = new SystemToolJob({
    toolCallId: "s",
    name: "shell",
    argsJson: JSON.stringify({ command }),
  });
  expect({
    object: identityLine(job).object,
    ask: shellAskCommand(job),
    other: shellAskCommand(new SystemToolJob({ toolCallId: "x", name: "read_file", argsJson: "{}" })),
  }).toEqual({
    object: formatted,
    ask: formatted,
    other: undefined,
  });
});

test("shell keeps the script as object with an optional caption; scheme summary is the description", () => {
  expect({
    shell: identityLine(
      new SystemToolJob({
        toolCallId: "s",
        name: "shell",
        argsJson: JSON.stringify({ command: "git status --short", description: "Show working tree status" }),
      }),
    ),
    scheme: identityLine(
      new ProgrammaticJob({
        toolCallId: "p",
        argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "Add one and two" }),
      }),
    ),
    // Pre-`description` sessions: no caption, so the compact row is the program.
    defaultScheme: identityLine(
      new ProgrammaticJob({ toolCallId: "default", argsJson: JSON.stringify({ expr: "(+ 1 2)" }) }),
    ),
    plain: identityLine(
      new SystemToolJob({
        toolCallId: "plain",
        name: "shell",
        argsJson: '{"command":"ls"}',
      }),
    ).caption,
    write: identityLine(
      new SystemToolJob({
        toolCallId: "w",
        name: "write_file",
        argsJson: JSON.stringify({ path: "a.ts", content: "x", description: "Add a greeting" }),
      }),
    ),
    edit: identityLine(
      new SystemToolJob({
        toolCallId: "e",
        name: "edit_file",
        argsJson: JSON.stringify({
          path: "a.ts",
          old_string: "a",
          new_string: "b",
          description: "Rename the export",
        }),
      }),
    ),
  }).toMatchObject({
    shell: {
      name: "shell",
      object: "git status --short",
      status: "",
      caption: "Show working tree status",
    },
    scheme: {
      name: SCHEME_REPL_NAME,
      object: "{1 + 2}",
      caption: "Add one and two",
    },
    defaultScheme: { name: SCHEME_REPL_NAME, object: "{1 + 2}" },
    plain: undefined,
    write: { object: "a.ts", caption: "Add a greeting" },
    edit: { object: "a.ts", caption: "Rename the export", status: "" },
  });
});

test("scheme outer uses sugarcoat of the expr, not the eval telegram", () => {
  const read = identityLine(
    new ProgrammaticJob({
      toolCallId: "s",
      argsJson: '{"expr":"(read_file :path \\"a.ts\\")"}',
    }),
  );
  const plus = identityLine(
    new ProgrammaticJob({
      toolCallId: "p",
      argsJson: '{"expr":"(+ 1 2)"}',
    }),
  );
  const wrapped = identityLine(
    new ProgrammaticJob({
      toolCallId: "w",
      argsJson: JSON.stringify({ expr: '(begin (read_file "a.ts") (+ 1 2))' }),
    }),
  );
  const listed = identityLine(
    new ProgrammaticJob({
      toolCallId: "l",
      argsJson: JSON.stringify({ expr: '(list (read_file "a.ts") (+ 1 2))' }),
    }),
  );
  const vector = identityLine(
    new ProgrammaticJob({
      toolCallId: "v",
      argsJson: JSON.stringify({ expr: '[(read_file "a.ts") (+ 1 2)]' }),
    }),
  );
  expect({
    name: read.name,
    read: read.object,
    plus: plus.object,
    pretty: read.pretty,
    wrapped: wrapped.object,
    listed: listed.object,
    vector: vector.object,
  }).toEqual({
    name: SCHEME_REPL_NAME,
    read: '(read_file :path "a.ts")',
    plus: "{1 + 2}",
    pretty: undefined,
    wrapped: '(read_file "a.ts")\n\n{1 + 2}',
    listed: '(read_file "a.ts")\n\n{1 + 2}',
    vector: '(read_file "a.ts")\n\n{1 + 2}',
  });
});

test.each([
  {
    name: "list_dir empty",
    actual: () =>
      identityLine(
        new SystemToolJob({
          toolCallId: "l",
          name: "list_dir",
          argsJson: "{}",
        }),
      ).object,
    line: ".",
    negate: true,
  },
  {
    name: "write new",
    actual: () =>
      identityLine(
        new SystemToolJob({ toolCallId: "n", name: "write_file", argsJson: '{"path":"a.ts","content":"x"}' }),
      ),
    line: { name: "write_file", object: "a.ts", status: "" },
    negate: false,
  },
  {
    name: "write existed",
    actual: () =>
      identityLine(
        new FileMutateToolJob({
          toolCallId: "c",
          name: "write_file",
          argsJson: '{"path":"a.ts","content":"x"}',
          existed: true,
          completed: true,
          outcomeJson: '{"ok":true,"text":"created a.ts (1 bytes)"}',
        }),
      ),
    line: { name: "write_file", object: "a.ts", status: "" },
    negate: false,
  },
])("telegram regressions: $name", ({ actual, line, negate }) => {
  if (negate) expect(actual()).not.toBe(line);
  else expect(actual()).toEqual(line);
});

test.each([
  {
    name: "edit diff",
    job: () =>
      new SystemToolJob({
        toolCallId: "e",
        name: "edit_file",
        argsJson: '{"path":"a.ts","old_string":"a","new_string":"b"}',
      }),
    have: true,
  },
  {
    name: "edit empty",
    job: () => new SystemToolJob({ toolCallId: "empty", name: "edit_file", argsJson: '{"path":"a.ts"}' }),
    have: false,
  },
  {
    name: "write create",
    job: () => new SystemToolJob({ toolCallId: "c", name: "write_file", argsJson: '{"path":"a.ts","content":"x"}' }),
    have: true,
  },
  {
    name: "write overwrite unstamped",
    job: () =>
      new FileMutateToolJob({
        toolCallId: "ow",
        name: "write_file",
        argsJson: '{"path":"a.ts","content":"x"}',
        existed: true,
      }),
    have: false,
  },
  {
    name: "write overwrite prior",
    job: () =>
      new FileMutateToolJob({
        toolCallId: "prior",
        name: "write_file",
        argsJson: '{"path":"a.ts","content":"x"}',
        existed: true,
        priorContent: "old",
      }),
    have: true,
  },
  {
    name: "write overwrite prior in a blob",
    job: () =>
      new FileMutateToolJob({
        toolCallId: "blob",
        name: "write_file",
        argsJson: '{"path":"a.ts","content":"x"}',
        existed: true,
        priorBlobJson: storedBlobJson({ sha256: "f".repeat(64), bytes: 9000, mime: "text/plain", head: "old" }),
      }),
    have: true,
  },
  {
    name: "write overwrite with a corrupt blob reference",
    job: () =>
      new FileMutateToolJob({
        toolCallId: "corrupt",
        name: "write_file",
        argsJson: '{"path":"a.ts","content":"x"}',
        existed: true,
        priorBlobJson: "{not json",
      }),
    have: false,
  },
])("mutateArgsHaveDiff $name", ({ job, have }) => {
  expect(mutateArgsHaveDiff(job())).toBe(have);
});

test("tailEllipsis keeps the filename", () => {
  expect({
    short: tailEllipsis("src/tui/tea.ts", 80),
    long: tailEllipsis("very/long/prefix/tea.ts", 10),
  }).toEqual({
    short: "src/tui/tea.ts",
    long: "…/tea.ts",
  });
});

test("agent cover stacks spec blurb above the prompt; user recipes win", () => {
  expect({
    stdlib: agentRecipeDescription({}, "explore"),
    custom: agentRecipeDescription({ explore: { description: "custom glance" } }, "explore"),
    stacked: agentAskStackedBody(
      "Map how the cover names agent send and agent call.\nCite file:line. Do not write.",
      "thorough read-only repo investigation",
    ),
    expandModel: agentExpandBlock("check the diff", "Claude Haiku"),
    expandPlain: agentExpandBlock("check the diff", ""),
  }).toEqual({
    stdlib: "thorough read-only repo investigation",
    custom: "custom glance",
    stacked:
      "thorough read-only repo investigation\n\nMap how the cover names agent send and agent call.\nCite file:line. Do not write.",
    expandModel: "check the diff\nClaude Haiku",
    expandPlain: "check the diff",
  });
});

test.each([
  {
    name: "edit",
    job: () =>
      new SystemToolJob({
        toolCallId: "e",
        name: "edit_file",
        argsJson: '{"path":"src/a.ts"}',
      }),
    annotation: "edit **a.ts**",
  },
  {
    name: "create",
    job: () =>
      new SystemToolJob({
        toolCallId: "w",
        name: "write_file",
        argsJson: '{"path":"src/hello.ts","content":"hi"}',
      }),
    annotation: "create **src/hello.ts**",
  },
  {
    name: "update",
    job: () =>
      new FileMutateToolJob({
        toolCallId: "w-up",
        name: "write_file",
        argsJson: '{"path":"src/hello.ts","content":"hi"}',
        existed: true,
      }),
    annotation: "update **src/hello.ts**",
  },
  {
    name: "read",
    job: () =>
      new SystemToolJob({
        toolCallId: "r",
        name: "read_file",
        argsJson: '{"path":"src/tea.ts"}',
      }),
    annotation: "Read **src/tea.ts**",
  },
  {
    name: "list",
    job: () =>
      new SystemToolJob({
        toolCallId: "l",
        name: "list_dir",
        argsJson: '{"path":"packages/harness/src/tui"}',
      }),
    annotation: "list **packages/harness/src/tui**",
  },
  {
    name: "grep",
    job: () =>
      new SystemToolJob({
        toolCallId: "g",
        name: "grep",
        argsJson: '{"pattern":"TODO","path":"src"}',
      }),
    annotation: "grep **TODO** in **src**",
  },
  {
    name: "glob",
    job: () =>
      new SystemToolJob({
        toolCallId: "o",
        name: "glob",
        argsJson: '{"pattern":"**/*.test.ts"}',
      }),
    annotation: "glob `**/*.test.ts`",
  },
  {
    name: "glob cwd",
    job: () =>
      new SystemToolJob({
        toolCallId: "o2",
        name: "glob",
        argsJson: '{"pattern":"**/README.md","cwd":"packages/harness"}',
      }),
    annotation: "glob `**/README.md` in **packages/harness**",
  },
  {
    name: "search",
    job: () =>
      new SystemToolJob({
        toolCallId: "f",
        name: "fff_search",
        argsJson: '{"query":"tea tui"}',
      }),
    annotation: "search **tea tui**",
  },
  {
    name: "shell",
    job: () =>
      new SystemToolJob({
        toolCallId: "s",
        name: "shell",
        argsJson: '{"command":"ls"}',
      }),
    annotation: "run command",
  },
  {
    name: "shell from explore",
    job: () =>
      new SystemToolJob({
        toolCallId: "s-explore",
        name: "shell",
        argsJson: '{"command":"ls"}',
      }),
    ctx: { agentSpec: "explore" },
    annotation: "**Explore agent** · run command",
  },
  {
    name: "edit from explore",
    job: () =>
      new SystemToolJob({
        toolCallId: "e-explore",
        name: "edit_file",
        argsJson: '{"path":"src/a.ts"}',
      }),
    ctx: { agentSpec: "explore" },
    annotation: "**Explore agent** · edit **a.ts**",
  },
  {
    name: "shell from anonymous agent",
    job: () =>
      new SystemToolJob({
        toolCallId: "s-anon",
        name: "shell",
        argsJson: '{"command":"ls"}',
      }),
    ctx: { agentSpec: "" },
    annotation: "**agent** · run command",
  },
  {
    name: "shell cwd",
    job: () =>
      new SystemToolJob({
        toolCallId: "s-cwd",
        name: "shell",
        argsJson: '{"command":"ls","cwd":"/etc"}',
      }),
    annotation: "run command  /etc",
  },
  {
    name: "mcp get",
    job: () =>
      new MCPToolJob({
        toolCallId: "m",
        name: "mcp__gmail__Gmail_GetEmail",
        connectionKey: "gmail",
        serverToolName: "Gmail_GetEmail",
        argsJson: '{"email_id":"18c2"}',
        expectation: new McpToolExpectation({
          connectionId: "gmail",
          serverToolName: "Gmail_GetEmail",
          argsJson: '{"email_id":"18c2"}',
        }),
      }),
    annotation: "Gmail **get email**",
  },
  {
    name: "mcp arcade",
    job: () =>
      new MCPToolJob({
        toolCallId: "a",
        name: "mcp__gmail__Arcade_ListApps",
        connectionKey: "gmail",
        serverToolName: "Arcade_ListApps",
        argsJson: "{}",
        expectation: new McpToolExpectation({
          connectionId: "gmail",
          serverToolName: "Arcade_ListApps",
          argsJson: "{}",
        }),
      }),
    annotation: "Gmail **arcade list apps**",
  },
  {
    name: "reviewer ask",
    job: () =>
      new AgentCallJob({
        toolCallId: "a",
        name: "agent__ask",
        argsJson: '{"spec":"reviewer","message":"check the diff"}',
      }),
    annotation: "ask **Reviewer agent**",
  },
  {
    name: "explore ask",
    job: () =>
      new AgentCallJob({
        toolCallId: "a",
        name: "agent__ask",
        argsJson: '{"spec":"explore","message":"map the tui"}',
      }),
    ctx: { model: "Claude Haiku", agentSpec: "explore" },
    annotation: "ask **Claude Haiku Explore agent**",
  },
  {
    name: "reviewer send",
    job: () =>
      new AgentCallJob({
        toolCallId: "s",
        name: "agent__send",
        argsJson: '{"spec":"reviewer","message":"check the diff"}',
      }),
    ctx: { model: "Claude Haiku" },
    annotation: "send **Claude Haiku Reviewer agent**",
  },
  {
    name: "anon ask",
    job: () =>
      new AgentCallJob({
        toolCallId: "anon",
        name: "agent__ask",
        argsJson: '{"message":"classify this"}',
      }),
    ctx: { model: "Claude Haiku" },
    annotation: "ask **Claude Haiku agent**",
  },
  {
    name: "agent message",
    job: () =>
      new AgentMessageJob({
        toolCallId: "m",
        name: "agent__message",
        argsJson: '{"targetName":"echo","message":"aside"}',
      }),
    ctx: { model: "Claude Haiku" },
    annotation: "message **Echo agent**",
  },
])("cover rim names $name", ({ job, ctx, annotation }) => {
  expect(coverAskAnnotation(job(), ctx)).toBe(annotation);
});

test("waiting-for-agents list uses Oxford comma and a single noun", () => {
  expect({
    one: formatWaitingForAgents(["explore"]),
    two: formatWaitingForAgents(["explore", "reviewer"]),
    three: formatWaitingForAgents(["explore", "qa", "reviewer"]),
    dup: formatWaitingForAgents(["explore", "explore"]),
    anon: formatWaitingForAgents(["agent"]),
  }).toEqual({
    one: "waiting for Explore agent",
    two: "waiting for Explore and Reviewer agents",
    three: "waiting for Explore, QA, and Reviewer agents",
    dup: "waiting for Explore and Explore agents",
    anon: "waiting for an agent",
  });
});
