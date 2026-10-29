import { Plexus } from "@here.build/plexus";
import {
  CompletionExpectation,
  CompletionJob,
  FileMutateToolJob,
  ProgrammaticJob,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import { reduceSession, type FileFact, type SessionEvent } from "../session-reducer.js";
import { tapeCells, type TapeCell } from "../tape-read.js";

type Mutation = Extract<FileFact, { kind: "mutation" }>;
function edit(
  id: string,
  prior: string | null,
  oldText: string,
  newText: string,
  options: Partial<Mutation> = {},
): TapeCell {
  return {
    kind: "tool",
    id,
    summary: "edit_file a.ts",
    outcome: "ok",
    body: { kind: "diff", path: "a.ts", oldText, newText, lineStart: 46 },
    file: {
      kind: "mutation",
      path: "a.ts",
      prior,
      existed: true,
      status: "applied",
      lineStart: 46,
      operation: { kind: "edit", oldText, newText, replaceAll: false },
      ...options,
    },
  };
}
function write(id: string, prior: string | null, content: string, options: Partial<Mutation> = {}): TapeCell {
  return edit(id, prior, "", content, { operation: { kind: "write", content }, ...options });
}
function read(id: string, content: string): TapeCell {
  return {
    kind: "tool",
    id,
    summary: "read_file a.ts",
    outcome: "ok",
    body: { kind: "text", text: content },
    file: { kind: "read", path: "a.ts", content },
  };
}
function round(id: string): TapeCell {
  return { kind: "round", id };
}
const reduce = (events: readonly SessionEvent[]) => reduceSession(events, "/work");
const diffs = (cells: readonly TapeCell[]): TapeCell[] =>
  cells.flatMap((cell) => {
    if (cell.kind !== "tool") return [];
    const own = cell.body.kind === "diff" ? [cell] : [];
    return [...own, ...(cell.nested == null ? [] : diffs(cell.nested))];
  });

describe("session file edit reducer", () => {
  it("merges across rounds at the latest edit, preserving identity, baseline and provenance", () => {
    const cells = reduce([
      round("one"),
      edit("first", "const a = 1;\n", "1", "2"),
      { kind: "speech", id: "speech", text: "Checking", thought: "Reasoning" },
      round("two"),
      read("read", "const a = 2;\n"),
      { kind: "progress", id: "title", title: "Finish", description: "", items: [] },
      edit("second", "const a = 2;\n", "2", "3"),
    ]);
    expect(diffs(cells)).toHaveLength(1);
    expect(cells.map((cell) => cell.id)).toEqual(["one", "speech", "two", "read", "title", "first"]);
    expect(cells.at(-1)).toMatchObject({
      id: "first",
      body: { kind: "diff", oldText: "const a = 1;\n", newText: "const a = 3;\n" },
      edits: { mutationIds: ["first", "second"], roundIds: ["one", "two"] },
    });
  });

  it("keeps independent chains for interleaved files and lexical aliases", () => {
    const cells = reduce([
      edit("a", "1", "1", "2"),
      edit("b", "x", "x", "y", { path: "b.ts" }),
      edit("a2", "2", "2", "3", { path: "/work/./a.ts" }),
    ]);
    expect(diffs(cells).map((cell) => cell.id)).toEqual(["b", "a"]);
    expect(cells.at(-1)).toMatchObject({ body: { oldText: "1", newText: "3" } });
  });

  it("merges create, edit and overwrite, including empty writes and replace_all", () => {
    const cells = reduce([
      write("create", null, "a a", { existed: false }),
      edit("all", "a a", "a", "b", { operation: { kind: "edit", oldText: "a", newText: "b", replaceAll: true } }),
      write("overwrite", "b b", "c"),
      write("empty", "c", ""),
    ]);
    expect(diffs(cells)).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      id: "create",
      body: { oldText: "", newText: "" },
      edits: { mutationIds: ["create", "all", "overwrite", "empty"] },
    });
  });

  it("splits on external content changes rather than claiming them as tool edits", () => {
    const cells = reduce([edit("first", "a", "a", "b"), edit("external", "outside", "outside", "c")]);
    expect(diffs(cells)).toHaveLength(2);
    expect(cells[1]).toMatchObject({ body: { oldText: "outside", newText: "c" } });
  });

  it("uses preceding full reads, never future reads, and detects discontinuity in reads", () => {
    const cells = reduce([edit("unknown", null, "a", "b"), read("later", "b"), edit("known", null, "b", "c")]);
    expect(diffs(cells)).toHaveLength(2);
    expect(cells[0]).toMatchObject({ body: { lineStart: 46 } });
    expect(cells[0]).not.toHaveProperty("edits");
    expect(cells.at(-1)).toMatchObject({ body: { oldText: "b", newText: "c" } });
    expect(
      diffs(reduce([edit("first", "a", "a", "b"), read("changed", "x"), edit("second", null, "x", "y")])),
    ).toHaveLength(2);
  });

  it("reconstructs a later edit from an accumulated full-file state", () => {
    const cells = reduce([edit("first", "a", "a", "b"), edit("second", null, "b", "c")]);
    expect(diffs(cells)).toHaveLength(1);
    expect(cells[0]).toMatchObject({ body: { oldText: "a", newText: "c" } });
    expect("lineStart" in (cells[0].kind === "tool" ? cells[0].body : {})).toBe(false);
  });

  it("does not merge pending, denied or failed edits into an applied chain", () => {
    const pending = edit("pending", "b", "b", "bad", { status: "pending" });
    const failed = {
      ...edit("failed", "b", "b", "bad", { status: "failed" }),
      body: { kind: "text" as const, text: "denied" },
    };
    const events = [edit("first", "a", "a", "b"), pending, failed, edit("last", "b", "b", "c")];
    const cells = reduce(events);
    expect(cells.map((cell) => cell.id)).toEqual(["pending", "failed", "first"]);
    expect(cells.at(-1)).toMatchObject({ edits: { mutationIds: ["first", "last"] } });
    expect(reduce(events)).toEqual(cells);
  });

  it("ends chains on every turn boundary, including turns without a prompt", () => {
    const cells = reduce([
      edit("one", "a", "a", "b"),
      { kind: "turn", id: "turn" },
      edit("two", "b", "b", "c"),
      { kind: "user", id: "user", text: "next request" },
      edit("three", "c", "c", "d"),
    ]);
    expect(diffs(cells).map((cell) => cell.id)).toEqual(["one", "two", "three"]);
  });

  it("does not guess ambiguous replacements or unknown overwrite baselines", () => {
    const unknown = {
      ...write("unknown", null, "b", { existed: true }),
      body: { kind: "text" as const, text: "replaced" },
    };
    const cells = reduce([edit("ambiguous", "a a", "a", "b"), unknown, edit("next", null, "b", "c")]);
    expect(cells[0]).toMatchObject({ body: { lineStart: 46 } });
    expect(cells[1]).toMatchObject({ body: { kind: "text" } });
    expect(cells[2]).toMatchObject({ body: { oldText: "b", newText: "c" } });
  });

  it("replays settlement and rewind without stale cached merges", () => {
    const first = edit("first", "a", "a", "b");
    const pending = edit("second", "b", "b", "c", { status: "pending" });
    expect(diffs(reduce([first, pending]))).toHaveLength(2);
    expect(diffs(reduce([first, edit("second", "b", "b", "c")]))).toHaveLength(1);
    expect(reduce([first])[0]).toMatchObject({ body: { oldText: "a", newText: "b" } });
  });
});

function projectJobs(jobs: SystemToolJob[]): TapeCell[] {
  const root = new SessionRoot({ sessionId: "receipts", path: "/work" });
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], doneWork: jobs });
  for (const job of jobs) turn.pushChild(job);
  root.head = turn;
  const plexus = Plexus.bootstrap(root);
  try {
    return tapeCells(root);
  } finally {
    plexus.destroy();
  }
}

function receiptJob(name: string, args: Record<string, unknown>, text: string): SystemToolJob {
  return new SystemToolJob({
    name,
    argsJson: JSON.stringify({ path: "a.ts", ...args }),
    completed: true,
    outcomeJson: JSON.stringify({ ok: true, text }),
  });
}

it("never paints an untyped overwrite or a clipped read as a creation baseline", () => {
  const clipped = receiptJob("read_file", {}, "prefix\n…[file is 999999 bytes; read the first 262144]");
  const overwritten = receiptJob("write_file", { content: "replacement" }, "replaced a.ts");
  const edited = receiptJob("edit_file", { old_string: "replacement", new_string: "final" }, "edited a.ts");
  const cells = projectJobs([clipped, overwritten, edited]);
  expect(cells.find((cell) => cell.kind === "tool")).toMatchObject({
    body: { kind: "text", text: "replaced a.ts" },
  });
  expect(diffs(cells)).toHaveLength(0);
});

it("folds consecutive reads, including live and sliced calls, until another tool", () => {
  const live = new SystemToolJob({ name: "read_file", argsJson: JSON.stringify({ path: "a.ts" }) });
  const sliced = receiptJob("read_file", { offset: 1, limit: 20 }, "part");
  const other = new SystemToolJob({
    name: "shell",
    argsJson: JSON.stringify({ command: "x" }),
    completed: true,
    outcomeJson: '{"ok":true,"text":""}',
  });
  const later = receiptJob("read_file", { path: "c.ts" }, "c");
  const cells = projectJobs([live, sliced, receiptJob("read_file", { path: "b.ts" }, "export {}"), other, later]);
  expect(
    cells.flatMap((cell) => {
      if (cell.kind === "reads") return [`reads:${cell.items.map((item) => item.label).join(",")}`];
      if (cell.kind === "tool") return [`tool:${cell.summary}`];
      return [];
    }),
  ).toEqual(["reads:a.ts,b.ts", "tool:shell x", "reads:c.ts"]);
  const first = cells.find((cell) => cell.kind === "reads");
  expect(first?.kind === "reads" ? first.items.map((item) => item.text) : []).toEqual([undefined, "export {}"]);
});

it("folds the whole read family into the run: listings, searches, and their failures", () => {
  const failed = new SystemToolJob({
    name: "grep",
    argsJson: JSON.stringify({ pattern: "y", mode: "bogus" }),
    completed: true,
    outcomeJson: JSON.stringify({ ok: false, text: "unknown mode bogus" }),
  });
  const cells = projectJobs([
    receiptJob("list_dir", { path: "." }, "a.ts\nsrc/"),
    receiptJob("list_dir", { path: "src" }, "app.tsx"),
    receiptJob("read_file", { path: "src/app.tsx" }, "export {}"),
    receiptJob("grep", { pattern: "x", path: "src" }, "src/app.tsx:1:x"),
    failed,
    receiptJob("glob", { pattern: "**/*.md", path: "." }, "README.md"),
    receiptJob("list_dir", { path: "src" }, "app.tsx"),
  ]);
  const run = cells.find((cell) => cell.kind === "reads");
  expect(run?.kind === "reads" ? run.items : []).toMatchObject([
    { verb: "read", label: "./", path: ".", text: "a.ts\nsrc/", outcome: "ok" },
    { verb: "read", label: "src/", path: "src", text: "app.tsx" },
    { verb: "read", label: "src/app.tsx", path: "src/app.tsx", text: "export {}" },
    { verb: "search", label: "x", path: "", scope: "src", text: "src/app.tsx:1:x" },
    { verb: "search", label: "y", text: "unknown mode bogus", outcome: "failed" },
    { verb: "find", label: "**/*.md", text: "README.md" },
  ]);
  expect(cells.filter((cell) => cell.kind === "tool")).toEqual([]);
});

it("keeps untyped mutation receipts as text", () => {
  const cells = projectJobs([
    receiptJob("read_file", {}, "a x"),
    receiptJob("edit_file", { old_string: "a", new_string: "b" }, "edited"),
    receiptJob("edit_file", { old_string: "a", new_string: "c" }, "edited after external reset"),
  ]);
  expect(diffs(cells)).toHaveLength(0);
});

it("shows an edit inside the working directory as a relative path", () => {
  const root = new SessionRoot({ sessionId: "s", path: "/work" });
  const job = new FileMutateToolJob({
    name: "edit_file",
    argsJson: JSON.stringify({ path: "/work/src/a.ts", old_string: "a", new_string: "b" }),
    priorContent: "a",
    existed: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), queue: [], doneWork: [job] });
  turn.pushChild(job);
  root.head = turn;
  const plexus = Plexus.bootstrap(root);
  try {
    expect(diffs(tapeCells(root))[0]).toMatchObject({ body: { path: "src/a.ts" } });
  } finally {
    plexus.destroy();
  }
});

it("projects actual direct and Scheme mutations into one cumulative diff across completions", () => {
  const root = new SessionRoot({ sessionId: "s", path: "/work" });
  const completion = () => new CompletionJob({ expectation: new CompletionExpectation({ connectionId: "test" }) });
  const first = new FileMutateToolJob({
    name: "edit_file",
    argsJson: JSON.stringify({ path: "a.ts", old_string: "a", new_string: "b" }),
    priorContent: "a",
    existed: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const second = new FileMutateToolJob({
    name: "edit_file",
    argsJson: JSON.stringify({ path: "a.ts", old_string: "b", new_string: "c" }),
    priorContent: "b",
    existed: true,
    completed: true,
    outcomeJson: '{"ok":true}',
  });
  const program = new ProgrammaticJob({ completed: true });
  program.pushInvocation(second);
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    queue: [],
    doneWork: [completion(), first, completion(), program],
  });
  for (const chunk of turn.doneWork) turn.pushChild(chunk);
  root.head = turn;
  const plexus = Plexus.bootstrap(root);
  try {
    const cells = tapeCells(root);
    const merged = diffs(cells);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: first.uuid,
      body: { oldText: "a", newText: "c" },
      edits: { mutationIds: [first.uuid, second.uuid] },
    });
    expect(cells.at(-1)).toMatchObject({ kind: "tool", nested: [{ id: first.uuid }] });
    expect(tapeCells(root)).toEqual(cells);
  } finally {
    plexus.destroy();
  }
});

it("projects a job that cannot be read as one failed row and keeps the rest of the turn", () => {
  const broken = receiptJob("grep", { pattern: "x" }, "hit");
  Object.defineProperty(broken, "args", {
    get() {
      throw new Error("args unreadable");
    },
  });
  const cells = projectJobs([broken, receiptJob("read_file", { path: "a.ts" }, "a")]);
  expect(cells.find((cell) => cell.kind === "tool")).toMatchObject({ outcome: "failed", summary: "unreadable step" });
  expect(cells.some((cell) => cell.kind === "reads")).toBe(true);
});
