/**
 * The daemon is the one decider for the session inbox. Steer-first and
 * retract-last are RPCs serialized with the turn-close drain, so a queued row
 * becomes exactly one of {new turn, steer}, never both.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { admitQueue, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import type { SessionDaemon } from "../daemon/session/SessionDaemon.js";
import { attachScriptedModel, scriptedConnectionId } from "../testkit/scripted-model.js";

/** No connection yet, so the drain leaves the queue alone until {@link connect}. */
async function idleSessionWithQueue(...texts: string[]): Promise<SessionDaemon> {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-queue-k-"))));
  await kernel.ready;
  const project = new ProjectDaemon(kernel, await realpath(await mkdtemp(join(tmpdir(), "harness-queue-p-"))));
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  const closed = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`done` });
  closed.reducerExited = true;
  session.root.head = closed;
  for (const text of texts) admitQueue(session.root, prompt.user`${text}`, closed.uuid);
  return session;
}

/** Setting the connection is what lets the turn-close drain run. */
function connect(session: SessionDaemon): void {
  session.root.applyKvs([{ form: "kv-set", key: "connection", value: scriptedConnectionId() }]);
}

function fate(session: SessionDaemon, text: string) {
  return {
    turns: session.root.head instanceof SessionTurn && session.root.head.prompt?.trim() === text ? 1 : 0,
    steers: session.root.steerQueue.filter((row) => row.text === text).length,
    queued: session.root.promptQueue.filter((row) => row.text === text).length,
  };
}

describe("session inbox door", () => {
  beforeEach(() => resetLocalIDs());

  it("concurrent drain and steer-first leave a queued row as exactly one of turn or steer", async () => {
    const drainFirst = await idleSessionWithQueue("later");
    const id = drainFirst.root.promptQueue[0]!.uuid;
    connect(drainFirst);
    const lost = await drainFirst.handleRequest("queue/steer-first", { id });

    const steerFirst = await idleSessionWithQueue("later");
    const steering = steerFirst.handleRequest("queue/steer-first", { id: steerFirst.root.promptQueue[0]!.uuid });
    connect(steerFirst);
    const won = await steering;
    await steerFirst.drainPromptQueue();

    expect({
      drainFirst: { result: lost, fate: fate(drainFirst, "later") },
      steerFirst: { result: won, fate: fate(steerFirst, "later") },
    }).toEqual({
      drainFirst: { result: { ok: false }, fate: { turns: 1, steers: 0, queued: 0 } },
      steerFirst: { result: { ok: true }, fate: { turns: 0, steers: 1, queued: 0 } },
    });
  });

  it("retract-last drops only the row the client saw", async () => {
    const session = await idleSessionWithQueue("one", "two");
    const [, last] = session.root.promptQueue.map((row) => row.uuid);
    const stale = await session.handleRequest("queue/retract-last", { id: session.root.promptQueue[0]!.uuid });
    const fresh = await session.handleRequest("queue/retract-last", { id: last });
    expect({ stale, fresh, queue: session.root.promptQueue.map((row) => row.text) }).toEqual({
      stale: { ok: false },
      fresh: { ok: true },
      queue: ["one"],
    });
  });
});
