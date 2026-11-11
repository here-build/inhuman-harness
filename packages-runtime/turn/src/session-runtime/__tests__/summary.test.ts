import { SessionRoot, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model/session";
import { describe, expect, it } from "vitest";

import { sessionColumns } from "../summary.js";

describe("sessionColumns", () => {
  it("publishes the document: openTurn, display title, act as agentic, standing permission", () => {
    const root = new SessionRoot({
      sessionId: "s",
      path: "/tmp/s",
      mode: "act",
      standingPermissionMode: "yolo",
      manualTitle: "Kept",
    });
    expect(sessionColumns(root)).toEqual({
      title: "Kept",
      workspacePath: "/tmp/s",
      mode: "agentic",
      permissionMode: "yolo",
      running: false,
      headTurnId: null,
    });

    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt() });
    root.head = turn;
    expect({ running: sessionColumns(root).running, headTurnId: sessionColumns(root).headTurnId }).toEqual({
      running: true,
      headTurnId: turn.uuid,
    });

    root.mode = "plan";
    expect(sessionColumns(root).mode).toBe("assistant");
  });
});
