import {
  ApprovableJob,
  ProgrammaticJob,
  type SessionRoot,
  type SessionTurn,
  ToolCallJob,
} from "@inhuman.tools/harness-model";

export type RowLight = "running" | "waiting-for-you" | "idle";

/** Live chrome. `inLoop` stays true until the reducer leaves; `cutOff` is the cancel. */
export function turnIsLive<T extends { readonly cutOff: boolean }>(turn: T | null): turn is T {
  return turn != null && !turn.cutOff;
}

/**
 * The attached session, read live. An unattended eval ask does not set
 * `approvalHead`. A question the model left after its turn still waits on you.
 */
export function sessionLight(root: SessionRoot | null): RowLight {
  const turn = root?.findRunningTurn() ?? null;
  if (!turnIsLive(turn)) return root?.unfinished === "question" ? "waiting-for-you" : "idle";
  if (turn.approvalHead != null && !pendingAutoResidual(turn)) return "waiting-for-you";
  return "running";
}

/**
 * Admit or steer older than this is not an executor. The glance has no
 * heartbeat; `lastMessageAt` is that stamp, and a frozen `openTurn` is only
 * `reducerExited` still false.
 */
export const RUNNING_GLANCE_MS = 48 * 60 * 60 * 1000;

/**
 * Any other session, from its kernel glance. An ask or a question waits on
 * you, however old. Running matches the attached room: a turn still in the
 * loop (`openTurn`) whose last admit or steer is inside {@link RUNNING_GLANCE_MS}.
 * `unfinished: "tools"` with `openTurn` false is unsealed tools after the
 * reducer left, which the room reads as idle.
 */
export function overviewLight(
  glance:
    | {
        readonly unfinished?: string;
        readonly openTurn?: boolean;
        readonly lastMessageAt?: number | null;
      }
    | null
    | undefined,
  now = Date.now(),
): RowLight {
  switch (glance?.unfinished) {
    case "ask":
    case "question":
      return "waiting-for-you";
    default:
      return openTurnIsLive(glance, now) ? "running" : "idle";
  }
}

function openTurnIsLive(
  glance: { readonly openTurn?: boolean; readonly lastMessageAt?: number | null } | null | undefined,
  now: number,
): boolean {
  if (glance?.openTurn !== true) return false;
  const at = glance.lastMessageAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  return now - at < RUNNING_GLANCE_MS;
}

/** The open session's own room when this tab holds it, else its glance. */
export function rowLight(attached: SessionRoot | null, glance: Parameters<typeof overviewLight>[0]): RowLight {
  return attached != null ? sessionLight(attached) : overviewLight(glance);
}

/** A project's tab: waiting outranks running, and idle stays unmarked. */
export function projectPulse(lights: readonly RowLight[]): RowLight {
  if (lights.includes("waiting-for-you")) return "waiting-for-you";
  if (lights.includes("running")) return "running";
  return "idle";
}

function pendingAutoResidual(turn: SessionTurn): boolean {
  for (const chunk of [...turn.doneWork, ...turn.queue]) {
    const tools = chunk instanceof ToolCallJob ? [chunk] : chunk instanceof ProgrammaticJob ? chunk.toolCalls : [];
    for (const work of tools) {
      if (
        work instanceof ApprovableJob &&
        work.autoClassifierPending &&
        work.classifierAbstain == null &&
        !work.completed
      ) {
        return true;
      }
    }
  }
  return false;
}
