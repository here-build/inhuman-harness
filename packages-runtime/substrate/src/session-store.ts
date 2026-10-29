/** An async key-value store for a session's FULL teaching-state bundle (history, cache,
 *  competence window, futility rings, DoorSession dedup, context-ring — all plain-data-
 *  serializable), enabling future TTL-offload storage of long-running sessions. The runner
 *  serializes the whole bundle into ONE JSON blob per session, round-tripped through `get`/`set`
 *  — never a partial export, so competence/futility/dedup/context-ring state always survives
 *  rehydration alongside history/cache. */
export interface AsyncSessionStore {
  get(sessionId: string): Promise<string | undefined>;
  set(sessionId: string, value: string, opts?: { ttlMs?: number }): Promise<void>;
  delete?(sessionId: string): Promise<void>;
}
