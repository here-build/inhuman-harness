import { prompt } from "@inhuman.tools/harness-commons";
import {
  AgentCallJob,
  type BlobPeek,
  MCPToolJob,
  McpToolExpectation,
  ProgrammaticJob,
  reportShellTail,
  FileMutateToolJob,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
  storedBlobJson,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { formatShellCommandReady } from "@inhuman.tools/harness-sdk/text";
import { INDICATION_EXPAND_GLYPH } from "@inhuman.tools/quickdraw/layout";
import { FgP } from "@inhuman.tools/quickdraw/lexicon";
import { rasterLayout } from "@inhuman.tools/quickdraw/runtime";
import { expandWidgetPriors } from "@inhuman.tools/quickdraw/widgets";
import { describe, expect, it } from "vitest";

import {
  askPinFace,
  askPinNode,
  askPinWorthPainting,
  receiptPlainText,
  SIGIL_ASK,
  SIGIL_JUDGE,
  SIGIL_SCHEME_REPL,
  SIGIL_SCHEME_WATCH,
  SIGIL_SHELL,
  SIGIL_TOOL,
  workCellFace,
  workCellFuse,
  workDisclosure,
} from "../work-cells.js";

function indicationOf(node: unknown):
  | {
      gutter?: { kind?: string; glyph?: string; profile?: string; rows?: string };
      style?: { role?: string; prominence?: number };
      children?: unknown[];
    }
  | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const rec = node as { type?: string; summary?: unknown; children?: unknown[] };
  if (rec.type === "disclosure" && rec.summary !== undefined) return indicationOf(rec.summary);
  if (rec.type === "indication") {
    return rec as {
      gutter?: { kind?: string; glyph?: string; profile?: string; rows?: string };
      style?: { role?: string; prominence?: number };
      children?: unknown[];
    };
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const hit = indicationOf(child);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

function extraIndicationOf(node: unknown):
  | {
      gutter?: { kind?: string; glyph?: string; profile?: string; rows?: string };
      style?: { role?: string; prominence?: number };
    }
  | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const rec = node as { type?: string; children?: unknown[] };
  if (rec.type !== "disclosure" || !Array.isArray(rec.children)) return undefined;
  for (const child of rec.children) {
    if (typeof child !== "object" || child === null) continue;
    const indication = child as {
      type?: string;
      gutter?: { kind?: string; glyph?: string; profile?: string; rows?: string };
      style?: { role?: string; prominence?: number };
    };
    if (indication.type === "indication" && indication.gutter?.kind === "rule") return indication;
  }
  return undefined;
}

function hasKey(node: unknown, key: string): boolean {
  if (Array.isArray(node)) return node.some((child) => hasKey(child, key));
  if (typeof node !== "object" || node === null) return false;
  const rec = node as { key?: unknown; children?: unknown[] };
  if (rec.key === key) return true;
  if (!Array.isArray(rec.children)) return false;
  return rec.children.some((child) => hasKey(child, key));
}

function hasStyle(node: unknown, field: "justifyContent" | "direction", value: string): boolean {
  if (typeof node !== "object" || node === null) return false;
  const rec = node as { style?: { justifyContent?: unknown; direction?: unknown }; children?: unknown[] };
  if (rec.style?.[field] === value) return true;
  if (!Array.isArray(rec.children)) return false;
  return rec.children.some((child) => hasStyle(child, field, value));
}

function textsOf(node: unknown): string[] {
  const out: string[] = [];
  const walk = (cur: unknown): void => {
    if (typeof cur !== "object" || cur === null) return;
    const rec = cur as { text?: unknown; children?: unknown[]; summary?: unknown };
    if (typeof rec.text === "string") out.push(rec.text);
    if (rec.summary !== undefined) walk(rec.summary);
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child);
    }
  };
  walk(node);
  return out;
}

function hasRole(node: unknown, role: string): boolean {
  if (typeof node !== "object" || node === null) return false;
  const rec = node as { style?: { role?: unknown }; children?: unknown[]; summary?: unknown };
  if (rec.style?.role === role) return true;
  if (rec.summary !== undefined && hasRole(rec.summary, role)) return true;
  if (!Array.isArray(rec.children)) return false;
  return rec.children.some((child) => hasRole(child, role));
}

function sealedShell(opts: {
  readonly exitCode?: number;
  readonly ok?: boolean;
  readonly stdout?: string;
  readonly policyMessage?: string;
}): SystemToolJob {
  const job = new SystemToolJob({
    toolCallId: "sh",
    name: "shell",
    argsJson: '{"command":"ls"}',
    outcomeJson: JSON.stringify({
      ok: opts.ok ?? true,
      value: {
        exitCode: opts.exitCode ?? 0,
        stdout: opts.stdout ?? "",
        stderr: "",
      },
    }),
    completed: true,
  });
  if (opts.policyMessage !== undefined) job.policyMessage = opts.policyMessage;
  return job;
}

describe("work cells", () => {
  it("sealed edit_file and write_file are open Diffs with the filename on top", () => {
    const edit = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "a.ts",
        old_string: "a",
        new_string: "b",
      }),
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    const write = new SystemToolJob({
      toolCallId: "w",
      name: "write_file",
      argsJson: '{"path":"a.ts","content":"hi"}',
      outcomeJson: '{"ok":true,"text":"wrote"}',
      completed: true,
    });
    const overwrite = new FileMutateToolJob({
      toolCallId: "ow",
      name: "write_file",
      argsJson: '{"path":"a.ts","content":"hi","overwriteExisting":true}',
      outcomeJson: '{"ok":true,"text":"replaced a.ts (2 bytes)"}',
      completed: true,
      existed: true,
      priorContent: "old",
    });
    const editFace = workCellFace(edit, "e", false, true);
    const writeFace = workCellFace(write, "w", false, true);
    expect({
      edit: { type: workDisclosure(editFace, 40).type, receipt: editFace.receipt },
      write: { type: workDisclosure(writeFace, 40).type, receipt: writeFace.receipt },
      overwrite: workCellFace(overwrite, "ow", false, true).receipt,
    }).toEqual({
      edit: { type: "box", receipt: { kind: "diff", old: "a", new: "b", path: "a.ts" } },
      write: { type: "box", receipt: { kind: "diff", old: "", new: "hi", path: "a.ts" } },
      overwrite: { kind: "diff", old: "old", new: "hi", path: "a.ts" },
    });
  });

  it("edit_file Diff numbers from the file, not the span", () => {
    const old = "const resetInSec = raw.resetInSec ?? remaining.resetAt;";
    const next = "const resetInSec = raw.resetInSec ?? raw.resetsAt;";
    const stamped = new FileMutateToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "opencode-go.ts",
        old_string: old,
        new_string: next,
      }),
      outcomeJson: '{"ok":true}',
      completed: true,
      priorLineStart: 46,
    });
    const stampedRows = rasterLayout(
      expandWidgetPriors(workDisclosure(workCellFace(stamped, "e", false, true), 120), { width: 120 }),
      120,
      16,
    );
    const prior = `${Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
    const fromFile = new FileMutateToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "a.ts",
        old_string: "line-10",
        new_string: "line-10-edited",
      }),
      outcomeJson: '{"ok":true}',
      completed: true,
      priorContent: prior,
    });
    const texts = JSON.stringify(
      expandWidgetPriors(workDisclosure(workCellFace(fromFile, "e", false, true), 40), {
        width: 40,
      }),
    );
    expect({
      stamped: workCellFace(stamped, "e", false, true).receipt,
      stampedRows: {
        file: stampedRows.some((row) => row.includes("46")),
        span: stampedRows.some((row) => /(?:^|▌)1 /.test(row) || row.includes("▌1 ")),
        change: stampedRows.some((row) => row.includes("resetsAt")),
      },
      fromFile: workCellFace(fromFile, "e", false, true).receipt,
      fromFileRows: {
        change: texts.includes("line-10-edited"),
        fileLine: texts.includes('"content":"11 "'),
        first: texts.includes('"content":" 1 "'),
        far: texts.includes("line-00"),
      },
    }).toEqual({
      stamped: {
        kind: "diff",
        old,
        new: next,
        path: "opencode-go.ts",
        lineStart: 46,
      },
      stampedRows: { file: true, span: false, change: true },
      fromFile: {
        kind: "diff",
        old: prior,
        new: prior.replace("line-10", "line-10-edited"),
        path: "a.ts",
      },
      fromFileRows: { change: true, fileLine: true, first: false, far: false },
    });
  });

  it("ask pin carries Diff for edit and create; empty edit has no Diff theatre", () => {
    const plexus = SessionPlexus.create("s", "/tmp/p");
    const edit = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "a.ts",
        old_string: "a",
        new_string: "b",
      }),
      policyResult: "ask",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`edit`,
      doneWork: [edit],
      queue: [],
    });
    turn.pushChild(edit);
    plexus.root.head = turn;
    const editFace = workCellFace(edit, "ask:e", false, false);
    const blank = new SystemToolJob({
      toolCallId: "blank",
      name: "edit_file",
      argsJson: '{"path":"a.ts"}',
      policyResult: "ask",
    });
    turn.pushChild(blank);
    const emptyFace = workCellFace(blank, "ask:blank", false, false);
    const emptyWrite = new SystemToolJob({
      toolCallId: "empty-w",
      name: "write_file",
      argsJson: '{"path":"hello.ts","content":""}',
      policyResult: "ask",
    });
    turn.pushChild(emptyWrite);
    const emptyWriteFace = workCellFace(emptyWrite, "ask:empty-w", false, false);
    const create = new SystemToolJob({
      toolCallId: "w",
      name: "write_file",
      argsJson: JSON.stringify({ path: "hello.ts", content: 'export const greeting = "hello";' }),
      policyResult: "ask",
    });
    turn.pushChild(create);
    const createFace = workCellFace(create, "ask:w", false, false);
    edit.humanApprove = true;
    const held = askPinFace(edit);
    expect({
      edit: {
        type: askPinNode(editFace, 40).type,
        receipt: editFace.receipt,
        pinWorth: askPinWorthPainting(editFace),
      },
      blank: {
        pinWorth: askPinWorthPainting(emptyFace),
        receipt: emptyFace.receipt,
      },
      emptyWrite: {
        pinWorth: askPinWorthPainting(emptyWriteFace),
        receipt: emptyWriteFace.receipt,
      },
      create: {
        type: askPinNode(createFace, 40).type,
        receipt: createFace.receipt,
        pinWorth: askPinWorthPainting(createFace),
      },
      held: { state: held.state, receipt: held.receipt, pinWorth: askPinWorthPainting(held) },
    }).toEqual({
      edit: {
        type: "box",
        receipt: { kind: "diff", old: "a", new: "b", path: "a.ts" },
        pinWorth: true,
      },
      blank: { pinWorth: false, receipt: { kind: "none" } },
      emptyWrite: { pinWorth: false, receipt: { kind: "none" } },
      create: {
        type: "box",
        receipt: {
          kind: "diff",
          old: "",
          new: 'export const greeting = "hello";',
          path: "hello.ts",
        },
        pinWorth: true,
      },
      held: {
        state: "live",
        receipt: { kind: "diff", old: "a", new: "b", path: "a.ts" },
        pinWorth: true,
      },
    });
    plexus.destroy();
  });

  it("ask cell is a question gutter; Diff stays open; the vote is not a word", () => {
    const plexus = SessionPlexus.create("s", "/tmp/p");
    const edit = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "a.ts",
        old_string: "a",
        new_string: "b",
      }),
      policyResult: "ask",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`edit`,
      doneWork: [edit],
      queue: [],
    });
    turn.pushChild(edit);
    plexus.root.head = turn;
    const face = workCellFace(edit, "e", false, false);
    const node = workDisclosure(face, 40);
    expect({
      state: face.state,
      status: face.status,
      type: node.type,
      gutter: indicationOf(node)?.gutter,
      receipt: face.receipt,
    }).toEqual({
      state: "ask",
      status: "",
      type: "box",
      gutter: { kind: "top", glyph: SIGIL_ASK },
      receipt: { kind: "diff", old: "a", new: "b", path: "a.ts" },
    });
    plexus.destroy();
  });

  it("classifier evaluation takes the spinner seat, not a mark beside the description", () => {
    const plexus = SessionPlexus.create("s", "/tmp/p");
    plexus.root.permissionMode = "auto";
    const shell = new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl x", description: "Fetch the index" }),
      policyResult: "ask",
    });
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`fetch`,
      permissionMode: "auto",
      doneWork: [shell],
      queue: [],
    });
    turn.pushChild(shell);
    plexus.root.head = turn;
    const face = workCellFace(shell, "sh", false, true);
    const node = workDisclosure(face, 40);
    const painted = JSON.stringify(node);
    expect({
      state: face.state,
      gutter: indicationOf(node)?.gutter,
      caption: face.caption,
      markBeside: painted.includes("Fetch the index?"),
    }).toEqual({
      state: "judging",
      gutter: { kind: "top", glyph: SIGIL_JUDGE },
      caption: "Fetch the index",
      markBeside: false,
    });
    plexus.destroy();
  });

  it.each([
    {
      name: "read",
      job: () =>
        new SystemToolJob({
          toolCallId: "r",
          name: "read_file",
          argsJson: '{"path":"src/tea.ts"}',
          policyResult: "ask",
        }),
      want: { pinWorth: false },
    },
    {
      name: "grep",
      job: () =>
        new SystemToolJob({
          toolCallId: "g",
          name: "grep",
          argsJson: '{"pattern":"TODO"}',
          policyResult: "ask",
        }),
      want: { pinWorth: false },
    },
    {
      name: "shell",
      job: () =>
        new SystemToolJob({
          toolCallId: "s",
          name: "shell",
          argsJson: '{"command":"ls"}',
          policyResult: "ask",
        }),
      want: { pinWorth: false },
    },
    {
      name: "multiline shell",
      job: () =>
        new SystemToolJob({
          toolCallId: "s2",
          name: "shell",
          argsJson: '{"command":"ls\\necho hi"}',
          policyResult: "ask",
        }),
      want: { pinWorth: false, receipt: { kind: "none" } },
    },
    {
      name: "agent",
      job: () =>
        new AgentCallJob({
          toolCallId: "a",
          name: "agent__ask",
          argsJson: '{"spec":"explore","message":"map the tui"}',
        }),
      want: { pinWorth: false },
    },
    {
      name: "mcp get",
      job: () =>
        new MCPToolJob({
          toolCallId: "g",
          name: "mcp__gmail__Gmail_GetEmail",
          connectionKey: "gmail",
          serverToolName: "Gmail_GetEmail",
          argsJson: '{"email_id":"18c2a1b0f3e4d5c6"}',
          policyResult: "ask",
          expectation: new McpToolExpectation({
            connectionId: "gmail",
            serverToolName: "Gmail_GetEmail",
            argsJson: '{"email_id":"18c2a1b0f3e4d5c6"}',
          }),
        }),
      want: {
        pinWorth: false,
        split: true,
        rimNamed: true,
        name: "Gmail",
        object: "get email",
        receipt: { kind: "none" },
      },
    },
    {
      name: "mcp list",
      job: () =>
        new MCPToolJob({
          toolCallId: "a",
          name: "mcp__gmail__Arcade_ListApps",
          connectionKey: "gmail",
          serverToolName: "Arcade_ListApps",
          argsJson: "{}",
          policyResult: "ask",
          expectation: new McpToolExpectation({
            connectionId: "gmail",
            serverToolName: "Arcade_ListApps",
            argsJson: "{}",
          }),
        }),
      want: { pinWorth: false, rimNamed: true, receipt: { kind: "none" } },
    },
  ])("askPinWorthPainting by kind: $name", ({ job, want }) => {
    const face = workCellFace(job(), "ask", false, false);
    expect({
      pinWorth: askPinWorthPainting(face),
      split: face.split,
      rimNamed: face.rimNamed,
      name: face.name,
      object: face.object,
      receipt: face.receipt,
    }).toMatchObject(want);
  });

  it("expanded agent wraps the spawn prompt and paints model", () => {
    const job = new AgentCallJob({
      toolCallId: "a",
      name: "agent__ask",
      argsJson: JSON.stringify({
        spec: "explore",
        message: "Read-only investigation: user wants understand color model and prominence, then audit pastel themes.",
      }),
    });
    const face = workCellFace(job, "a", false, false, { status: "active", model: "Claude Haiku" });
    const rows = rasterLayout(workDisclosure(face, 40), 40, 12);
    const text = rows.join("\n");
    expect({
      explore: text.includes("explore"),
      active: text.includes("active"),
      prompt: text.includes("Read-only investigation") && text.includes("pastel themes"),
      model: text.includes("Claude Haiku"),
      oneLine: text.includes(
        "Read-only investigation: user wants understand color model and prominence, then audit pastel themes.",
      ),
      ellipsis: rows.some((row) => row.includes("Read-only") && row.includes("…")),
    }).toEqual({
      explore: true,
      active: true,
      prompt: true,
      model: true,
      oneLine: false,
      ellipsis: false,
    });
  });

  it("applying comment rides identity status", () => {
    const applying = new SystemToolJob({
      toolCallId: "e2",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "b.ts",
        old_string: "a\n",
        new_string: "b\n",
      }),
      humanApprove: true,
      approvalComment: "keep the export",
    });
    const live = workCellFace(applying, "e2", false, true);
    expect({
      state: live.state,
      status: live.status,
      gutter: indicationOf(workDisclosure(live, 40))?.gutter,
    }).toEqual({
      state: "live",
      status: expect.stringContaining("keep the export"),
      gutter: { kind: "spinner", profile: "tool", rows: "top" },
    });
  });

  it("policy and judge votes stay off the identity; allow is not a word", () => {
    const deny = new SystemToolJob({
      toolCallId: "r",
      name: "read_file",
      argsJson: '{"path":"../README.md"}',
      policyResult: "deny",
      outcomeJson: '{"ok":true,"text":"# hi"}',
      completed: true,
    });
    const denyStatus = workCellFace(deny, "r", false, true).status;
    const allow = new SystemToolJob({
      toolCallId: "r",
      name: "read_file",
      argsJson: '{"path":"a.ts"}',
      policyResult: "policyApprove",
      classifierResult: "allow",
      outcomeJson: '{"ok":true,"text":"hi"}',
      completed: true,
    });
    const allowFace = workCellFace(allow, "r", false, true);
    expect({
      deny: denyStatus,
      allow: {
        state: allowFace.state,
        status: allowFace.status,
        askGlyph: indicationOf(workDisclosure(allowFace, 40))?.gutter?.glyph === SIGIL_ASK,
      },
    }).toEqual({
      deny: expect.not.stringMatching(/\b(deny|block|ask|allow)\b/),
      allow: {
        state: "ok",
        status: expect.not.stringMatching(/\b(deny|block|ask|allow)\b/),
        askGlyph: false,
      },
    });
  });

  it("live shell has no invented stream; tail paints the last frame", () => {
    const plexus = SessionPlexus.create("shell-live-tail", "/tmp/p");
    const shell = new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: '{"command":"ls"}',
    });
    plexus.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      doneWork: [shell],
      queue: [],
    });
    const live = workCellFace(shell, "sh", false);
    const liveNode = workDisclosure(live, 40);
    reportShellTail(shell, { text: "\u001b[31mFAIL\u001b[0m src/foo.test.ts\nError: boom", totalBytes: 40_000 });
    const tailed = workCellFace(shell, "sh", false);
    const tailNode = workDisclosure(tailed, 40);
    expect({
      live: {
        receipt: live.receipt,
        gutter: indicationOf(liveNode)?.gutter,
      },
      turnTail: {
        receipt: tailed.receipt,
        gutter: indicationOf(tailNode)?.gutter,
        key: hasKey(tailNode, "sh:tail"),
        collapsed: tailNode.type === "disclosure" ? tailNode.collapsed : undefined,
        leftover: JSON.stringify(tailNode).includes("[31m") || JSON.stringify(tailNode).includes("\\u001b"),
        fail: tailed.receipt.kind === "stream" && tailed.receipt.text.includes("FAIL"),
      },
    }).toEqual({
      live: {
        receipt: { kind: "none" },
        gutter: { kind: "spinner", profile: "tool", rows: "top" },
      },
      turnTail: {
        receipt: { kind: "stream", text: "\u001b[31mFAIL\u001b[0m src/foo.test.ts\nError: boom" },
        gutter: { kind: "spinner", profile: "tool", rows: "top" },
        key: true,
        collapsed: false,
        leftover: false,
        fail: true,
      },
    });
    plexus.destroy();
  });

  it("expanded sealed work keeps the identity sigil; extra body is a quarter-block rule", () => {
    const ok = new SystemToolJob({
      toolCallId: "rf",
      name: "grep",
      argsJson: '{"pattern":"openTea","path":"src"}',
      outcomeJson: '{"ok":true,"text":"src/tea.ts:1:export function openTea() {}"}',
      completed: true,
    });
    const fail = new SystemToolJob({
      toolCallId: "rf-fail",
      name: "grep",
      argsJson: '{"pattern":"openTea","path":"src"}',
      outcomeJson: '{"ok":false,"text":"missing"}',
      completed: true,
    });
    const okOpen = workDisclosure(workCellFace(ok, "rf", false, false), 40);
    const failOpen = workDisclosure(workCellFace(fail, "rf-fail", false, false), 40);
    const okBar = extraIndicationOf(okOpen);
    const failBar = extraIndicationOf(failOpen);
    expect({
      ok: {
        identity: indicationOf(okOpen)?.gutter,
        extra: { gutter: okBar?.gutter, role: okBar?.style?.role, prominence: okBar?.style?.prominence },
      },
      fail: {
        identity: indicationOf(failOpen)?.gutter,
        identityRole: indicationOf(failOpen)?.style?.role,
        extra: { gutter: failBar?.gutter, role: failBar?.style?.role, prominence: failBar?.style?.prominence },
      },
      collapsed: indicationOf(workDisclosure(workCellFace(ok, "rf", false, true), 40))?.gutter,
    }).toEqual({
      ok: {
        identity: { kind: "top", glyph: SIGIL_TOOL },
        extra: {
          gutter: { kind: "rule", glyph: INDICATION_EXPAND_GLYPH },
          role: "foreground",
          prominence: FgP.ghost,
        },
      },
      fail: {
        identity: { kind: "top", glyph: SIGIL_TOOL },
        identityRole: "error",
        extra: {
          gutter: { kind: "rule", glyph: INDICATION_EXPAND_GLYPH },
          role: "error",
          prominence: FgP.ghost,
        },
      },
      collapsed: { kind: "top", glyph: SIGIL_TOOL },
    });
  });

  it("fail is a red gutter, not a red identity", () => {
    const tool = new SystemToolJob({
      toolCallId: "rf",
      name: "grep",
      argsJson: '{"pattern":"openTea"}',
      outcomeJson: '{"ok":false,"text":"missing"}',
      completed: true,
    });
    const node = workDisclosure(workCellFace(tool, "rf", false, true), 40);
    const identity = indicationOf(node);
    const text = identity?.children?.[0] as { style?: { role?: string; prominence?: number } } | undefined;
    const mcp = new MCPToolJob({
      toolCallId: "m",
      name: "mcp__mail__search",
      connectionKey: "mail",
      serverToolName: "search",
      argsJson: "{}",
      outcomeJson: '{"ok":false,"text":"timeout"}',
      completed: true,
      expectation: new McpToolExpectation({
        connectionId: "mail",
        serverToolName: "search",
        argsJson: "{}",
      }),
    });
    const mcpNode = workDisclosure(workCellFace(mcp, "m", false, true), 40);
    const mcpIdentity = indicationOf(mcpNode);
    const mcpLine = mcpIdentity?.children?.[0];
    expect({
      tool: {
        type: node.type,
        gutter: identity?.gutter,
        role: identity?.style?.role,
        text: text?.style,
      },
      mcp: {
        gutter: mcpIdentity?.gutter,
        role: mcpIdentity?.style?.role,
        lineError: JSON.stringify(mcpLine).includes('"role":"error"'),
        ghost: JSON.stringify(mcpLine).includes(`"prominence":${FgP.ghost}`),
        rising: JSON.stringify(mcpLine).includes(`"prominence":${FgP.rising}`),
      },
    }).toEqual({
      tool: {
        type: "disclosure",
        gutter: { kind: "top", glyph: SIGIL_TOOL },
        role: "error",
        text: { role: "foreground", prominence: FgP.rising },
      },
      mcp: {
        gutter: { kind: "top", glyph: SIGIL_TOOL },
        role: "error",
        lineError: false,
        ghost: true,
        rising: true,
      },
    });
  });

  it("shell identity omits exit and policy votes; fail is the gutter", () => {
    const ok = workCellFace(sealedShell({}), "sh", false, false);
    const fail = workCellFace(sealedShell({ exitCode: 1, ok: false }), "sh", false, false);
    const allowed = new SystemToolJob({
      toolCallId: "sh-allow",
      name: "shell",
      argsJson: '{"command":"ls"}',
      policyResult: "policyApprove",
      classifierResult: "allow",
      outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":"","stderr":""}}',
      completed: true,
    });
    const failNode = workDisclosure(fail, 40);
    expect({
      okStatus: ok.status,
      failStatus: fail.status,
      allowStatus: workCellFace(allowed, "sh-allow", false, true).status,
      okGutter: indicationOf(workDisclosure(ok, 40))?.gutter,
      fail: {
        type: failNode.type === "disclosure" ? failNode.summary : undefined,
      },
    }).toMatchObject({
      okStatus: expect.not.stringMatching(/\bexit\b/),
      failStatus: expect.not.stringMatching(/\bexit\b/),
      allowStatus: expect.not.stringContaining("allow"),
      okGutter: { kind: "top", glyph: SIGIL_SHELL },
      fail: {
        type: {
          type: "indication",
          gutter: { kind: "top", glyph: SIGIL_SHELL },
          style: { role: "error" },
        },
      },
    });
  });

  it("write_file and edit_file caption sits to the right of the path; wraps when tight", () => {
    const write = new SystemToolJob({
      toolCallId: "w",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: "hi", description: "Add a greeting" }),
      outcomeJson: '{"ok":true,"text":"wrote"}',
      completed: true,
    });
    const writeFace = workCellFace(write, "w", false, true);
    const writeNode = workDisclosure(writeFace, 40);
    const edit = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({
        path: "src/hello.ts",
        old_string: "a",
        new_string: "b",
        description: "Rename the export",
      }),
      outcomeJson: '{"ok":true}',
      completed: true,
    });
    const editFace = workCellFace(edit, "e", false, true);
    expect({
      write: {
        caption: writeFace.caption,
        object: writeFace.object,
        receipt: writeFace.receipt.kind,
        between: hasStyle(writeNode, "justifyContent", "space_between"),
      },
      edit: {
        caption: editFace.caption,
        statusPlus: editFace.status.includes("+"),
        between: hasStyle(workDisclosure(editFace, 40), "justifyContent", "space_between"),
        tight: hasStyle(workDisclosure(editFace, 18), "direction", "column"),
      },
    }).toEqual({
      write: { caption: "Add a greeting", object: "a.ts", receipt: "diff", between: true },
      edit: { caption: "Rename the export", statusPlus: false, between: true, tight: true },
    });
  });

  it("shell expand boxes output square and wraps at the column", () => {
    const stdout = "x".repeat(40);
    const job = new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: '{"command":"git status --short"}',
      outcomeJson: JSON.stringify({ ok: true, value: { exitCode: 0, stdout, stderr: "" } }),
      completed: true,
    });
    const node = workDisclosure(workCellFace(job, "sh", false, false), 24);
    const rows = rasterLayout(node, 24, 16);
    const joined = rows.join("\n");
    const xRows = rows.map((row) => row.replaceAll(/[^x]/g, "")).filter((row) => row.length > 0);
    expect({
      square: joined.includes("┌") && joined.includes("└") && !joined.includes("╭"),
      cmd: joined.includes("git"),
      wrapped: xRows.length > 1 && xRows.every((row) => row.length <= 21),
    }).toEqual({ square: true, cmd: true, wrapped: true });
  });

  it("shell cwd is the line after the call, not a right column", () => {
    const command = "node --input-type=module -e '\nimport { readFileSync } from \"node:fs\";'";
    const cwd = "packages/harness-yjs-server";
    const token = "./packages/harness-yjs-server";
    const shell = (description?: string, collapsed = false) =>
      workDisclosure(
        workCellFace(
          new SystemToolJob({
            toolCallId: "sh",
            name: "shell",
            argsJson: JSON.stringify({
              command,
              cwd,
              ...(description === undefined ? {} : { description }),
            }),
            outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":"","stderr":""}}',
            completed: true,
          }),
          "sh",
          false,
          collapsed,
        ),
        72,
      );
    const bare = rasterLayout(shell(), 72, 8);
    const nodeAt = bare.findIndex((row) => row.includes("node"));
    const importAt = bare.findIndex((row) => row.includes("readFileSync"));
    const cwdAt = bare.findIndex((row) => row.includes(token));
    const caption = "Test when a state vector sees the whole update";
    const collapsed = rasterLayout(shell(caption, true), 72, 6);
    const open = rasterLayout(shell(caption, false), 72, 12);
    const collapsedCaption = collapsed.findIndex((row) => row.includes("state vector"));
    const collapsedCwd = collapsed.findIndex((row) => row.includes(token));
    const openCaption = open.findIndex((row) => row.includes("state vector"));
    const openNode = open.findIndex((row) => row.includes("node"));
    const openImport = open.findIndex((row) => row.includes("readFileSync"));
    const openCwd = open.findIndex((row) => row.includes(token));
    expect({
      bare: { nodeAt, importAt, cwdAt, nodeShares: bare[nodeAt]?.includes(token) ?? true },
      collapsed: {
        caption: collapsedCaption,
        cwd: collapsedCwd,
        shares: collapsed[collapsedCaption]?.includes(token) ?? true,
      },
      open: {
        caption: openCaption,
        node: openNode,
        import: openImport,
        cwd: openCwd,
        captionShares: open[openCaption]?.includes(token) ?? true,
        nodeShares: open[openNode]?.includes(token) ?? true,
      },
    }).toEqual({
      bare: { nodeAt: 0, importAt: 1, cwdAt: 2, nodeShares: false },
      collapsed: { caption: 0, cwd: 1, shares: false },
      open: {
        caption: 0,
        node: expect.any(Number),
        import: expect.any(Number),
        cwd: expect.any(Number),
        captionShares: false,
        nodeShares: false,
      },
    });
    expect(openNode).toBeGreaterThan(openCaption);
    expect(openImport).toBeGreaterThan(openNode);
    expect(openCwd).toBeGreaterThan(openImport);
    expect(open.filter((row) => row.includes(token))).toHaveLength(1);
    expect(collapsed.filter((row) => row.includes(token))).toHaveLength(1);
    expect(bare.filter((row) => row.includes(token))).toHaveLength(1);
  });

  it("shell disclosure: caption is collapsed identity; multiline command is on expand", async () => {
    const command = "if true;then echo x; echo y;fi";
    const formatted = await formatShellCommandReady(command);
    const multi = new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: JSON.stringify({ command, description: "Run a tiny if" }),
      outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":"","stderr":""}}',
      completed: true,
    });
    const multiFace = workCellFace(multi, "sh", false, false);
    const multiNode = workDisclosure(multiFace, 40);
    const captioned = new SystemToolJob({
      toolCallId: "sh",
      name: "shell",
      argsJson: JSON.stringify({ command: "git status --short", description: "Show working tree status" }),
      outcomeJson: '{"ok":true,"value":{"exitCode":0,"stdout":" M a.ts","stderr":""}}',
      completed: true,
    });
    const face = workCellFace(captioned, "sh", false, true);
    const collapsed = workDisclosure(face, 40);
    const summary = collapsed.type === "disclosure" ? collapsed.summary : undefined;
    const children = collapsed.type === "disclosure" ? collapsed.children : undefined;
    expect({
      multi: {
        object: multiFace.object,
        script: hasKey(multiNode, "sh:script"),
        column: hasStyle(multiNode, "direction", "column"),
      },
      captioned: {
        caption: face.caption,
        object: face.object,
        type: collapsed.type,
        summaryCaption: JSON.stringify(summary).includes("Show working tree status"),
        summaryCommand: JSON.stringify(summary).includes("git status"),
        childrenCommand: JSON.stringify(children).includes("git status --short"),
      },
    }).toEqual({
      multi: { object: formatted, script: true, column: true },
      captioned: {
        caption: "Show working tree status",
        object: "git status --short",
        type: "disclosure",
        summaryCaption: true,
        summaryCommand: false,
        childrenCommand: true,
      },
    });
  });

  it("scheme disclosure: caption is collapsed identity; sugarcoat stays a syntax block", () => {
    const bag = new ProgrammaticJob({
      toolCallId: "p",
      argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "Add one and two" }),
      outcomeJson: '{"ok":true,"value":["3"]}',
      completed: true,
    });
    const collapsed = workDisclosure(workCellFace(bag, "p", false, true), 40);
    const summary = collapsed.type === "disclosure" ? collapsed.summary : undefined;
    const children = collapsed.type === "disclosure" ? collapsed.children : undefined;
    const define = new ProgrammaticJob({
      toolCallId: "p",
      argsJson: JSON.stringify({ expr: "(define (double n) (* n 2))" }),
      outcomeJson: '{"ok":true,"value":[]}',
      completed: true,
    });
    const defineFace = workCellFace(define, "p", false, true);
    const defineFolded = workDisclosure(defineFace, 40);
    const defineSummary = defineFolded.type === "disclosure" ? defineFolded.summary : undefined;
    const defineChildren = defineFolded.type === "disclosure" ? defineFolded.children : undefined;
    const watch = new ProgrammaticJob({
      toolCallId: "w",
      toolName: "scheme_watch",
      argsJson: JSON.stringify({ expr: "(+ 1 2)", description: "Watch the sum", period: "1 minutes" }),
      outcomeJson: '{"ok":true,"value":[]}',
      completed: true,
    });
    const watchFolded = workDisclosure(workCellFace(watch, "w", false, true), 40);
    const watchSummary = watchFolded.type === "disclosure" ? watchFolded.summary : undefined;
    const watchChildren = watchFolded.type === "disclosure" ? watchFolded.children : undefined;
    expect({
      captioned: {
        summaryCaption: JSON.stringify(summary).includes("Add one and two"),
        summaryExpr: JSON.stringify(summary).includes("{1 + 2}"),
        script: hasKey(children, "p:script"),
        glyph: indicationOf(summary)?.gutter,
      },
      define: {
        object: defineFace.object,
        caption: defineFace.caption,
        summaryCaption: JSON.stringify(defineSummary).includes("scheme_repl"),
        summaryProgram: JSON.stringify(defineSummary).includes("define"),
        script: hasKey(defineChildren, "p:script"),
      },
      watch: {
        summaryCaption: JSON.stringify(watchSummary).includes("Watch the sum"),
        summaryExpr: JSON.stringify(watchSummary).includes("{1 + 2}"),
        summaryName: JSON.stringify(watchSummary).includes("scheme_watch"),
        script: hasKey(watchChildren, "w:script"),
        glyph: indicationOf(watchSummary)?.gutter,
      },
    }).toEqual({
      captioned: {
        summaryCaption: true,
        summaryExpr: false,
        script: true,
        glyph: { kind: "top", glyph: SIGIL_SCHEME_REPL },
      },
      define: {
        object: "define (double n)\n  {n * 2}",
        caption: "",
        summaryCaption: false,
        summaryProgram: true,
        script: false,
      },
      watch: {
        summaryCaption: true,
        summaryExpr: false,
        summaryName: false,
        script: true,
        glyph: { kind: "top", glyph: SIGIL_SCHEME_WATCH },
      },
    });
  });

  it("sealed shell ANSI is theme ink, not control glyphs", () => {
    const face = workCellFace(
      sealedShell({ stdout: "\u001b[31mred\u001b[0m\n\u001b[32mgo\u001b[0m" }),
      "sh",
      false,
      false,
    );
    const node = workDisclosure(face, 40);
    const spans: { content?: string; fgRgb?: unknown }[] = [];
    const walk = (cur: unknown): void => {
      if (typeof cur !== "object" || cur === null) return;
      const rec = cur as { content?: unknown; style?: { fgRgb?: unknown }; children?: unknown[]; summary?: unknown };
      if (typeof rec.content === "string") spans.push({ content: rec.content, fgRgb: rec.style?.fgRgb });
      if (rec.summary !== undefined) walk(rec.summary);
      if (Array.isArray(rec.children)) {
        for (const child of rec.children) walk(child);
      }
    };
    walk(node);
    expect({
      kind: face.receipt.kind,
      leftover: spans.some((span) => (span.content ?? "").includes("\u001b") || (span.content ?? "").includes("[31m")),
      red: spans.some((span) => span.content === "red" && span.fgRgb != null),
      go: spans.some((span) => span.content === "go" && span.fgRgb != null),
    }).toEqual({
      kind: "text",
      leftover: false,
      red: true,
      go: true,
    });
  });

  it("shell receipt is the command output or the policy explanation", () => {
    const advice = "The command downloads over HTTP. Use HTTPS.";
    const warn = new SystemToolJob({
      toolCallId: "policy-ask",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl http://example.com/file" }),
      policyResult: "ask",
    });
    warn.policyMessage = advice;
    const blocked = new SystemToolJob({
      toolCallId: "policy-block",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl http://example.com/file" }),
      policyResult: "block",
      completed: true,
    });
    blocked.policyMessage = advice;
    const stamped = new SystemToolJob({
      toolCallId: "policy-stamped",
      name: "shell",
      argsJson: JSON.stringify({ command: "curl http://example.com/file" }),
      policyResult: "block",
      outcomeJson: JSON.stringify({ ok: false, text: advice, code: "policy_denied" }),
      completed: true,
    });
    stamped.policyMessage = advice;
    const ran = workCellFace(
      sealedShell({
        policyMessage: advice,
        stdout: "hi",
      }),
      "sh",
      false,
      false,
    );
    const deniedEdit = new SystemToolJob({
      toolCallId: "policy-edit",
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "a", new_string: "b" }),
      policyResult: "block",
      outcomeJson: JSON.stringify({ ok: false, text: advice, code: "policy_denied" }),
      completed: true,
    });
    deniedEdit.policyMessage = advice;
    const stampedFace = workCellFace(stamped, "policy", false, false);
    const stampedNode = workDisclosure(stampedFace, 80);
    const painted: string[] = [];
    const walk = (cur: unknown): void => {
      if (typeof cur !== "object" || cur === null) return;
      const rec = cur as { content?: unknown; text?: unknown; children?: unknown[]; summary?: unknown };
      if (typeof rec.content === "string") painted.push(rec.content);
      if (typeof rec.text === "string") painted.push(rec.text);
      if (rec.summary !== undefined) walk(rec.summary);
      if (Array.isArray(rec.children)) {
        for (const child of rec.children) walk(child);
      }
    };
    walk(stampedNode);
    const adviceCopies = painted.filter((text) => text.includes("Use HTTPS."));
    expect({
      ask: workCellFace(warn, "policy", false, false).receipt,
      blocked: receiptPlainText(workCellFace(blocked, "policy", false, false).receipt),
      stamped: receiptPlainText(stampedFace.receipt),
      copies: adviceCopies.length,
      outputBox: hasKey(stampedNode, `${stampedFace.key}:out-box`),
      ran: ran.receipt,
      edit: workCellFace(deniedEdit, "policy", false, false).receipt,
    }).toEqual({
      ask: { kind: "text", text: advice },
      blocked: advice,
      stamped: advice,
      copies: 1,
      outputBox: false,
      ran: { kind: "text", text: "hi" },
      edit: { kind: "text", text: advice },
    });
  });

  it("scheme bag yields heartbeat to an open inner", () => {
    const outer = new ProgrammaticJob({
      toolCallId: "call_repl",
      argsJson: '{"expr":"(read_file :path \\"src/tea.ts\\")"}',
    });
    const empty = workCellFace(outer, "s", false);
    const inner = new SystemToolJob({
      toolCallId: "call_inner",
      name: "read_file",
      argsJson: '{"path":"src/tea.ts"}',
    });
    outer.pushInvocation(inner);
    const yielded = workCellFace(outer, "s", false);
    inner.policyResult = "ask";
    const asked = workCellFace(outer, "s", false);
    inner.policyResult = null;
    inner.receiptJson = '{"ok":true,"text":"export const Tea"}';
    inner.completed = true;
    const waiting = workCellFace(outer, "s", false);
    outer.receiptJson = '{"ok":true,"value":["hello\\nworld", true]}';
    outer.completed = true;
    const sealed = workCellFace(outer, "s", false, false);
    const sealedNode = workDisclosure(sealed, 40);
    expect({
      empty: {
        state: empty.state,
        receipt: empty.receipt.kind,
        spinner: indicationOf(workDisclosure(empty, 40))?.gutter?.kind === "spinner",
      },
      yielded: {
        state: yielded.state,
        receipt: yielded.receipt.kind,
        spinner: indicationOf(workDisclosure(yielded, 40))?.gutter?.kind === "spinner",
      },
      asked: {
        state: asked.state,
        receipt: asked.receipt.kind,
        spinner: indicationOf(workDisclosure(asked, 40))?.gutter?.kind === "spinner",
      },
      waiting: {
        state: waiting.state,
        receipt: waiting.receipt.kind,
        spinner: indicationOf(workDisclosure(waiting, 40))?.gutter?.kind === "spinner",
      },
      sealed: {
        state: sealed.state,
        receipt: sealed.receipt,
        eval: textsOf(sealedNode).join("\n").includes("eval `"),
        code: hasRole(sealedNode, "code"),
      },
    }).toEqual({
      empty: { state: "live", receipt: "none", spinner: true },
      yielded: { state: "ok", receipt: "none", spinner: false },
      asked: { state: "ok", receipt: "none", spinner: false },
      waiting: { state: "live", receipt: "none", spinner: true },
      sealed: {
        state: "ok",
        receipt: {
          kind: "parts",
          parts: [
            { kind: "text", text: "hello\nworld" },
            { kind: "boolean", text: "#t" },
          ],
        },
        eval: false,
        code: true,
      },
    });
  });

  function bodyStyle(node: unknown): { role?: string } {
    const hits: { role?: string }[] = [];
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      const rec = value as { key?: unknown; style?: { role?: string }; children?: unknown[] };
      if (typeof rec.key === "string" && rec.key.includes(":body")) {
        hits.push({ role: rec.style?.role });
      }
      if (Array.isArray(rec.children)) {
        for (const child of rec.children) walk(child);
      }
    };
    walk(node);
    return hits.find((hit) => hit.role !== undefined) ?? hits[0] ?? {};
  }

  it("scheme result paint follows the value's kind", () => {
    const painted = (value: unknown) => {
      const job = new ProgrammaticJob({
        toolCallId: "s",
        argsJson: '{"expr":"x"}',
        outcomeJson: JSON.stringify({ ok: true, value }),
        completed: true,
      });
      const face = workCellFace(job, "s", false, false);
      return { kind: face.receipt.kind, body: bodyStyle(workDisclosure(face, 40)) };
    };
    const md = painted(["# Harness\n**bold**"]);
    const fileMd = painted([{ text: "# Harness\n**bold**", face: { kind: "file", path: "README.md" } }]);
    const fileTs = painted([{ text: "export const Tea", face: { kind: "file", path: "src/tea.ts" } }]);
    const hinted = (() => {
      const inner = new SystemToolJob({
        toolCallId: "r",
        name: "read_file",
        argsJson: '{"path":"README.md"}',
        outcomeJson: '{"ok":true,"text":"# Harness\\n**bold**"}',
        completed: true,
      });
      const job = new ProgrammaticJob({
        toolCallId: "s",
        argsJson: '{"expr":"(read_file \\"README.md\\")"}',
        outcomeJson: '{"ok":true,"value":["# Harness\\n**bold**"]}',
        completed: true,
      });
      job.pushInvocation(inner);
      return workCellFace(job, "s", false, false).receipt.kind;
    })();
    const num = painted([3]);
    const bool = painted([true]);
    const struct = painted([[1, 2]]);
    expect({
      md: { kind: md.kind, role: md.body.role },
      fileMd: fileMd.kind,
      hinted,
      fileTs: { kind: fileTs.kind, role: fileTs.body.role },
      num: { kind: num.kind, role: num.body.role },
      bool: { kind: bool.kind, role: bool.body.role },
      struct: { kind: struct.kind, role: struct.body.role },
    }).toEqual({
      md: { kind: "text", role: "foreground" },
      fileMd: "markdown",
      hinted: "markdown",
      fileTs: { kind: "text", role: "foreground" },
      num: { kind: "number", role: "code" },
      bool: { kind: "boolean", role: "code" },
      struct: { kind: "syntax", role: "code" },
    });
  });

  it("mutate Diff elides distant lines; only the ask pin squeezes", () => {
    const old = Array.from({ length: 20 }, (_, i) => `keep${String(i).padStart(2, "0")}`).join("\n");
    const next = old.replace("keep10", "changed");
    const edit = new SystemToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: old, new_string: next }),
      humanApprove: true,
      completed: true,
      outcomeJson: '{"ok":true}',
    });
    const prior = `${Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
    const written = prior.replace("line-15", "line-15-edited");
    const write = new FileMutateToolJob({
      toolCallId: "ow",
      name: "write_file",
      argsJson: JSON.stringify({ path: "b.ts", content: written, overwriteExisting: true }),
      outcomeJson: '{"ok":true}',
      completed: true,
      existed: true,
      priorContent: prior,
    });
    const tape = JSON.stringify(
      expandWidgetPriors(workDisclosure(workCellFace(edit, "e", false, false), 60), {
        width: 60,
      }),
    );
    const ask = JSON.stringify(
      expandWidgetPriors(askPinNode(workCellFace(edit, "ask:e", false, false), 60), {
        width: 60,
      }),
    );
    const overwrite = JSON.stringify(
      expandWidgetPriors(workDisclosure(workCellFace(write, "ow", false, true), 40), { width: 40 }),
    );
    expect({
      tapeSqueeze: tape.includes(":squeeze"),
      tapeElide: tape.includes("unchanged"),
      tapeFar: tape.includes("keep00"),
      askSqueeze: ask.includes(":squeeze"),
      askElide: ask.includes("unchanged"),
      write: {
        edited: overwrite.includes("line-15-edited"),
        far: overwrite.includes("line-00"),
        elide: overwrite.includes("unchanged"),
      },
    }).toEqual({
      tapeSqueeze: false,
      tapeElide: true,
      tapeFar: false,
      askSqueeze: true,
      askElide: true,
      write: { edited: true, far: false, elide: true },
    });
  });

  it("scheme bag never fuses; nested inners stay visible; floor-allow fuses only when hideFloorTools", () => {
    const scheme = new ProgrammaticJob({
      toolCallId: "repl",
      argsJson: '{"expr":"(glob)","description":"list ts files"}',
    });
    const glob = new SystemToolJob({
      toolCallId: "g",
      name: "glob",
      argsJson: '{"pattern":"**/*.ts"}',
      policyResult: "policyApprove",
    });
    scheme.pushInvocation(glob);
    const agent = new AgentCallJob({
      toolCallId: "a",
      name: "agent__ask",
      argsJson: '{"spec":"explore","message":"map"}',
    });
    expect({
      bag: workCellFuse(scheme, false, true),
      inner: workCellFuse(glob, true, true),
      shown: workCellFuse(glob),
      hidden: workCellFuse(glob, false, true),
      agent: workCellFuse(agent),
    }).toEqual({
      bag: false,
      inner: false,
      shown: false,
      hidden: true,
      agent: true,
    });
  });
});

describe("a mutation whose prior text is held in a blob", () => {
  const sha256 = "e".repeat(64);
  const file = `${Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n")}\n`;
  const edited = file.replace("line-15", "line-15-edited");
  const priorBlobJson = storedBlobJson({ sha256, bytes: file.length, mime: "text/plain", head: file.slice(0, 64) });

  /** The cache holds what the test gives it, and remembers what it was asked for, once each like the real one. */
  function cache(texts: Record<string, string> = {}): BlobPeek & { readonly wanted: string[] } {
    const wanted: string[] = [];
    return {
      wanted,
      peek: (hash) => texts[hash] ?? null,
      want: (hash) => {
        if (!wanted.includes(hash)) wanted.push(hash);
      },
    };
  }

  const edit = (fields: { readonly policyResult?: "ask" } = {}) =>
    new FileMutateToolJob({
      toolCallId: "e",
      name: "edit_file",
      argsJson: JSON.stringify({ path: "a.ts", old_string: "line-15", new_string: "line-15-edited" }),
      priorBlobJson,
      priorLineStart: 16,
      existed: true,
      ...(fields.policyResult === undefined ? { outcomeJson: '{"ok":true}', completed: true } : fields),
    });
  const overwrite = () =>
    new FileMutateToolJob({
      toolCallId: "ow",
      name: "write_file",
      argsJson: JSON.stringify({ path: "a.ts", content: edited, overwriteExisting: true }),
      priorBlobJson,
      existed: true,
      outcomeJson: '{"ok":true,"text":"replaced a.ts"}',
      completed: true,
    });
  const rows = (face: ReturnType<typeof workCellFace>) =>
    JSON.stringify(expandWidgetPriors(workDisclosure(face, 60), { width: 60 }));

  it("paints a cache that does not hold the text as a replica without the prior would, and asks for it", () => {
    const empty = cache();
    const face = workCellFace(edit(), "e", false, true, "", undefined, empty);
    const painted = rows(face);
    expect({
      receipt: face.receipt,
      wanted: empty.wanted,
      span: painted.includes("line-15-edited"),
      around: painted.includes("line-14") || painted.includes("line-16"),
      elided: painted.includes("unchanged"),
    }).toEqual({
      receipt: { kind: "diff", old: "line-15", new: "line-15-edited", path: "a.ts", lineStart: 16 },
      wanted: [sha256],
      span: true,
      around: false,
      elided: false,
    });
  });

  it("paints a cache that holds the text as the diff against the whole file", () => {
    const held = cache({ [sha256]: file });
    const face = workCellFace(edit(), "e", false, true, "", undefined, held);
    const painted = rows(face);
    expect({
      receipt: face.receipt,
      wanted: held.wanted,
      span: painted.includes("line-15-edited"),
      around: painted.includes("line-14") && painted.includes("line-16"),
      elided: painted.includes("unchanged"),
      far: painted.includes("line-00"),
    }).toEqual({
      receipt: { kind: "diff", old: file, new: edited, path: "a.ts" },
      wanted: [],
      span: true,
      around: true,
      elided: true,
      far: false,
    });
  });

  it("paints an overwrite as no diff until the text lands, and against the old file after", () => {
    const empty = cache();
    const bare = workCellFace(overwrite(), "ow", false, true, "", undefined, empty);
    expect({ receipt: bare.receipt, wanted: empty.wanted }).toEqual({
      receipt: { kind: "text", text: "replaced a.ts" },
      wanted: [sha256],
    });
    const held = workCellFace(overwrite(), "ow", false, true, "", undefined, cache({ [sha256]: file }));
    expect(held.receipt).toEqual({ kind: "diff", old: file, new: edited, path: "a.ts" });
  });

  it("with no cache at all paints the replica without the prior and asks for nothing", () => {
    expect(workCellFace(edit(), "e", false, true).receipt).toEqual({
      kind: "diff",
      old: "line-15",
      new: "line-15-edited",
      path: "a.ts",
      lineStart: 16,
    });
    expect(workCellFace(overwrite(), "ow", false, true).receipt).toEqual({ kind: "text", text: "replaced a.ts" });
  });

  it("holds the ask pin to the same two faces", () => {
    const empty = cache();
    expect(askPinFace(edit({ policyResult: "ask" }), undefined, empty).receipt).toEqual({
      kind: "diff",
      old: "line-15",
      new: "line-15-edited",
      path: "a.ts",
      lineStart: 16,
    });
    expect(empty.wanted).toEqual([sha256]);
    expect(askPinFace(edit({ policyResult: "ask" }), undefined, cache({ [sha256]: file })).receipt).toEqual({
      kind: "diff",
      old: file,
      new: edited,
      path: "a.ts",
    });
  });
});
