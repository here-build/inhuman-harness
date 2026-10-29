import { BotCallJob, SessionPlexus, SessionSystemPrompt, SessionTurn } from "@inhuman.tools/harness-model";
import { onTestFinished } from "vitest";

export function sessionOf(id: string): SessionPlexus {
  const plexus = SessionPlexus.create(id, `/tmp/runtime/${id}`);
  onTestFinished(() => plexus.destroy());
  return plexus;
}

export function scopeOf(...plexuses: SessionPlexus[]) {
  const map = new Map(plexuses.map((plexus) => [plexus.root.sessionId, plexus]));
  return { replica: (id: string) => map.get(id) };
}

/** Caller-side CallJob plus, when `worker` is a replica, the worker's callback row. */
export function admitCall(
  caller: SessionPlexus,
  worker: SessionPlexus | string,
  extra: {
    readonly completed?: boolean;
    readonly cancelled?: boolean;
    readonly accepted?: boolean;
  } = {},
): BotCallJob {
  const workerSessionId = typeof worker === "string" ? worker : worker.root.sessionId;
  const call = new BotCallJob({
    name: "bot",
    workerSessionId: extra.accepted === false ? "" : workerSessionId,
    acceptedAt: extra.accepted === false ? null : Date.now(),
    humanApprove: true,
    completed: extra.completed === true,
    cancelled: extra.cancelled === true,
  });
  const existing = caller.root.head;
  const turn =
    existing instanceof SessionTurn
      ? existing
      : new SessionTurn({
          turnTail: new SessionSystemPrompt(),
          queue: [],
        });
  turn.pushChild(call);
  if (caller.root.head !== turn) caller.root.head = turn;
  if (typeof worker !== "string") worker.root.ensureAgentCallback(call.uuid, caller.root.sessionId);
  return call;
}
