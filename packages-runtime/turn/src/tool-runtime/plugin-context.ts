/**
 * Build plugin call context from live session entities. Graph objects stay
 * host-side. Storage is the prefix projection; propose is applied onto this job after run.
 */
import {
  CompletionExpectation,
  hostingTurnOf,
  projectionsOf,
  reactChunks,
  SessionRoot,
  SessionTurn,
  storageBefore,
  tapeCompletion,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import type { PluginCallContext } from "@inhuman.tools/plugin-sdk";

export const pendingPropose = new WeakMap<object, { readonly pluginId: string; readonly action: unknown }>();

function completionHosting(job: ToolCallJob): CompletionExpectation | null {
  const turn = job.parent instanceof SessionTurn ? job.parent : null;
  if (turn == null) return null;
  const tape = reactChunks(turn);
  for (let i = 0; i < tape.length; i += 1) {
    const pew = tapeCompletion(tape[i]);
    if (pew == null) continue;
    if (pew.messages.includes(job)) return pew;
    for (let index = i + 1; index < tape.length; index += 1) {
      const cell = tape[index];
      if (tapeCompletion(cell) != null) break;
      if (cell === job) return pew;
    }
  }
  return null;
}

export function pluginCallContextOf(
  root: SessionRoot,
  job: ToolCallJob,
  signal?: AbortSignal,
  pluginId = "",
): PluginCallContext {
  const turn = hostingTurnOf(root, job) ?? (job.parent instanceof SessionTurn ? job.parent : null);
  const completion = completionHosting(job);
  const prefix = storageBefore(root, job);
  const projection = pluginId === "" ? undefined : projectionsOf(root).get(pluginId);
  const initial = projection?.initial() ?? {};
  return {
    root: root.path.trim() === "" ? undefined : root.path,
    callerSessionId: root.sessionId,
    turn,
    completion,
    invocation: job,
    signal,
    storage: {
      session: pluginId === "" ? prefix : (prefix[pluginId] ?? initial),
      invocation: initial,
      propose(action: unknown) {
        if (pluginId === "") return;
        pendingPropose.set(job, { pluginId, action });
      },
    },
  };
}

export function isModelOriginContext(ctx: PluginCallContext): boolean {
  return ctx.completion instanceof CompletionExpectation;
}
