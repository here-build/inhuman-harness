import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import type { SessionEffectRow } from "@inhuman.tools/harness-contract/schema";
import {
  CompletionJob,
  ReACTChunk,
  SessionPlexus,
  SessionSystemPrompt,
  SessionTurn,
} from "@inhuman.tools/harness-model";
import type { SerializedModelRow } from "@inhuman.tools/model";
import { when } from "mobx";
import { onTestFinished } from "vitest";

import { installScriptedModel, scriptedConnectionId, useKeepFirstCompact } from "../../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../../project/ProjectDaemon.js";

export type SessionCut = {
  readonly rootId: string;
  readonly revision: number;
  readonly rows: readonly SerializedModelRow[];
  readonly effects: readonly SessionEffectRow[];
};

export const wait = (predicate: () => boolean) => when(predicate, { timeout: 8_000 });
export const rounds = (turn: SessionTurn) =>
  [...turn.doneWork, ...turn.queue].filter((cell): cell is CompletionJob => cell instanceof CompletionJob);
export const boundaries = (turn: SessionTurn) =>
  [...turn.doneWork, ...turn.queue].filter((cell): cell is ReACTChunk => cell instanceof ReACTChunk);

export function captureCut(live: {
  readonly kernel: KernelDaemon;
  readonly session: { readonly sessionId: string; readonly root: { readonly uuid: string }; readonly doc: SessionPlexus["doc"] };
}): SessionCut {
  return {
    rootId: live.session.root.uuid,
    revision: Math.max(live.session.doc.revision, 1),
    rows: live.session.doc.toNodeRows(),
    effects: live.kernel.db.listSessionEffects(live.session.sessionId),
  };
}

export async function liveSession(
  cut?: SessionCut,
  files: Readonly<Record<string, string>> = {},
  workspacePath?: string,
  keepFirstCompact = false,
) {
  const system = await mkdtemp(join(tmpdir(), "harness-continuation-k-"));
  const workspace = workspacePath ?? (await mkdtemp(join(tmpdir(), "harness-continuation-p-")));
  for (const [name, text] of Object.entries(files)) await writeFile(join(workspace, name), text);
  let kernel = new KernelDaemon(system);
  await kernel.ready;
  const model = installScriptedModel(kernel);
  if (cut != null) {
    const now = Date.now();
    kernel.db.writeTransaction(["sessions", "session_nodes", "session_effects"], (tx) => {
      kernel.db.insertSession({
        sessionId: "s1",
        workspacePath: workspace,
        revision: cut.revision,
        createdAtMs: now,
        lastActiveAtMs: now,
      });
      kernel.db.commitSessionNodesInTx(tx, "s1", {
        rootId: cut.rootId,
        revision: cut.revision,
        upserts: cut.rows,
        deletes: [],
        replaceAll: true,
      });
      for (const effect of cut.effects) {
        kernel.db.upsertSessionEffectInTx(tx, effect);
      }
    });
    kernel[Symbol.dispose]();
    kernel = new KernelDaemon(system);
    await kernel.ready;
  }
  const script = cut == null ? model : installScriptedModel(kernel);
  if (keepFirstCompact) useKeepFirstCompact(kernel, system);
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(async () => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
    await Promise.all([
      rm(system, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      ...(workspacePath == null
        ? [rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })]
        : []),
    ]);
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return { kernel, project, session, model: script };
}

export async function startTurn(live: Awaited<ReturnType<typeof liveSession>>, text = "implement it") {
  const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`${text}` });
  live.session.root.head = turn;
  await wait(() => rounds(turn).length === 1);
  return { turn };
}

export function replicaOf(session: Awaited<ReturnType<typeof liveSession>>["session"]): SessionPlexus {
  const replica = SessionPlexus.fromNodeRows(session.doc.toNodeRows(), {
    rootId: session.root.uuid,
    sessionId: session.sessionId,
    revision: session.doc.revision,
    meta: session.doc.exportMeta(),
  });
  onTestFinished(() => replica.destroy());
  return replica;
}

export async function configureJudge(live: Awaited<ReturnType<typeof liveSession>>) {
  live.kernel.plexus.root.reActLoopIntentDetectedTrigger.enabled = true;
  await live.session.handleRequest("kv/set", { key: "judgeConnection", value: scriptedConnectionId() });
  await live.session.handleRequest("kv/set", { key: "judgeModel", value: "grok-4.6" });
}
