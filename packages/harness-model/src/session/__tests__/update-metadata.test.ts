import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { CONTEXT_NEED_TOOL_NAME } from "../context-need.js";
import { ContextNeedToolJob } from "../jobs/ContextNeedToolJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionRoot } from "../SessionRoot.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/session-turn.js";
import {
  clampChars,
  latestUserPrompt,
  METADATA_SAME_ROUND_NOTE,
  SESSION_DESCRIPTION_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  sessionDisplayTitle,
} from "../update-metadata.js";

beforeEach(() => resetLocalIDs());

function meta(id: string, title: string, description = ""): SystemToolJob {
  return new SystemToolJob({
    triggersReactLoop: false,
    tapeHidden: true,
    toolCallId: id,
    name: "update_metadata",
    argsJson: JSON.stringify({ current_turn_title: title, current_turn_description: description }),
  });
}

function titleOf(text: string): string {
  return sessionDisplayTitle({
    manualTitle: "",
    head: new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`${text}`,
      queue: [],
    }),
  });
}

function metaTurn(argsJson: string): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`p`,
    doneWork: [
      new SystemToolJob({
        triggersReactLoop: false,
        tapeHidden: true,
        toolCallId: "m",
        name: "update_metadata",
        argsJson,
      }),
    ],
    queue: [],
  });
}

describe("update_metadata derivation", () => {
  it("a whitespace-only oldest prompt yields the title to a later prompt", () => {
    const blank = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`   `, queue: [] });
    const head = new SessionTurn({ turnTail: blank, prompt: prompt.user`fix auth`, queue: [] });
    expect(sessionDisplayTitle({ manualTitle: "", head })).toBe("fix auth");
  });

  it("clamps title and description; fallback is the first prompt line, word-bounded", () => {
    const long = "x".repeat(SESSION_TITLE_MAX_CHARS + 20);
    const desc = "d".repeat(SESSION_DESCRIPTION_MAX_CHARS + 5);
    const fallback = "please help me debug this extremely long opening prompt about auth";
    const older = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`hello`,
      queue: [],
    });
    const newest = new SessionTurn({
      turnTail: older,
      prompt: prompt.user`   `,
      queue: [],
    });
    expect({
      trimmed: metaTurn(JSON.stringify({ current_turn_title: "  Fix login  " })).metadata,
      empty: metaTurn("{}").metadata,
      garbage: metaTurn("not-json").metadata,
      titleClamp: metaTurn(JSON.stringify({ current_turn_title: long })).metadata,
      descClamp: metaTurn(JSON.stringify({ current_turn_title: "t", current_turn_description: desc })).metadata,
      graphemes: clampChars("👍👎✨", 2),
      lastPrompt: latestUserPrompt(newest),
      firstLine: titleOf("Fix the login button\nmore"),
      blank: titleOf("   "),
      wordBound: titleOf(fallback),
    }).toEqual({
      trimmed: { title: "Fix login", description: "" },
      empty: null,
      garbage: null,
      titleClamp: { title: "x".repeat(SESSION_TITLE_MAX_CHARS), description: "" },
      descClamp: { title: "t", description: "d".repeat(SESSION_DESCRIPTION_MAX_CHARS) },
      graphemes: "👍👎",
      lastPrompt: "hello",
      firstLine: "Fix the login button",
      blank: "",
      wordBound: "please help me debug this extremely long…",
    });
  });

  it("last surviving call wins; rewind restores; manual outranks; scheme inners count; need does not steal", () => {
    const root = new SessionRoot({ sessionId: "s-title", path: "/tmp/title" });
    const plexus = Plexus.bootstrap(root);
    const genesis = new SessionSystemPrompt();
    const first = new SessionTurn({
      turnTail: genesis,
      prompt: prompt.user`hi there please help with a long thing`,
      doneWork: [meta("m1", "First label", "started")],
      queue: [],
    });
    const second = new SessionTurn({
      turnTail: first,
      prompt: prompt.user`continue`,
      doneWork: [meta("m2", "Later label", "patched tests")],
      queue: [],
    });
    root.head = second;
    const later = { title: root.title, description: root.turnDescription };
    root.head = first;
    const rewind = { title: root.title, description: root.turnDescription };
    root.manualTitle = "  Auth refactor  ";
    root.head = second;
    const manual = { title: root.title, description: root.turnDescription };
    root.manualTitle = "";
    root.head = new SessionTurn({ turnTail: genesis, prompt: prompt.user`bare prompt`, queue: [] });
    const fallback = { title: sessionDisplayTitle(root), description: root.turnDescription };

    const inner = meta("inner", "From scheme");
    const bag = new ProgrammaticJob({ toolCallId: "p1", argsJson: "{}" });
    bag.pushInvocation(inner);
    const schemeTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`run`,
      doneWork: [bag],
      queue: [],
    });
    const labeled = meta("m1", "Fix login", "auth");
    const need = new ContextNeedToolJob({
      triggersReactLoop: false,
      tapeHidden: true,
      toolCallId: "n1",
      name: CONTEXT_NEED_TOOL_NAME,
      argsJson: JSON.stringify({ min_remaining_tokens: 8000 }),
    });
    const needTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`run`,
      doneWork: [labeled, need],
      queue: [],
    });
    const skipTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`run`,
      doneWork: [
        meta("kept", "Kept title"),
        new SystemToolJob({
          triggersReactLoop: false,
          tapeHidden: true,
          toolCallId: "bad",
          name: "update_metadata",
          argsJson: "not-json",
        }),
      ],
      queue: [],
    });
    expect({
      later,
      rewind,
      manual,
      fallback,
      scheme: schemeTurn.metadata?.title,
      need: needTurn.metadata?.title,
      skipGarbage: skipTurn.metadata?.title,
      inherited: new SessionTurn({ turnTail: first, prompt: prompt.user`next`, queue: [] }).metadata,
    }).toEqual({
      later: { title: "Later label", description: "patched tests" },
      rewind: { title: "First label", description: "started" },
      manual: { title: "Auth refactor", description: "patched tests" },
      fallback: { title: "bare prompt", description: "" },
      scheme: "From scheme",
      need: "Fix login",
      skipGarbage: "Kept title",
      inherited: { title: "First label", description: "started" },
    });
    plexus.destroy();
  });
});

describe("METADATA_SAME_ROUND_NOTE", () => {
  it("is the exact text the model has always seen", () => {
    expect(METADATA_SAME_ROUND_NOTE).toBe(
      "Call update_metadata in the same completion as your other tool calls, last among them — not as its own round.",
    );
  });
});
