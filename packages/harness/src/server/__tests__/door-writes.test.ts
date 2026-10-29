/**
 * Session state a client used to write into its replica goes through a
 * session RPC instead, so the daemon stays the one decider.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { publishKernelSeat, responseCall, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import type { SessionDaemon } from "../daemon/session/SessionDaemon.js";
import { attachScriptedModel, modelOf, scriptedConnectionId } from "../testkit/scripted-model.js";

async function openSession(): Promise<SessionDaemon> {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-door-k-"))));
  await kernel.ready;
  const project = new ProjectDaemon(kernel, await realpath(await mkdtemp(join(tmpdir(), "harness-door-p-"))));
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return session;
}

describe("client writes through the session door", () => {
  beforeEach(() => resetLocalIDs());

  it("resident/set flips the resident bit", async () => {
    const session = await openSession();
    const on = await session.handleRequest("resident/set", { resident: true });
    const after = session.root.agent.spec.resident;
    await session.handleRequest("resident/set", { resident: false });
    expect({ on, after, off: session.root.agent.spec.resident }).toEqual({ on: { ok: true }, after: true, off: false });
  });

  it("ask/answer answers only the live ask of this session or its worker", async () => {
    const session = await openSession();
    attachScriptedModel(session.kernel, session);
    await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
    publishKernelSeat(session.kernel.plexus.awareness, "s1");
    session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`write` });
    modelOf(session).reply({
      calls: [responseCall("w1", "write_file", JSON.stringify({ path: "README.md", content: "hi" }))],
    });
    await when(() => session.root.findRunningTurn()?.approvalHead != null, { timeout: 5_000 });
    const leaf = session.root.findRunningTurn()!.approvalHead!;
    const answer = { sessionId: "s1", jobId: leaf.uuid, allow: false, comment: "not that file" };
    const stranger = await session.handleRequest("ask/answer", { ...answer, sessionId: "not-my-worker" });
    const first = await session.handleRequest("ask/answer", answer);
    const again = await session.handleRequest("ask/answer", { ...answer, allow: true });
    expect({ stranger, first, again, approve: leaf.humanApprove, comment: leaf.approvalComment }).toEqual({
      stranger: { ok: false, reason: "not-pending" },
      first: { ok: true },
      again: { ok: false, reason: "not-pending" },
      approve: false,
      comment: "not that file",
    });
  });
});
