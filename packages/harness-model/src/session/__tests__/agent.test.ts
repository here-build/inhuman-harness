/**
 * POLICY FOLLOWS HEAD.
 */
import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { callbackRequiredNote } from "../Agent.js";
import { sessionMintPermissionMode } from "../eval-context.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurn } from "../turn/index.js";
import { attached } from "./_helpers/fixtures.js";

describe("Agent", () => {
  beforeEach(() => resetLocalIDs());

  it("policy follows head", () => {
    const session = attached({ sessionId: "s-policy", path: "/tmp/demo" });
    const genesis = new SessionSystemPrompt();
    session.permissionMode = "yolo";
    const emptyHead = session.head;
    const first = new SessionTurn({ turnTail: genesis, prompt: prompt.user`one`, queue: [] });
    const unattached = { permissionMode: first.permissionMode, effectivePermissionMode: first.effectivePermissionMode };
    session.head = first;
    const second = new SessionTurn({ turnTail: first, prompt: prompt.user`two`, queue: [] });
    session.head = second;
    session.permissionMode = "manual";

    const overlayTurn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`one`, queue: [] });
    overlayTurn.permissionMode = "auto";
    const inherit = new SessionTurn({ turnTail: overlayTurn, prompt: prompt.user`two`, queue: [] });

    expect({
      emptyHead,
      inherit: {
        unattached,
        afterFirst: { permissionMode: first.permissionMode, effectivePermissionMode: first.effectivePermissionMode },
        afterManual: {
          session: session.permissionMode,
          standing: session.standingPermissionMode,
          first: { current: first.permissionMode, effective: first.effectivePermissionMode },
          second: { current: second.permissionMode, effective: second.effectivePermissionMode },
        },
      },
      auto: overlayTurn.effectivePermissionMode,
      next: inherit.effectivePermissionMode,
    }).toEqual({
      emptyHead: null,
      inherit: {
        unattached: { permissionMode: null, effectivePermissionMode: "manual" },
        afterFirst: { permissionMode: "yolo", effectivePermissionMode: "yolo" },
        afterManual: {
          session: "manual",
          standing: "manual",
          first: { current: "yolo", effective: "yolo" },
          second: { current: "manual", effective: "manual" },
        },
      },
      auto: "auto",
      next: "auto",
    });
  });
});

describe("callbackRequiredNote", () => {
  it("lists live request ids and inbound prompts", () => {
    const session = attached({ sessionId: "s-cb", path: "/tmp/demo" });
    session.enqueueAgentRequest("req-a", "caller", prompt.user`review the plan`);
    session.ensureAgentCallback("req-b", "caller");
    expect({
      ask: callbackRequiredNote(false, session.openCallbackRows()),
      send: callbackRequiredNote(true, [{ requestId: "req-a", prompt: prompt.user`review the plan` }]),
    }).toEqual({
      ask: [
        "These calls are still open.",
        "Close each with the agent__respond JSON tool — not as assistant text.",
        "- req-a — review the plan",
        "- req-b",
      ].join("\n"),
      send: [
        "This call is still open.",
        "Close each with the agent__respond JSON tool, or agent__void — not as assistant text.",
        "- req-a — review the plan",
      ].join("\n"),
    });
  });
});

describe("enqueueAgentRequest", () => {
  it("a request with no reply seats its turn and opens no callback row", () => {
    const session = attached({ sessionId: "s-msg", path: "/tmp/demo" });
    session.enqueueAgentRequest("msg-a", "caller", prompt.user`hello`, { callback: false });
    expect({
      turn: session.findTurnByAgentRequestId("msg-a")?.prompt,
      head: session.head?.agentRequestId,
      rows: { ...session.agentCallbacks },
    }).toEqual({ turn: "hello", head: "msg-a", rows: {} });
  });
});

describe("sessionMintPermissionMode", () => {
  it("project wins; empty project inherits kernel; both empty is manual", () => {
    expect({
      project: sessionMintPermissionMode("auto", "yolo"),
      kernel: sessionMintPermissionMode("auto", ""),
      empty: sessionMintPermissionMode("", ""),
      unknown: sessionMintPermissionMode("plan", "act"),
      manualProject: sessionMintPermissionMode("auto", "manual"),
    }).toEqual({
      project: "yolo",
      kernel: "auto",
      empty: "manual",
      unknown: "manual",
      manualProject: "manual",
    });
  });
});
