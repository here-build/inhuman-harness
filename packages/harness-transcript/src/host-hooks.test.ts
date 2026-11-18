import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentCallJob,
  CompletionExpectation,
  CompletionJob,
  ProgrammaticJob,
  SessionDocument,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SuccessfulOutcome,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { defineVoiceCatalog, enVoiceCatalog, FilePreviewProvider, VoiceProvider } from "@inhuman.tools/harness-ui";
import { describe, expect, it } from "vitest";

import { TranscriptProvider, type TranscriptHost } from "./context.js";
import { schemeExprReady, schemeProgramUnwrap } from "./scheme-unwrap.js";
import { groupBeats } from "./tape-beats.js";
import { agentCell, agentFace, projectUserTurn, schemeProgramCells } from "./tape-read.js";
import { BeatTimeline, Outcome, Tape, ToolBodyView } from "./tape.js";

function baseHost(overrides: Partial<TranscriptHost> = {}): TranscriptHost {
  return {
    session: null,
    project: null,
    kernel: null,
    link: { kind: "connected" },
    attaching: false,
    requestedTarget: { kind: "kernel" },
    projects: new Map(),
    sessionRpc: null,
    peek: async () => {
      throw new Error("peek unavailable");
    },
    ...overrides,
  };
}

describe("harness-transcript host hooks and exports", () => {
  it("reads AgentCallJob.faceName as fallback spec and supports localized agentFace copy", () => {
    const withFace = new AgentCallJob({
      faceName: "Analyst",
      argsJson: JSON.stringify({ description: "Inspect the log" }),
      completed: true,
      outcome: new SuccessfulOutcome({ valueJson: JSON.stringify("ok") }),
    });
    const cellWithFace = agentCell(withFace);
    expect(cellWithFace.spec).toBe("Analyst");
    expect(agentFace(cellWithFace, null, { completedStatus: "Done" })).toMatchObject({
      name: "Analyst",
      status: "Done",
      state: "ok",
    });

    const withExplicitSpec = new AgentCallJob({
      faceName: "Analyst",
      argsJson: JSON.stringify({ spec: "Reviewer", message: "Review changes" }),
    });
    expect(agentCell(withExplicitSpec).spec).toBe("Reviewer");
  });

  it("exports schemeProgramCells and schemeProgramUnwrap with host-call and braces handling", async () => {
    const exprMapCall = '(list_tables {filter: "active"})';
    await schemeExprReady(exprMapCall);
    const unwrappedProgram = new ProgrammaticJob({
      toolCallId: "prog-unwrap",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: exprMapCall }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: ["ok"] }),
    });
    const innerList = new SystemToolJob({
      toolCallId: "inner-list",
      name: "list_tables",
      argsJson: "{}",
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: "tables" }),
    });
    unwrappedProgram.pushInvocation(innerList);

    const unwrapped = schemeProgramCells(unwrappedProgram, "/workspace");
    expect(unwrapped).toHaveLength(1);
    expect(unwrapped[0]).toMatchObject({
      kind: "tool",
      id: innerList.uuid,
      call: { name: "list_tables", genericBody: true },
    });
    expect(schemeProgramUnwrap(unwrappedProgram, unwrapped.length)).toBe(true);

    const exprMetaOnly = "(update_metadata {})";
    await schemeExprReady(exprMetaOnly);
    const metaOnlyProgram = new ProgrammaticJob({
      toolCallId: "prog-meta",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: exprMetaOnly }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: [] }),
    });
    metaOnlyProgram.pushInvocation(
      new SystemToolJob({
        toolCallId: "inner-meta",
        name: "update_metadata",
        argsJson: "{}",
        completed: true,
      }),
    );
    const metaCells = schemeProgramCells(metaOnlyProgram, "/workspace");
    expect(metaCells).toHaveLength(0);
    expect(schemeProgramUnwrap(metaOnlyProgram, metaCells.length)).toBe(false);

    const exprMixed = '(begin (custom_op "a") 42)';
    await schemeExprReady(exprMixed);
    const retainedProgram = new ProgrammaticJob({
      toolCallId: "prog-keep",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: exprMixed }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: [42] }),
    });
    retainedProgram.pushInvocation(
      new SystemToolJob({
        toolCallId: "inner-op",
        name: "custom_op",
        argsJson: JSON.stringify({ id: "a" }),
        completed: true,
        outcomeJson: JSON.stringify({ ok: true, value: "ok" }),
      }),
    );

    const retained = schemeProgramCells(retainedProgram, "/workspace");
    expect(retained).toHaveLength(1);
    expect(schemeProgramUnwrap(retainedProgram, retained.length)).toBe(false);
  });

  it("applies formatToolCall, renderAnnotation, VoiceProvider overrides, and gates GraphButton on host.workflow", () => {
    const expectation = new CompletionExpectation({ connectionId: "test" });
    expectation.responseText = "Checking now.";
    expectation.responseThought = "Need to verify tool metadata.";
    const completion = new CompletionJob({ expectation });

    const meta = new SystemToolJob({
      toolCallId: "meta-1",
      name: "update_metadata",
      argsJson: JSON.stringify({ current_turn_title: "Audit phase" }),
      completed: true,
    });
    const program = new ProgrammaticJob({
      toolCallId: "prog-1",
      toolName: "scheme_repl",
      argsJson: JSON.stringify({ expr: "(define x 1) (lookup x)", description: "Compute x" }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, value: ["raw output"] }),
    });
    const lookup = new SystemToolJob({
      toolCallId: "call-1",
      name: "lookup",
      argsJson: JSON.stringify({ query: "alpha" }),
      completed: true,
      outcomeJson: JSON.stringify({ ok: true, text: "raw tool result" }),
    });
    program.pushInvocation(lookup);

    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      queue: [],
      doneWork: [completion, meta, program],
      reducerExited: true,
    });
    for (const chunk of turn.doneWork) turn.pushChild(chunk);

    const root = new SessionRoot({ sessionId: "sess-hooks", path: "/workspace" });
    root.head = turn;
    const doc = SessionDocument.bootstrap(root);

    try {
      const voice = defineVoiceCatalog({
        ...enVoiceCatalog,
        transcript: {
          ...enVoiceCatalog.transcript,
          reasoningLabel: "Thinking notes",
          emptyResultNotice: "No output returned.",
          outcomeLiveLabel: "Running now",
          outcomeFailedLabel: "Errored",
        },
      });

      const hostWithoutWorkflow = baseHost({
        session: { root },
        formatToolCall: (call) =>
          call.name === "lookup"
            ? {
                title: "Lookup: alpha",
                subtitle: "custom subtitle",
                body: { kind: "markdown", text: "**Formatted** receipt" },
              }
            : null,
        renderAnnotation: (kind, content) => createElement("div", { "data-custom-annotation": kind }, content),
      });

      const htmlNoWorkflow = renderToStaticMarkup(
        createElement(
          VoiceProvider,
          { catalog: voice },
          createElement(
            TranscriptProvider,
            { host: hostWithoutWorkflow },
            createElement(FilePreviewProvider, { resetKey: "sess-hooks" }, createElement(Tape)),
          ),
        ),
      );

      expect(htmlNoWorkflow).toContain("Lookup: alpha");
      expect(htmlNoWorkflow).toContain('<span class="tool-subtitle">custom subtitle</span>');
      expect(htmlNoWorkflow).toContain("<strong>Formatted</strong> receipt");
      expect(htmlNoWorkflow).toContain('data-custom-annotation="progress"');
      expect(htmlNoWorkflow).toContain('data-custom-annotation="thoughts"');
      expect(htmlNoWorkflow).toContain("Thinking notes");
      expect(htmlNoWorkflow).not.toContain('class="tool-graph"');

      const hostWithWorkflow = baseHost({
        session: { root },
        workflow: () => undefined,
      });
      const htmlWithWorkflow = renderToStaticMarkup(
        createElement(
          TranscriptProvider,
          { host: hostWithWorkflow },
          createElement(FilePreviewProvider, { resetKey: "sess-hooks" }, createElement(Tape)),
        ),
      );
      expect(htmlWithWorkflow).toContain("tool-graph");

      const customReceiptHtml = renderToStaticMarkup(
        createElement(
          VoiceProvider,
          { catalog: voice },
          createElement(ToolBodyView, { body: { kind: "empty" } }),
          createElement(Outcome, { outcome: "live" }),
          createElement(Outcome, { outcome: "failed" }),
        ),
      );
      expect(customReceiptHtml).toContain("No output returned.");
      expect(customReceiptHtml).toContain('aria-label="Running now"');
      expect(customReceiptHtml).toContain("Errored");

      const emptyTurn = new SessionTurn({
        turnTail: new SessionSystemPrompt(),
        queue: [],
        doneWork: [],
        reducerExited: true,
      });
      const cells = projectUserTurn(emptyTurn, "/workspace");
      const timelineHtml = renderToStaticMarkup(
        createElement(
          TranscriptProvider,
          { host: hostWithoutWorkflow },
          createElement(BeatTimeline, { beats: groupBeats(cells), onOpen: () => undefined }),
        ),
      );
      expect(timelineHtml).not.toContain('data-custom-annotation="progress"');
    } finally {
      doc.destroy();
    }
  });
});
