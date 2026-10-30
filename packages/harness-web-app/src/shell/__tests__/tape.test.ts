import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Plexus } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionRoot, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { BeatTimeline, Tape } from "@inhuman.tools/harness-transcript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FilePreviewProvider } from "../file-sidebar.js";
import { groupBeats } from "../tape-beats.js";
import type { TapeCell } from "../tape-read.js";

const state = vi.hoisted(() => ({
  dial: {
    link: null as { kind: string } | null,
    attaching: false,
    kernel: { root: { sessions: {} } } as object | null,
    project: null as object | null,
    session: null as object | null,
    follow: () => undefined,
    projects: new Map<string, { root: { path: string; sessions: Record<string, string> } }>(),
    requestedTarget: { kind: "kernel" } as { kind: string; path?: string; sessionId?: string },
  },
}));
vi.mock("../../client/context.js", () => ({ useDial: () => state.dial }));

const render = (): string =>
  renderToStaticMarkup(createElement(FilePreviewProvider, { resetKey: null }, createElement(Tape)));

function renderCells(cells: readonly TapeCell[]): string {
  return renderToStaticMarkup(createElement(BeatTimeline, { beats: groupBeats(cells), onOpen: () => undefined }));
}

describe("Tape", () => {
  beforeEach(() => {
    state.dial.link = null;
    state.dial.kernel = { root: { sessions: {} } };
    state.dial.project = null;
    state.dial.session = null;
    state.dial.requestedTarget = { kind: "kernel" };
    state.dial.projects = new Map();
  });

  it("gives root and project views useful next steps", () => {
    expect(render()).toContain("Pick a project from the tabs below. + Add is for adding a project.");
    state.dial.project = { root: { path: "/work/project", sessions: {} } };
    expect(render()).toContain("Write the first message below. The session starts when you send it.");
    expect(render()).toContain("/work/project");
    state.dial.project = { root: { path: "/work/project", sessions: { existing: "" } } };
    expect(render()).toContain("Open a session, or write a first message below to start another.");
    state.dial.project = null;
    state.dial.requestedTarget = { kind: "project-session", path: "/work/project", sessionId: "missing" };
    state.dial.kernel = { root: { sessions: {}, projects: { "/work/project": "" } } };
    state.dial.projects = new Map([["/work/project", { root: { path: "/work/project", sessions: { existing: "" } } }]]);
    expect(render()).toContain("<h2>project</h2>");
    expect(render()).toContain("Open a session, or write a first message below to start another.");
    expect(render()).not.toContain("Your workspace");
  });

  it("distinguishes connecting and empty conversations", () => {
    state.dial.kernel = null;
    expect(render()).toContain('role="status"');
    expect(render()).toContain("Connecting to the harness daemon");
    expect(render()).toContain("Waiting for the local daemon.");
    state.dial.kernel = { root: { sessions: {}, projects: { "/work/project": {} } } };
    state.dial.session = { root: { title: "", sessionId: "session", path: "/work/project" } };
    // A fresh session names its place, not a placeholder title.
    expect(render()).toContain('aria-label="New conversation"');
    expect(render()).toContain("<h2>project</h2>");
    // The path breaks between segments only, and copies without extra characters.
    expect(render()).toContain("/<wbr/>work/<wbr/>project");
    expect(render().replaceAll("<wbr/>", "")).toContain("/work/project");
    state.dial.session = { root: { title: "Renamed first", sessionId: "session", path: "/work/project" } };
    expect(render()).toContain("<h2>Renamed first</h2>");
  });

  it("does not repeat the session title above the conversation", () => {
    const said = "Fix the lanes";
    const seat = (manualTitle?: string) => {
      const root = new SessionRoot({
        sessionId: "session",
        path: "/work/project",
        ...(manualTitle === undefined ? {} : { manualTitle }),
      });
      root.head = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        prompt: prompt.user`${said}`,
        queue: [],
        doneWork: [],
        reducerExited: true,
      });
      return root;
    };
    state.dial.kernel = { root: { sessions: {}, projects: {} } };
    const echoed = seat();
    const echoedDoc = Plexus.bootstrap(echoed);
    state.dial.session = { root: echoed };
    const hidden = render();
    echoedDoc.destroy();
    expect(hidden).not.toContain("transcript-header");
    expect(hidden).not.toContain(`<h2>${said}</h2>`);
    expect(hidden).toContain(`class="user-text">${said}</p>`);

    const renamed = seat("Renamed");
    const renamedDoc = Plexus.bootstrap(renamed);
    state.dial.session = { root: renamed };
    const shown = render();
    renamedDoc.destroy();
    expect(shown).not.toContain("transcript-header");
    expect(shown).not.toContain("<h2>Renamed</h2>");
    expect(shown).toContain(`class="user-text">${said}</p>`);
  });

  it("joins consecutive reads as quasi-links instead of disclosures", () => {
    const read = (id: string, path: string) => ({
      id,
      verb: "read" as const,
      path,
      label: path,
      outcome: "ok" as const,
    });
    const html = renderCells([
      {
        kind: "reads",
        id: "reads",
        items: [read("a", "src/tui/paint-source.ts"), read("b", "src/tui/paint-dom.ts"), read("c", "pack.wasm")],
      },
    ]);
    expect(html).toContain("Reading ");
    expect(html).toContain("src/tui/paint-source.ts");
    expect(html).toContain("src/tui/paint-dom.ts");
    expect(html).toContain('class="read-path"');
    expect(html).toContain("pack.wasm (binary)");
    expect(html).toMatch(/disabled/);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("read_file");
  });

  it("says each verb of a look run once, in call order, with scope, spinner, and failure", () => {
    const html = renderCells([
      {
        kind: "reads",
        id: "looks",
        items: [
          { id: "d", verb: "read", path: "src", label: "src/", text: "app.tsx", outcome: "ok" },
          { id: "f", verb: "read", path: "src/app.tsx", label: "src/app.tsx", outcome: "ok" },
          { id: "g", verb: "search", path: "", label: "update_metadata", scope: "src", outcome: "live" },
          { id: "h", verb: "search", path: "", label: "goal", text: "unknown mode", outcome: "failed" },
          { id: "i", verb: "find", path: "", label: "**/*.md", text: "README.md", outcome: "ok" },
          { id: "k", verb: "find", path: "", label: "**/*left*", outcome: "ok" },
          { id: "j", verb: "read", path: "docs", label: "docs/", outcome: "live" },
        ],
      },
    ]);
    const lines = [...html.matchAll(/<p class="read-line">(.*?)<\/p>/g)].map((match) =>
      match[1]!.replaceAll(/<span class="fail-info-bubble"[^>]*>.*?<\/span>/g, "").replaceAll(/<[^>]+>/g, ""),
    );
    expect(lines).toEqual([
      "Reading src/ and src/app.tsx",
      "Searching for update_metadata in src and goal",
      "Finding **/*.md and **/*left* (no matches)",
      "Reading docs/",
    ]);
    expect(html).toContain('aria-label="in progress"');
    expect(html).toContain('<span class="read-path" data-failed="">goal</span>');
    expect(html).toContain('popover="manual"');
    expect(html).toContain('role="tooltip">unknown mode</span>');
    // A listing that has not arrived has nothing to open yet.
    expect(html).toMatch(/<button class="read-path" disabled="" type="button" title="docs">docs\/<\/button>/);
  });

  it("labels roles and preserves exact tool identity in native disclosures", () => {
    const html = renderCells([
      { kind: "user", id: "user", text: "keep\nthese lines" },
      { kind: "speech", id: "assistant", text: "An **answer**.", thought: "Some reasoning." },
      {
        kind: "tool",
        id: "tool",
        summary: "read_file src/exact-file.ts",
        outcome: "ok",
        body: { kind: "text", text: '{"ok":true}' },
      },
    ]);
    expect(html).toContain('aria-label="Your message"');
    expect(html).toContain('aria-label="Assistant message"');
    expect(html).toContain("keep\nthese lines");
    expect(html).not.toContain("Thoughts");
    expect(html).toContain("Some reasoning.");
    expect(html).toContain('<div class="assistant-body">');
    expect(html).not.toContain("message-role");
    expect(html).toContain('class="annotation-slot side-right"');
    expect(html).toContain('class="beat-thoughts side-note"');
    expect(html).not.toContain("side-anchor");
    expect(html.indexOf("An <strong>answer</strong>.")).toBeLessThan(html.indexOf('<aside class="tape-thought">'));
    expect(html).toContain(
      '<summary><span class="tool-summary" title="read_file">read file <span class="mono">src/exact-file.ts</span></span></summary>',
    );
    expect(html).not.toContain('data-outcome="ok"');
    expect(html).toContain('<pre class="tool-body"><code>');
    // The tool and the reasoning fold, which only folds on a narrow page.
    expect(html.match(/<details\b/g)).toHaveLength(2);
    expect(html).toContain('<details class="beat-thoughts side-note"><summary>Reasoning</summary>');
    expect(html).not.toContain('<details class="tape-thought"');
    expect(html).toContain('data-hidden="until-found"');
  });

  it("humanizes a tool name and keeps the wire name on the title", () => {
    const html = renderCells([
      { kind: "tool", id: "mcp", summary: "mcp__github__issue_read", outcome: "ok", body: { kind: "empty" } },
      {
        kind: "tool",
        id: "scheme",
        summary: "scheme_repl retitle",
        outcome: "ok",
        body: { kind: "text", text: "ok" },
      },
    ]);
    expect(html).toContain('title="mcp__github__issue_read"');
    expect(html).toContain("GitHub · issue read");
    expect(html).toContain('title="scheme_repl"');
    expect(html).toContain("Scheme");
    expect(html).toContain("retitle");
  });

  it("parks a failure and a live spinner on the right of a tool block", () => {
    const html = renderCells([
      { kind: "tool", id: "bad", summary: "grep update_metadata", outcome: "failed", body: { kind: "empty" } },
      { kind: "tool", id: "run", summary: "glob **/*sidebar*", outcome: "live", body: { kind: "empty" } },
    ]);
    expect(html).toContain('class="tool-outcome label" data-outcome="failed">failed</span>');
    expect(html).toContain('aria-label="in progress"');
    expect(html).not.toContain(">live<");
    expect(html).not.toContain(">ok<");
    expect(html.indexOf("grep update_metadata")).toBeLessThan(html.indexOf('data-outcome="failed"'));
  });

  it("renders a shell call as a terminal and keeps its color", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "sh",
        summary: "shell pnpm exec vitest run src/__tests__/navigation.test.ts",
        outcome: "ok",
        body: {
          kind: "shell",
          command: "pnpm exec vitest run src/__tests__/navigation.test.ts",
          output: "\u001b[1m\u001b[32mRUN\u001b[39m\u001b[22m v4.1.0\n\u001b[32m✓\u001b[39m navigation.test.ts\n",
          exitCode: 0,
        },
      },
    ]);
    expect(html).toContain('class="shell-term"');
    expect(html).toContain('class="shell-sigil">$</span>');
    expect(html).toContain("pnpm exec vitest run src/__tests__/navigation.test.ts");
    expect(html).not.toContain("shell-cwd");
    expect(html).not.toContain("exit code");
    expect(html).not.toContain(" open");
    expect(html).toContain('class="shell-chevron"');
    expect(html).toContain(">RUN<");
    expect(html).toContain("color:var(--vt-2)");
    expect(html).toContain("font-weight:620");
    expect(html).toContain("navigation.test.ts");
  });

  it("inks a palette badge's gray text in the canvas, and keeps a chosen color", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "sh",
        summary: "shell pnpm test",
        outcome: "ok",
        body: {
          kind: "shell",
          command: "pnpm test",
          output:
            "\u001b[41m\u001b[30m FAIL \u001b[0m \u001b[43m RUN \u001b[0m \u001b[41m\u001b[38;2;1;2;3m own \u001b[0m\n",
          exitCode: 1,
        },
      },
    ]);
    expect(html).toContain('style="color:var(--canvas);background-color:var(--vt-1)"> FAIL ');
    expect(html).toContain('style="background-color:var(--vt-3);color:var(--canvas)"> RUN ');
    expect(html).toContain('style="color:rgb(1 2 3);background-color:var(--vt-1)"> own ');
  });

  it("renders an inline python heredoc as a Python script", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "py",
        summary: "shell python3",
        outcome: "ok",
        body: {
          kind: "shell",
          command: "python3 - <<'PY'\nfrom pathlib import Path\nprint('one lift row dropped')\nPY",
          output: "one lift row dropped\n",
          exitCode: 0,
        },
      },
    ]);
    expect(html).toContain("Python script");
    expect(html).toContain("from pathlib import Path");
    expect(html).toContain("one lift row dropped");
    expect(html).not.toContain('class="shell-sigil"');
    expect(html).not.toContain("python3 -");
    expect(html).not.toContain(" open");
  });

  it("puts a non-project directory above the prompt and a nonzero exit code on the right", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "sh",
        summary: "shell pnpm test",
        outcome: "failed",
        body: {
          kind: "shell",
          command: "pnpm test",
          directory: "packages/harness-web",
          output: "fail\n",
          exitCode: 1,
        },
      },
    ]);
    expect(html.indexOf('class="shell-cwd"')).toBeLessThan(html.indexOf('class="shell-sigil"'));
    expect(html).toContain("packages/harness-web");
    expect(html).toContain('class="shell-exit">exit code 1</p>');
    expect(html).not.toContain("failed");
    expect(html).toContain(" open");
    expect(html).toContain('class="shell-out"');
  });

  it("paints a failed overwrite as an inline line with the door on the info icon", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "write",
        summary: "write_file src/tui/empty-home.ts",
        outcome: "failed",
        body: {
          kind: "fail-line",
          verb: "overwrite",
          path: "src/tui/empty-home.ts",
          label: "src/tui/empty-home.ts",
          detail:
            "write_file: src/tui/empty-home.ts exists — tried to overwrite the existing file, use write_file with the overwriteExisting flag if you need that to happen",
        },
      },
    ]);
    expect(html).toContain("Failed to overwrite");
    expect(html).toContain("src/tui/empty-home.ts");
    expect(html).toContain("Why this failed");
    expect(html).toContain("overwriteExisting");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("tool-outcome");
  });

  it("shows file edits as open diffs", () => {
    const html = renderCells([
      {
        kind: "tool",
        id: "edit",
        summary: "edit_file src/a.ts",
        outcome: "ok",
        body: { kind: "diff", path: "src/a.ts", oldText: "before\n", newText: "after\n" },
      },
    ]);
    expect(html).toContain('class="diff"');
    expect(html).toContain("src/a.ts");
    expect(html).not.toContain("<details");
  });

  it("labels each round body with its title in the progress pane", () => {
    const html = renderCells([
      { kind: "user", id: "user", text: "start" },
      { kind: "round", id: "round" },
      {
        kind: "progress",
        id: "mark",
        title: "Grok migration cleanup",
        description: "Parallel Grok implementation",
        items: [],
      },
      { kind: "speech", id: "assistant", text: "Done.", thought: "" },
    ]);
    expect(html).toContain('class="progress-mark side-note"');
    expect(html.match(/id="round-title"/g)).toHaveLength(1);
    expect(html.indexOf("start")).toBeLessThan(html.indexOf("Grok migration cleanup"));
    expect(html.indexOf("Grok migration cleanup")).toBeLessThan(html.indexOf("Parallel Grok implementation"));
    expect(html).toContain('aria-labelledby="round-title"');
    expect(html).not.toContain("update_metadata");
  });

  it("places task and goal lines in the same progress pane as the title", () => {
    const html = renderCells([
      { kind: "round", id: "round" },
      {
        kind: "progress",
        id: "mark",
        title: "Ship the bar",
        description: "Left pane",
        items: [
          { id: "task", label: "Left bar", detail: "in progress" },
          { id: "goal", label: "Goal", detail: "Keep the left pane current" },
        ],
      },
      { kind: "speech", id: "assistant", text: "Working.", thought: "" },
    ]);
    expect(html).toContain('class="progress-items"');
    expect(html.indexOf("Ship the bar")).toBeLessThan(html.indexOf("Left bar"));
    expect(html.indexOf("Left bar")).toBeLessThan(html.indexOf("in progress"));
    expect(html).toContain("Keep the left pane current");
    expect(html).not.toContain("task__");
    expect(html).not.toContain("goal__");
  });

  it("closes each model span at its last round and holds it to the bottom", () => {
    const html = renderCells([
      { kind: "round", id: "one", model: "grok-4.7", connection: "grok" },
      { kind: "speech", id: "first", text: "One.", thought: "" },
      { kind: "round", id: "two", model: "grok-4.7", connection: "grok" },
      { kind: "speech", id: "second", text: "Two.", thought: "" },
      { kind: "round", id: "three", model: "gpt-6.1-sol", connection: "chatgpt" },
      { kind: "speech", id: "third", text: "Three.", thought: "" },
    ]);
    expect(
      [
        ...html.matchAll(
          /<aside class="model-note side-note"><span class="mono">([^<]*)<\/span><span class="text-muted">([^<]*)</g,
        ),
      ].map((match) => [match[1], match[2]]),
    ).toEqual([
      ["Grok 4.7", "grok"],
      ["Gpt 6.1 Sol", "chatgpt"],
    ]);
    expect(html).toContain("--annotation-end:anchor(--beat-2 bottom)");
    expect(html).toContain("--annotation-end:anchor(--beat-3 bottom)");
  });

  it("keeps thought-only rounds outside the center body and separates later rounds", () => {
    const cells: TapeCell[] = [
      { kind: "round", id: "thinking-round" },
      { kind: "speech", id: "thinking", text: "", thought: "First reasoning." },
      { kind: "speech", id: "more-thinking", text: "", thought: "More reasoning." },
      { kind: "round", id: "answer-round" },
      { kind: "speech", id: "answer", text: "Done.", thought: "Final reasoning." },
    ];
    expect(groupBeats(cells)).toEqual([
      {
        id: "thinking-round",
        mark: null,
        model: "",
        connection: "",
        cells: [],
        thoughts: [
          { id: "thinking", text: "First reasoning." },
          { id: "more-thinking", text: "More reasoning." },
        ],
        agents: [],
        settles: [],
      },
      {
        id: "answer-round",
        mark: null,
        model: "",
        connection: "",
        cells: [{ kind: "speech", id: "answer", text: "Done.", thought: "" }],
        thoughts: [{ id: "answer", text: "Final reasoning." }],
        agents: [],
        settles: [],
      },
    ]);
    const html = renderCells(cells);
    expect(html).toContain('<div class="beat-body"></div>');
    expect(html.match(/class="annotation-slot side-right"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Assistant message"/g)).toHaveLength(1);
    expect(html.match(/class="beat"/g)).toHaveLength(2);
    // Each thought is rendered once; side notes never reserve body height.
    expect(html.match(/class="tape-thought"/g)).toHaveLength(3);
    expect(html).not.toContain("inert");
  });

  it("orders each pane by its preceding annotation and targets independent round anchors", () => {
    const html = renderCells([
      { kind: "round", id: "one" },
      { kind: "progress", id: "title-one", title: "First title", description: "", items: [] },
      { kind: "speech", id: "thought-one", thought: "First thought", text: "First answer" },
      { kind: "round", id: "two" },
      { kind: "speech", id: "thought-two", thought: "Second thought", text: "Second answer" },
      { kind: "round", id: "three" },
      { kind: "progress", id: "title-three", title: "Last title", description: "", items: [] },
      { kind: "speech", id: "answer-three", thought: "", text: "Last answer" },
    ]);
    expect(html.match(/class="side-pane side-left"/g)).toHaveLength(1);
    expect(html.match(/class="side-pane side-right"/g)).toHaveLength(1);
    expect(html).toContain("--note-anchor:--left-note-1;--previous-note:0px;--annotation-end:anchor(--beat-3 top)");
    expect(html).toContain("--note-anchor:--right-note-1;--previous-note:0px;--annotation-end:anchor(--beat-2 top)");
    expect(html).toContain(
      "--note-anchor:--right-note-2;--previous-note:calc(anchor(--right-note-1 bottom) + var(--note-gap));--annotation-end:0px",
    );
    expect(html).toContain(
      "--note-anchor:--left-note-3;--previous-note:calc(anchor(--left-note-1 bottom) + var(--note-gap));--annotation-end:0px",
    );
    expect(html.match(/First title/g)).toHaveLength(1);
    expect(html.match(/First thought/g)).toHaveLength(1);
    expect(html).not.toContain("side-anchor");
  });

  it("puts a failed first connect where the loader was, with its one action", () => {
    state.dial.kernel = null;
    state.dial.link = { kind: "unreachable" };
    const html = render();
    expect(html).not.toContain("connecting-lines");
    expect(html).toContain('<p class="link-notice" role="status">');
    expect(html).toContain("Can’t reach the harness daemon.");
    expect(html).toContain("<code>inhuman daemon start</code>");
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});
