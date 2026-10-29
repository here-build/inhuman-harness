import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import {
  SQUEEZE_COMPACT_CHARS,
  SQUEEZE_MICRO_MIN_CHARS,
  squeezeToolCall,
  toolCallRepresentation,
} from "../index.js";

function tool(text: string, extra?: { regenerateable?: boolean; name?: string }): SystemToolJob {
  return new SystemToolJob({
    toolCallId: "c1",
    name: extra?.name ?? "Write",
    argsJson: '{"path":"a.ts"}',
    outcomeJson: JSON.stringify({ ok: true, text }),
    ...(extra?.regenerateable === true ? { regenerateable: true as const } : {}),
  });
}

function homed(call: SystemToolJob, sessionId: string): SystemToolJob {
  const plexus = SessionPlexus.create(sessionId);
  onTestFinished(() => plexus.destroy());
  call.humanApprove = true;
  call.completed = true;
  plexus.root.head = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [call],
    queue: [],
  });
  return call;
}

/** The pointer names the job by uuid prefix, which differs per run. */
const POINTER = /;;full response: context_recall \{"ref":"job:[^"]+"\}/;
const pointerOf = (text: string) => text.replace(POINTER, ";;full response: {recall}");

const over = "x".repeat(SQUEEZE_COMPACT_CHARS + 50);
const atMicro = "y".repeat(SQUEEZE_MICRO_MIN_CHARS);
const below = "short-ok";
const reduced = `${over.slice(0, SQUEEZE_COMPACT_CHARS)}…(+50 chars)`;

const rows = [
  {
    name: "persistable over-budget dumps",
    sessionId: "squeeze-long",
    to: "compact" as const,
    regenerateable: false,
    body: over,
    twice: false,
    toolName: "Write",
    want: {
      squeeze: `;;full response: {recall}\n${reduced}`,
      source: over,
    },
  },
  {
    name: "regeneratable over-budget does not dump",
    sessionId: "squeeze-regen",
    to: "compact" as const,
    regenerateable: true,
    body: over,
    twice: false,
    toolName: "read_file",
    want: {
      squeeze: reduced,
      source: over,
    },
  },
  {
    name: "dump idempotent",
    sessionId: "squeeze-idem",
    to: "compact" as const,
    regenerateable: false,
    body: over,
    twice: true,
    toolName: "Write",
    want: {
      squeeze: `;;full response: {recall}\n${reduced}`,
      source: over,
    },
  },
  {
    name: "micro below threshold is identity",
    sessionId: "squeeze-micro-short",
    to: "micro" as const,
    regenerateable: false,
    body: below,
    twice: false,
    toolName: "Write",
    want: {
      squeeze: below,
      source: below,
    },
  },
  {
    name: "micro persistable at/over threshold is comment line",
    sessionId: "squeeze-micro-keep",
    to: "micro" as const,
    regenerateable: false,
    body: atMicro,
    twice: false,
    toolName: "Write",
    want: {
      squeeze: `;;full response: {recall}`,
      source: atMicro,
    },
  },
  {
    name: "micro regeneratable at/over is cleared stub",
    sessionId: "squeeze-micro-regen",
    to: "micro" as const,
    regenerateable: true,
    body: atMicro,
    twice: false,
    toolName: "read_file",
    want: {
      squeeze: "[Old read_file result content cleared]",
      source: atMicro,
    },
  },
] as const;

describe("tool call representation", () => {
  beforeEach(() => resetLocalIDs());

  it("squeeze walk: live approvalComment is not painted onto the result; persistable dumps / regeneratable does not / idempotent / micro", () => {
    const call = homed(tool("hello-from-disk"), "squeeze-note");
    call.approvalComment = "keep the export";
    const note = {
      result: toolCallRepresentation(call).result,
      squeeze: squeezeToolCall(call, "compact"),
    };
    const dumps = rows.map((row) => {
      const dumped = homed(tool(row.body, { regenerateable: row.regenerateable, name: row.toolName }), row.sessionId);
      const squeeze = squeezeToolCall(dumped, row.to);
      const second = row.twice ? squeezeToolCall(dumped, row.to) : squeeze;
      return {
        name: row.name,
        squeeze: pointerOf(squeeze),
        second: pointerOf(second),
        source: toolCallRepresentation(dumped).result,
      };
    });
    expect({ note, dumps }).toEqual({
      note: {
        result: "hello-from-disk",
        squeeze: "hello-from-disk",
      },
      dumps: rows.map((row) => ({
        name: row.name,
        squeeze: row.want.squeeze,
        second: row.want.squeeze,
        source: row.want.source,
      })),
    });
  });

  it("shell observation is VT-stripped on the wire and raw in stored outcome", () => {
    const call = homed(
      new SystemToolJob({
        toolCallId: "c1",
        name: "shell",
        argsJson: '{"command":"ls"}',
        outcomeJson: JSON.stringify({
          ok: true,
          value: { exitCode: 0, stdout: "\u001b[31mred\u001b[0m", stderr: "\u001b[31merr\u001b[0m" },
        }),
      }),
      "squeeze-vt",
    );
    const squeeze = squeezeToolCall(call, "compact");
    const painted = toolCallRepresentation(call).result;
    expect({
      stored: call.receiptJson?.includes("[31m"),
      squeezeHasRed: squeeze.includes("red"),
      squeezeHasErr: squeeze.includes("err"),
      squeezeHasEsc: squeeze.includes("\u001b") || squeeze.includes("[31m"),
      paintedHasEsc: painted.includes("\u001b") || painted.includes("[31m"),
    }).toEqual({
      stored: true,
      squeezeHasRed: true,
      squeezeHasErr: true,
      squeezeHasEsc: false,
      paintedHasEsc: false,
    });
  });
});
