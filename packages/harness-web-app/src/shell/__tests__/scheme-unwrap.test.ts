import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Plexus } from "@here.build/plexus";
import {
  ProgrammaticJob,
  SCHEME_WATCH_TOOL_NAME,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { BeatTimeline } from "@inhuman.tools/harness-transcript";
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";

import { schemeExprReady, schemeExprSettled, schemeHostCallsOnly } from "../scheme-unwrap.js";
import { groupBeats } from "../tape-beats.js";
import { tapeCells, type TapeCell } from "../tape-read.js";

const CALLS = '(shell "cwd")\n(read_file "./readme.md")';

describe("scheme batch unwrap", () => {
  it.each([
    ["flat", CALLS],
    ["begin", '(begin (shell "cwd") (read_file "./readme.md"))'],
    ["list", '(list (shell "cwd") (read_file "./readme.md"))'],
    ["vector", '[(shell "cwd") (read_file "./readme.md")]'],
    ["comment", `;; (define x 1)\n${CALLS}`],
  ])("shows a %s batch as the calls", async (_name, expr) => {
    expect(await faces(expr, [shellJob(), readJob()])).toEqual(["round", "tool:shell cwd", "reads:readme.md"]);
  });

  it("renders the calls as tape rows", async () => {
    const html = markup(await project(CALLS, [shellJob(), readJob()]));
    expect(html).toContain('class="shell-term"');
    expect(html).toContain('class="shell-sigil">$</span>');
    expect(html).toContain(">cwd</code>");
    expect(html).not.toContain('class="tape-tool"');
    expect(html).not.toContain("· ok");
    expect(html).toContain('class="read-line"');
    expect(html).toContain("readme.md");
    expect(html).not.toContain("scheme_repl");
  });

  it("treats a plus sign inside a string as text", async () => {
    expect(await faces('(shell "echo (+ 1 2)")', [shellJob("echo (+ 1 2)")])).toEqual([
      "round",
      "tool:shell echo (+ 1 2)",
    ]);
  });

  it.each([
    ["let", '(let ((c "cwd")) (shell c))', "shell", ["tool:shell cwd"]],
    ["define", '(define (go) (shell "cwd")) (go)', "shell", ["tool:shell cwd"]],
    ["quote", `'(shell "cwd")\n(read_file "./readme.md")`, "both", ["tool:shell cwd", "reads:readme.md"]],
    ["plus", '(+ 1 (shell "cwd"))', "shell", ["tool:shell cwd"]],
    ["begin around define", '(begin (define x 1) (shell "cwd"))', "shell", ["tool:shell cwd"]],
    [
      "if around begin",
      '(if #t (begin (shell "cwd") (read_file "./readme.md")))',
      "both",
      ["tool:shell cwd", "reads:readme.md"],
    ],
    ["broken", "(shell", "shell", ["tool:shell cwd"]],
    ["unknown beside shell", '(nope "x") (shell "cwd")', "shell", ["tool:shell cwd"]],
  ])("keeps a %s program as the batch", async (_name, expr, kit, nested) => {
    const cells = await project(expr, kit === "both" ? [shellJob(), readJob()] : [shellJob()]);
    expect(facesOf(cells)).toEqual(["round", expect.stringMatching(/^scheme:scheme_repl /)]);
    const batch = cells.find((cell) => cell.kind === "tool");
    expect(batch?.kind === "tool" ? facesOf(batch.nested ?? []) : []).toEqual(nested);
  });

  it("keeps scheme_watch as the batch", async () => {
    const cells = await project(CALLS, [shellJob(), readJob()], SCHEME_WATCH_TOOL_NAME);
    expect(facesOf(cells)).toEqual(["round", expect.stringMatching(/^scheme:scheme_watch /)]);
  });

  it.each([
    ["agent/ask", '(agent/ask \'explore "map")', "agent__ask", {}],
    ["bot/send", '(bot/send \'reviewer "look")', "agent__send", {}],
    ["fff_search", '(fff_search "*.md")', "glob", { pattern: "*.md" }],
    ["mcp/call", "(mcp/call 'srv 'tool)", "srv__tool", {}],
    ["pack tool", '(custom_tool "x")', "custom_tool", {}],
  ])("shows %s under its admitted call", async (_name, expr, jobName, args) => {
    const cells = await project(expr, [toolJob(jobName, args)]);
    // A glob is a look: it says what it found instead of standing as a row.
    expect(facesOf(cells)).toEqual(["round", jobName === "glob" ? "reads:*.md" : `tool:${jobName}`]);
  });

  it("shows a metadata-only batch as its progress mark", async () => {
    const expr = '(update_metadata "Later")';
    const cells = await project(expr, [
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        name: "update_metadata",
        argsJson: JSON.stringify({
          current_turn_title: "Later stretch",
          current_turn_description: "Keep the notes",
        }),
        completed: true,
      }),
    ]);
    expect(facesOf(cells)).toEqual(["round", "progress:Later stretch:Keep the notes"]);
  });

  it("wakes the tape computed when the reader settles", async () => {
    const expr = '(shell "uname")';
    const seen: boolean[] = [];
    const stop = autorun(() => {
      seen.push(schemeHostCallsOnly(expr, new Set(["shell"])));
    });
    await schemeExprReady(expr);
    stop();
    expect(seen).toEqual([false, true]);
  });

  it("keeps the batch until the reader settles, then shows the calls", async () => {
    const expr = '(shell "pwd")\n(read_file "./README")';
    expect(facesOf(projectNow(expr, [shellJob("pwd"), readJob("./README")]))).toEqual([
      "round",
      expect.stringMatching(/^scheme:scheme_repl /),
    ]);
    await schemeExprReady(expr);
    expect(schemeExprSettled(expr)).toBe(true);
    expect(facesOf(projectNow(expr, [shellJob("pwd"), readJob("./README")]))).toEqual([
      "round",
      "tool:shell pwd",
      "reads:README",
    ]);
  });
});

function shellJob(command = "cwd"): SystemToolJob {
  return new SystemToolJob({
    name: "shell",
    argsJson: JSON.stringify({ command }),
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, value: { stdout: "/tmp/web\n", stderr: "" } }),
  });
}

function readJob(path = "./readme.md"): SystemToolJob {
  return new SystemToolJob({
    name: "read_file",
    argsJson: JSON.stringify({ path }),
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, text: "# hi\n" }),
  });
}

function toolJob(name: string, args: Readonly<Record<string, unknown>>): SystemToolJob {
  return new SystemToolJob({
    name,
    argsJson: JSON.stringify(args),
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, text: "ok" }),
  });
}

async function faces(expr: string, tools: readonly SystemToolJob[]): Promise<string[]> {
  return facesOf(await project(expr, tools));
}

async function project(expr: string, tools: readonly SystemToolJob[], toolName = "scheme_repl"): Promise<TapeCell[]> {
  await schemeExprReady(expr);
  expect(schemeExprSettled(expr)).toBe(true);
  return projectNow(expr, tools, toolName);
}

function projectNow(expr: string, tools: readonly SystemToolJob[], toolName = "scheme_repl"): TapeCell[] {
  const root = new SessionRoot({ sessionId: "s", path: "/tmp/web" });
  const program = new ProgrammaticJob({
    toolName,
    argsJson: JSON.stringify({ expr }),
    outcomeJson: JSON.stringify({ ok: true, value: ["#t"] }),
    completed: true,
  });
  for (const tool of tools) program.pushInvocation(tool);
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    doneWork: [program],
    reducerExited: true,
  });
  turn.pushChild(program);
  root.head = turn;
  const plexus = Plexus.bootstrap(root);
  try {
    return tapeCells(root);
  } finally {
    plexus.destroy();
  }
}

function markup(cells: readonly TapeCell[]): string {
  return renderToStaticMarkup(createElement(BeatTimeline, { beats: groupBeats(cells), onOpen: () => undefined }));
}

function facesOf(cells: readonly TapeCell[]): string[] {
  return cells.map((cell) => {
    if (cell.kind === "progress") {
      const items = cell.items.map((item) => `${item.label}:${item.detail}`).join("|");
      return items === ""
        ? `progress:${cell.title}:${cell.description}`
        : `progress:${cell.title}:${cell.description}|${items}`;
    }
    if (cell.kind === "reads") return `reads:${cell.items.map((item) => item.label).join(",")}`;
    if (cell.kind !== "tool") return cell.kind;
    const scheme = /^(scheme_repl|scheme_watch) /.exec(cell.summary);
    return scheme == null ? `tool:${cell.summary}` : `scheme:${cell.summary.split(" · ")[0]}`;
  });
}
