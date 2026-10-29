/**
 * The sessions the stories open. Each is built from the same jobs a real
 * turn holds, so the tape projects it exactly as it projects a live room.
 */
import type { SessionPlexus } from "@inhuman.tools/harness-peer";

import { runWorkflow, WORKFLOWS, WorkflowClock, type WorkflowRun } from "./workflow-world.js";
import {
  agent,
  asking,
  edit,
  glob,
  goal,
  grep,
  listDir,
  read,
  scheme,
  session,
  settled,
  shell,
  speech,
  task,
  title,
  tool,
  write,
  type GlanceRow,
  type TurnSpec,
} from "./world.js";

const TAPE_READ = `import { ToolCallJob } from "@inhuman.tools/harness-model";

/** Consecutive reads collapse. A shell or other tool splits the run. */
export function foldReads(cells: readonly TapeCell[]): TapeCell[] {
  const folded: TapeCell[] = [];
  return folded;
}
`;

const ANSWER = `The left lane now carries **task and goal progress** beside the round's title.

## What changed

- \`task__create\` adds a line with its description underneath.
- \`task__start\`, \`task__drop\` and \`task__validate\` reuse the subject from the create.
- A goal reads as *Goal* and its objective.

1. Titles stay at the top of the note.
2. Items stack under them in call order.

> A title-only round is unchanged.

| Call | Line |
| --- | --- |
| \`task__start\` | in progress |
| \`goal__clear\` | cleared |

\`\`\`ts
export function progressItem(job: ToolCallJob): ProgressItem | null {
  if (TASK_TOOLS.has(job.name)) return taskItem(job);
  return GOAL_TOOLS.has(job.name) ? goalItem(job) : null;
}
\`\`\`

- [x] Render the items
- [ ] Narrow-screen alignment

See [the tape notes](https://example.com/tape) for the lane rules.`;

const VITEST = [
  "\u001b[1m\u001b[46m RUN \u001b[49m\u001b[22m \u001b[36mv4.1.0 \u001b[39m\u001b[90m/work/harness-web-app\u001b[39m",
  "",
  " \u001b[32m✓\u001b[39m src/shell/__tests__/tape.test.ts \u001b[2m(31 tests)\u001b[22m\u001b[32m 48\u001b[2mms\u001b[22m\u001b[39m",
  " \u001b[31m×\u001b[39m src/shell/__tests__/tape-read.test.ts \u001b[2m(12 tests | 1 failed)\u001b[22m",
  "",
  "\u001b[41m\u001b[30m FAIL \u001b[39m\u001b[49m src/shell/__tests__/tape-read.test.ts > folds reads",
  "\u001b[31mAssertionError: expected [ 'reads' ] to deeply equal [ 'reads', 'tool' ]\u001b[39m",
  "",
  " \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m24 passed\u001b[39m\u001b[22m",
  "",
].join("\n");

/** The full surface in one sitting: titles, reads, tools, a diff, shell, reasoning, and a model switch. Fresh jobs per call: a job binds to one document. */
export const conversationTurns = (): readonly TurnSpec[] => [
  {
    prompt:
      "let's integrate the task and goal tool calls into the left bar, the way title and description updates already render there",
    work: [
      title(
        "Left-bar task and goal progress",
        "Find how titles render in the left bar, then place task and goal progress there.",
      ),
      speech("I'll look at how the left bar renders title updates, then put task and goal progress in the same spot.", {
        thought:
          "The left lane already holds the progress note. The question is whether task calls should join the same note or stand alone.",
      }),
      listDir("packages/harness-web-app/src/shell", ["tape.tsx", "tape-read.ts", "tape-beats.ts", "frame.tsx"]),
      read("packages/harness-web-app/src/shell/tape-read.ts", TAPE_READ),
      grep(
        "update_metadata",
        ["src/shell/tape-read.ts:218: if (job.name !== UPDATE_METADATA_TOOL_NAME) return null;"],
        {
          path: "packages/harness-web-app",
        },
      ),
      glob("plugins/**/*task*", ["plugins/inhuman-plugin-tasks/behavior/tools.scm"]),
      speech("Title updates already become a progress mark. I'll add task and goal lines under it.", {
        thought: "A later start or drop only carries the id, so the subject has to come from the round's create.",
      }),
      task("create", "lane", { subject: "Left bar", description: "Show task progress beside the title" }),
      task("start", "lane"),
      goal("Keep the left pane current"),
      edit(
        "packages/harness-web-app/src/shell/tape-read.ts",
        TAPE_READ,
        "  const folded: TapeCell[] = [];\n  return folded;",
        "  const folded: TapeCell[] = [];\n  const subjects = new Map<string, string>();\n  for (const cell of cells) folded.push(cell);\n  return folded;",
      ),
      shell("pnpm exec vitest run src/shell/__tests__", VITEST, { exitCode: 1, cwd: "packages/harness-web-app" }),
      speech("One fold test expected the old split. I'll update it and rerun.", {
        model: "grok-4.7",
        connection: "grok",
        thought: "The failing test asserts that grep splits a read run; under the new rule it folds.",
      }),
      shell("pnpm exec vitest run src/shell/__tests__", "\u001b[32m✓\u001b[39m 25 files, 203 tests\n", {
        cwd: "packages/harness-web-app",
      }),
      speech(ANSWER, { model: "grok-4.7", connection: "grok" }),
    ],
  },
  {
    prompt: "now check it on a narrow page",
    work: [
      speech("On a narrow page the note sits above its round and aligns left; nothing else moves.", {
        model: "grok-4.7",
        connection: "grok",
      }),
    ],
  },
];

export const conversation = () =>
  session({ id: "conversation", turns: conversationTurns(), kvs: { connection: "grok", model: "grok-4.7" } });

/** Every look the read family makes, with a failure and a call still running. */
export const looks = () =>
  session({
    id: "looks",
    turns: [
      {
        prompt: "find where the sidebar is drawn",
        work: [
          speech("Searching the shell for the sidebar."),
          glob("**/*sidebar*", ["src/shell/file-sidebar.tsx"]),
          glob("**/*left*", []),
          tool(
            "grep",
            { pattern: "update_metadata", mode: "files" },
            { failed: true, result: 'grep: "mode" must be plain, regex, or fuzzy, got files' },
          ),
          grep("current_turn_title", ["src/shell/tape-read.ts:220: typeof args.current_turn_title"]),
          listDir(".", ["packages/", "plugins/", "docs/", "package.json"]),
          read("README.md", "# Harness\n\nAn agent harness."),
          read("assets/logo.png", ""),
          speech("Two reads are still out."),
          read("packages/harness-web-app/src/shell/frame.tsx", "", { live: true }),
          tool("list_dir", { path: "docs" }, { live: true }),
        ],
        live: true,
      },
    ],
  });

/** Tool rows: a run that groups, failures, a live call, and the bodies a receipt can hold. */
export const tools = () =>
  session({
    id: "tools",
    turns: [
      {
        prompt: "check the web tools",
        work: [
          speech("Running the web tools."),
          tool(
            "web_search",
            { query: "oklch contrast wcag" },
            { result: "**OKLCH and WCAG**: perceptual lightness does not equal luminance." },
          ),
          tool(
            "web_fetch",
            { url: "https://www.w3.org/TR/WCAG22/" },
            { result: "Success Criterion 1.4.3 Contrast (Minimum)…" },
          ),
          tool(
            "mcp__github__issue_read",
            { number: 42 },
            { failed: true, result: "403: Resource not accessible by integration" },
          ),
          speech("A single row stands alone."),
          tool("agent__ask", { agent: "explore", prompt: "map the tape" }, { live: true }),
        ],
        live: true,
      },
    ],
  });

export const STYLES = `.composer-pill {
  border: 1px solid var(--line);
  border-radius: 4px;
}
`;

/** File changes: an edit with context, a new file, an overwrite, and a write that failed. */
export const diffs = () =>
  session({
    id: "diffs",
    turns: [
      {
        prompt: "make the composer the strongest outline",
        work: [
          speech("Editing the composer edge."),
          edit(
            "src/styles.css",
            STYLES,
            "  border: 1px solid var(--line);\n  border-radius: 4px;",
            "  border: 1px solid var(--edge);\n  border-radius: var(--radius-md);",
          ),
          write("src/__tests__/contrast.test.ts", 'import { it } from "vitest";\n\nit("holds AA", () => {});\n'),
          write("src/notes.md", "# Notes\n\nShort.\n", { prior: "# Notes\n\nA longer draft that is gone now.\n" }),
          write("src/locked.ts", "export {};\n", { failed: "EACCES: permission denied, open 'src/locked.ts'" }),
        ],
      },
    ],
  });

/** Terminals: success with color, a failure, a working directory, a heredoc script, and one still printing. */
export const terminals = () =>
  session({
    id: "terminals",
    turns: [
      {
        prompt: "run the checks",
        work: [
          shell("git status --short", " M src/styles.css\n?? src/__stories__/\n"),
          shell("pnpm exec vitest run", VITEST, { exitCode: 1, cwd: "packages/harness-web-app" }),
          shell("python3 - <<'EOF'\nprint('tokens', 14)\nEOF", "tokens 14\n"),
          shell("pnpm exec tsc --noEmit", "", { live: true, cwd: "packages/harness-web-app" }),
        ],
        live: true,
      },
    ],
  });

/** A scheme batch keeps its calls inside one row. */
export const schemeBatch = () =>
  session({
    id: "scheme",
    turns: [
      {
        prompt: "inspect the layout before moving the heading",
        work: [
          scheme(
            '(begin (shell "pwd") (read_file "./README.md"))',
            [shell("pwd", "/Users/ada/work/harness\n"), read("README.md", "# Harness\n")],
            "Inspect layout and styles before moving the heading",
          ),
        ],
      },
    ],
  });

/**
 * A program mid-run: three explorers are back, the reviewer is reading what they found and has stopped to
 * ask. The run is the daemon's side of the graph feed; the session's jobs are what its cards say.
 */
export const programRun = (): { readonly open: SessionPlexus; readonly workflows: Record<string, WorkflowRun> } => {
  const { source, script } = WORKFLOWS.fanout;
  const base = script();
  const run = runWorkflow(
    source,
    (call) => (call.name === "reviewer" ? { ...base(call), hold: "review" } : base(call)),
    new WorkflowClock(),
  );
  const program = scheme(
    source,
    [
      ...["api", "ui", "db"].map((area) =>
        agent("explore", `look at ${area}`, { worker: `w-prog-${area}`, background: false }),
      ),
      agent("reviewer", "api has two seams worth splitting. ui has two seams worth splitting.", {
        worker: "w-prog-review",
        background: false,
        live: true,
      }),
    ],
    "Explore three areas, then have a reviewer weigh them",
    { live: true },
  );
  return {
    open: session({
      id: "program",
      turns: [{ prompt: "split the seams, but have someone review before you act", work: [program], live: true }],
    }),
    workflows: { [program.toolCallId]: run },
  };
};

/** What the kernel glances of the program's workers: the reviewer is held at a call for approval. */
export const programWorkers: Readonly<Record<string, GlanceRow>> = {
  "w-prog-api": { title: "Seams in the api", model: "grok-4.7-build-fast", oneShot: true },
  "w-prog-ui": { title: "Seams in the ui", model: "grok-4.7-build-fast", oneShot: true },
  "w-prog-db": { title: "Seams in the db", model: "grok-4.7-build-fast", oneShot: true },
  "w-prog-review": {
    title: "Weigh the findings",
    model: "gpt-6.1-sol",
    status: "Running the seam audit",
    openTurn: true,
    asking: true,
    unfinished: "ask",
    askLine: "run pnpm audit:seams src/",
    oneShot: true,
  },
};

/** The left lane over several rounds: titles, a task list, a goal, and a model change. */
export const progress = () =>
  session({
    id: "progress",
    turns: [
      {
        prompt: "ship the bar",
        work: [
          title("Ship the bar", "Left pane"),
          task("create", "bar", { subject: "Left bar", description: "Show task progress beside the title" }),
          task("start", "bar"),
          task("create", "docs", { subject: "Docs" }),
          task("drop", "docs", { reason: "covered by the README" }),
          goal("Keep the left pane current"),
          speech("Progress lands in the left lane, under the round's title."),
          title("Verify", "Run the suite and look at a narrow page"),
          shell("pnpm test", "\u001b[32m✓\u001b[39m 203 tests\n"),
          task("validate", "bar"),
          speech("All green.", { model: "grok-4.7-build-fast", connection: "grok" }),
        ],
      },
    ],
  });

/** Reasoning only: rounds that thought and acted without speaking. */
export const reasoning = () =>
  session({
    id: "reasoning",
    turns: [
      {
        prompt: "why is the first paint slow?",
        work: [
          speech("", {
            thought:
              "**Checking the dev server.** Vite pre-bundles dependencies on the first load, and the highlighter loads its grammars lazily. Both cost seconds once.",
          }),
          shell("curl -s -o /dev/null -w '%{time_total}' localhost:8787", "2.84"),
          speech("It is the dev server's first optimize pass; a production build loads in under a second.", {
            thought: "A cold `vite build` and `vite preview` would confirm it without the optimizer.",
          }),
        ],
      },
    ],
  });

/** A turn still running: speech streaming in and a tool mid-call. */
export const running = () =>
  session({
    id: "running",
    turns: [
      {
        prompt: "rename the tape cells",
        work: [
          title("Rename the tape cells"),
          speech("Renaming `ReadLineCell` to the read family's name. First the call sites"),
          grep("ReadLineCell", ["src/shell/tape-read.ts:71", "src/shell/tape.tsx:146"]),
          shell("pnpm exec tsc --noEmit", "", { live: true }),
        ],
        live: true,
      },
    ],
  });

/**
 * Agents across their lives. Two sent to the background come back a turn and
 * two turns later; a search the model waited on closes in its own round; a
 * review fails and a sweep is cancelled; two are still out, one asking.
 */
export const agents = () => {
  const explore = agent("explore", "Map why first paint is slow: what loads before the tape renders", {
    worker: "w-explore",
  });
  const web = agent("web-research", "Find reports of React 19 inputs losing focus after a form reset", {
    worker: "w-web",
  });
  const audit = agent("security-auditor", "Sweep the composer for injected HTML", {
    worker: "w-audit",
    cancelled: true,
  });
  return session({
    id: "agents",
    turns: [
      {
        prompt: "the first paint is slow and the composer loses focus after send. look into both",
        work: [
          speech("Two separate threads. I'll send an agent at each and read the composer myself.", {
            thought: "The paint question is a repo walk; the focus one may be a known React issue.",
          }),
          explore,
          web,
          agent("quick-search", "Where is the draft cleared after send?", { worker: "w-search", background: false }),
          read("src/shell/composer.tsx", "export function Composer() {}\n"),
          speech("The draft clears before the send settles. Waiting on the two agents."),
        ],
      },
      {
        prompt: "",
        work: [
          settled(web),
          speech("Known issue: a reset during a transition drops focus. The fix is to clear after `{ ok: true }`."),
          agent("design-reviewer", "Stress-test clearing the draft only after the reply", {
            worker: "w-review",
            background: false,
            failed: "connection reset by peer",
          }),
          audit,
        ],
      },
      {
        prompt: "go ahead and fix it, with a test",
        work: [
          settled(explore, audit),
          speech("Explore says the first paint waits on the highlighter's grammars. Fixing focus first.", {
            thought: "The implementer edits; the test writer pins the regression. They can run side by side.",
          }),
          agent("implementer", "Clear the composer draft only after the send settles", {
            worker: "w-impl",
            live: true,
          }),
          agent("test-writer", "Write a regression test for composer focus after send", {
            worker: "w-test",
            live: true,
          }),
          speech("Both are working"),
        ],
        live: true,
      },
    ],
  });
};

/** The workers' own sessions, for a peek. The review and the sweep are left unbuilt: their peek cannot open. */
export const agentWorkerTapes = () => [
  session({
    id: "w-impl",
    turns: [
      {
        prompt: "Clear the composer draft only after the send settles",
        work: [
          speech("Finding where the draft clears first.", {
            thought:
              "The send handler and the reset are in one file; a search agent can confirm nothing else clears it.",
          }),
          agent("quick-search", "Who else writes the composer draft?", { worker: "w-impl-search", background: false }),
          edit(
            "src/shell/composer.tsx",
            'async function submit() {\n  setDraft("");\n  await send(draft);\n}\n',
            '  setDraft("");\n  await send(draft);\n',
            '  const reply = await send(draft);\n  if (reply.ok) setDraft("");\n',
          ),
          speech("The draft now waits for the reply. Checking the focus return next"),
        ],
        live: true,
      },
    ],
  }),
  session({
    id: "w-impl-search",
    turns: [{ prompt: "Who else writes the composer draft?", work: [grep("setDraft", ["src/shell/composer.tsx:41"])] }],
  }),
  session({
    id: "w-test",
    turns: [
      {
        prompt: "Write a regression test for composer focus after send",
        work: [
          write("src/shell/__tests__/composer.test.ts", "it('keeps focus after send', () => {});\n"),
          asking(shell("pnpm vitest run src/shell/__tests__/composer.test.ts", "", { live: true })),
        ],
        live: true,
      },
    ],
  }),
  session({
    id: "w-explore",
    turns: [
      {
        prompt: "Map why first paint is slow: what loads before the tape renders",
        work: [
          read("vite.config.ts", "export default {};\n"),
          grep("createHighlighter", ["src/shell/highlight.ts:12"]),
          speech(
            "The first paint waits on the highlighter: `createHighlighter` loads every grammar before the tape mounts.",
          ),
        ],
      },
    ],
  }),
];

/** What the kernel glances of each worker in {@link agents}. */
export const agentWorkers: Readonly<Record<string, GlanceRow>> = {
  "w-explore": {
    title: "Why the first paint is slow",
    model: "grok-4.7-build-fast",
    status: "Reading vite.config.ts",
    oneShot: true,
  },
  "w-web": { title: "React 19 focus loss after a form reset", model: "gpt-6-mini", oneShot: true },
  // No title yet: the note falls back to the spawn message.
  "w-search": { model: "gpt-6-mini", oneShot: true },
  "w-review": { title: "Review: clear the draft after the reply", model: "gpt-6.1-sol", oneShot: true },
  "w-audit": { title: "Composer HTML injection sweep", model: "gpt-6-mini", oneShot: true },
  "w-impl": {
    title: "Keep the composer draft until the send settles, then clear it and return focus to the field",
    model: "gpt-6.1-sol",
    status: "Editing src/shell/composer.tsx",
    openTurn: true,
    oneShot: true,
  },
  "w-test": {
    title: "Composer focus regression test",
    model: "gpt-6.1-sol",
    status: "Running the composer suite",
    openTurn: true,
    asking: true,
    unfinished: "ask",
    askLine: "run pnpm vitest run src/shell/__tests__/composer.test.ts",
    oneShot: true,
  },
};

/** A call waiting on you: the composer covers itself with the receipt. */
export const approval = (receipt: "diff" | "shell" | "args" = "diff") =>
  session({
    id: `approval-${receipt}`,
    turns: [
      {
        prompt: "tighten the composer edge",
        work: [
          speech("This needs a write to the stylesheet."),
          receipt === "diff"
            ? asking(
                edit("src/styles.css", STYLES, "  border: 1px solid var(--line);", "  border: 1px solid var(--edge);", {
                  live: true,
                }),
              )
            : receipt === "shell"
              ? asking(shell("rm -rf dist && pnpm build", "", { live: true }))
              : asking(tool("mcp__github__create_issue", { title: "Composer edge", labels: ["ui"] }, { live: true })),
        ],
        live: true,
      },
    ],
  });

/** Nothing said yet: the place and the composer sit together. */
export const fresh = () => session({ id: "fresh", turns: [] });

/** A conversation the sidebar lists without the client attached. */
export const quiet = (id: string, prompt: string) => session({ id, turns: [{ prompt, work: [speech("Done.")] }] });

/** Sessions in every state the rail can tell, none of them attached: their rows read the kernel glance. */
export const elsewhere = () => [
  session({
    id: "e-run",
    turns: [{ prompt: "Index the plugin docs", work: [shell("pnpm docs", "", { live: true })], live: true }],
  }),
  session({
    id: "e-ask",
    turns: [{ prompt: "Clean the build output", work: [asking(shell("rm -rf dist", "", { live: true }))], live: true }],
  }),
  session({
    id: "e-question",
    turns: [
      {
        prompt: "Pick a name for the rail",
        work: [speech("Should it be “rail” or “lane”?")],
        question: "rail or lane?",
      },
    ],
  }),
  quiet("e-idle", "Compact is greedy and the 5s is chokidar, not the fold"),
];
