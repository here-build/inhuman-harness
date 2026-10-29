import type { RowLight } from "./light.js";

/** Recent rows on Overview when nothing is waiting or running. */
export const OVERVIEW_RECENT_CAP = 12;

/** Short relative time. Under a minute still reads `1m`; then `2h`, then `4d`. */
export function shortAge(at: number | null | undefined, now: number): string {
  if (at == null || !Number.isFinite(at)) return "";
  const minutes = Math.round(Math.max(0, now - at) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.max(1, Math.round(hours / 24))}d`;
}

/** Waiting, then running, then the rest. Recency breaks ties inside a band. */
export function orderSessions<Id extends string>(
  ids: readonly Id[],
  lightFor: (id: Id) => RowLight,
  atFor: (id: Id) => number,
): Id[] {
  const rank = (light: RowLight): number => (light === "waiting-for-you" ? 0 : light === "running" ? 1 : 2);
  return [...ids].sort((a, b) => rank(lightFor(a)) - rank(lightFor(b)) || atFor(b) - atFor(a));
}

/** Waiting and running across the set, or the newest rows when nothing needs you. */
export function overviewList<Id extends string>(
  ids: readonly Id[],
  lightFor: (id: Id) => RowLight,
  atFor: (id: Id) => number,
  cap = OVERVIEW_RECENT_CAP,
): Id[] {
  const ordered = orderSessions(ids, lightFor, atFor);
  const attention = ordered.filter((id) => {
    const light = lightFor(id);
    return light === "waiting-for-you" || light === "running";
  });
  return attention.length > 0 ? attention : ordered.slice(0, cap);
}
