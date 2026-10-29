import { resetLocalIDs } from "@here.build/plexus";
import { beforeEach, describe, expect, it } from "vitest";

import { KernelAgentRelation } from "../../kernel/KernelAgentRelation.js";
import { AskAgentSpec } from "../Agent.js";
import { SessionRoot } from "../SessionRoot.js";
import {
  delegatesPermissionMode,
  deskPermissionSnap,
  permissionDeskSessionId,
  projectWorkerPermissions,
} from "../worker-permissions.js";

describe("worker permissions", () => {
  beforeEach(() => resetLocalIDs());

  it("delegates one-shot and session; project and global stay roots", () => {
    const oneShot = new SessionRoot({ sessionId: "w-ask", path: "/tmp/p" });
    oneShot.agent.spec = new AskAgentSpec({ name: "explore" });
    const session = new SessionRoot({ sessionId: "w-pal", path: "/tmp/p" });
    session.agent.spec.recipeScope = "session";
    const project = new SessionRoot({ sessionId: "w-proj", path: "/tmp/p" });
    project.agent.spec.recipeScope = "project";
    const global = new SessionRoot({ sessionId: "w-glob", path: "/tmp/p" });
    global.agent.spec.recipeScope = "global";
    const conversation = new SessionRoot({ sessionId: "s", path: "/tmp/p" });
    expect({
      oneShot: delegatesPermissionMode(oneShot),
      session: delegatesPermissionMode(session),
      project: delegatesPermissionMode(project),
      global: delegatesPermissionMode(global),
      conversation: delegatesPermissionMode(conversation),
    }).toEqual({
      oneShot: true,
      session: true,
      project: false,
      global: false,
      conversation: false,
    });
  });

  it("projects mode, roots, session grants and overlay, and replaces leftover list keys", () => {
    const desk = new SessionRoot({ sessionId: "s", path: "/tmp/p", standingPermissionMode: "yolo" });
    desk.readRoots["/opt/shared"] = "session";
    desk.toolAllowlist["github:get_issue"] = "always";
    desk.replaceGrantsJson(
      JSON.stringify([
        {
          id: "g1",
          scope: "session",
          scopeKey: "s",
          subject: { kind: "command", argv0: "make", spine: [], args: ["deploy"] },
          createdAtMs: 1,
          expiresAtMs: null,
          source: "prompt",
          label: "make deploy",
        },
      ]),
    );
    desk.replaceAuthorizationOverlay('{"manual":{"default":"deny"}}');
    const worker = new SessionRoot({ sessionId: "w", path: "/tmp/p", standingPermissionMode: "manual" });
    worker.readRoots["/opt/stale"] = "session";
    worker.toolBlocklist["github:create_issue"] = "session";
    worker.authorizationUserJson = '{"manual":{"default":"allow"}}';
    projectWorkerPermissions(worker, desk);
    expect({
      policy: worker.permissionMode,
      roots: { ...worker.readRoots },
      tools: { ...worker.toolAllowlist },
      blocked: { ...worker.toolBlocklist },
      overlay: worker.authorizationOverlayJson,
      // the worker's own layers stay its own
      user: worker.authorizationUserJson,
      grants: JSON.parse(worker.grantsJson),
    }).toEqual({
      policy: "yolo",
      roots: { "/opt/shared": "session" },
      tools: { "github:get_issue": "always" },
      blocked: {},
      overlay: '{"manual":{"default":"deny"}}',
      user: '{"manual":{"default":"allow"}}',
      // the caller's session grants are the child's own: same ids, re-keyed to the child's session
      grants: [expect.objectContaining({ id: "g1", scope: "session", scopeKey: "w" })],
    });
  });

  it("desk id prefers a live callback, then the kernel relation", () => {
    const worker = new SessionRoot({ sessionId: "w", path: "/tmp/p" });
    const empty = permissionDeskSessionId(worker, { agentCalls: {} });
    worker.agentCallbacks.req = "caller";
    const fromCb = permissionDeskSessionId(worker, { agentCalls: {} });
    worker.agentCallbacks.req = "";
    const fromRel = permissionDeskSessionId(worker, {
      agentCalls: {
        call: new KernelAgentRelation({ callerSessionId: "from-rel", workerSessionId: "w" }),
      },
    });
    expect({ empty, fromCb, fromRel, snap: deskPermissionSnap(worker).policy }).toEqual({
      empty: "",
      fromCb: "caller",
      fromRel: "from-rel",
      snap: "manual",
    });
  });
});
