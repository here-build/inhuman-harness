import { dirname } from "node:path";

import { programSourceLoader } from "@inhuman.tools/scheme-program/fs";
import {
  applyCompact as applySessionCompact,
  type CompactApplyResult,
  type CompactStrategyOpts,
} from "@inhuman.tools/turn/session";

export {
  type SessionCommandHost,
  failLeftoverApprovables,
  isWorkReachable,
  turnLoopStopped,
  abortParkableWork,
  dispatchedMcpSettled,
  liveEvalWork,
  mcpJobOnWire,
  admitCompact,
  admitTurn,
  cancelTurnCommand,
  drainPromptQueue,
  retryTurn,
  rewindTurn,
  type CompactProgram,
  type CompactStrategyResolve,
  loadCompactProgram,
  compactReducerCapability,
  type CompactHost,
  runCompactJob,
  CONTEXT_NEED_REMINDER,
  joinSystemNotes,
  quietRoundsSince,
  sealedActorRounds,
  SIDE_CHANNEL_REMINDER_EVERY,
  sideChannelReminderDue,
  sideChannelReminderNote,
  TITLE_UPDATE_REMINDER,
  type SideChannelRound,
} from "@inhuman.tools/turn/session";

/** Local compatibility: a configured source path also binds its confined filesystem loader. */
export function applyCompact(
  program: string,
  compactTranscript: Parameters<typeof applySessionCompact>[1],
  fullTranscript: Parameters<typeof applySessionCompact>[2],
  opts: CompactStrategyOpts = {},
): Promise<CompactApplyResult> {
  const moduleLoader =
    opts.moduleLoader ??
    (opts.sourcePath == null || opts.sourcePath === "" ? undefined : programSourceLoader(dirname(opts.sourcePath)));
  return applySessionCompact(program, compactTranscript, fullTranscript, { ...opts, moduleLoader });
}
