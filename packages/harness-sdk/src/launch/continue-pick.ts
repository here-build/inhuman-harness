/**
 * `--continue` attach target. Glance has no path — a global orphan would
 * be cwd-wrong, so no mapping still mints.
 */
import { unseatedConversationIds, type UnseatedConversationOverview } from "@inhuman.tools/harness-model";

export type ContinuePick = {
  readonly sessionId: string | undefined;
  readonly staleKeyToClear: string | null;
};

export async function pickContinueSession(args: {
  readonly key: string | null;
  readonly termContinue: Record<string, string>;
  readonly sessions: Record<string, UnseatedConversationOverview | undefined>;
  readonly occupied: ReadonlySet<string>;
  readonly sessionExists: (id: string) => Promise<boolean>;
}): Promise<ContinuePick> {
  const mapped = args.key == null ? undefined : args.termContinue[args.key];
  if (mapped == null || mapped === "") return { sessionId: undefined, staleKeyToClear: null };
  const exists = await args.sessionExists(mapped);
  if (exists && !args.occupied.has(mapped)) return { sessionId: mapped, staleKeyToClear: null };
  const staleKeyToClear = !exists && args.key != null ? args.key : null;
  for (const id of unseatedConversationIds(args.sessions, args.occupied)) {
    if (await args.sessionExists(id)) return { sessionId: id, staleKeyToClear };
  }
  return { sessionId: undefined, staleKeyToClear };
}
