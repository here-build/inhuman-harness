/**
 * Present-side tape regroup. Thoughts glue across a speech gap.
 * Tools that remain after density cut the glue — they sit in
 * chronological order, not dumped after the span.
 *
 * Compact omits tools whose fuse stamp is set (`hideFloorTools`) before
 * grouping, so those known-safe effects do not cut. Default stamp is off:
 * floor-allow stays on the tape. Remainder never stamps. Expanded keeps
 * every identity. Loop pulse is never fused.
 */
export type TapeItem<T> =
  | { readonly kind: "user"; readonly node: T }
  | { readonly kind: "recall"; readonly node: T }
  | { readonly kind: "thought-only"; readonly node: T }
  | { readonly kind: "speech"; readonly node: T; readonly thought: T | null }
  | { readonly kind: "tool"; readonly node: T };

export type TapeSpan<T> =
  | { readonly kind: "user"; readonly node: T }
  | { readonly kind: "recall"; readonly node: T }
  | { readonly kind: "speech"; readonly node: T }
  | { readonly kind: "thoughts"; readonly nodes: readonly T[] }
  | { readonly kind: "tools"; readonly nodes: readonly T[] };

export function groupTapeSpans<T>(items: readonly TapeItem<T>[]): TapeSpan<T>[] {
  const out: TapeSpan<T>[] = [];
  let thoughts: T[] = [];
  let tools: T[] = [];

  const flushThoughts = (): void => {
    if (thoughts.length === 0) return;
    out.push({ kind: "thoughts", nodes: thoughts });
    thoughts = [];
  };
  const flushTools = (): void => {
    if (tools.length === 0) return;
    out.push({ kind: "tools", nodes: tools });
    tools = [];
  };

  for (const item of items) {
    switch (item.kind) {
      case "user":
        flushThoughts();
        flushTools();
        out.push({ kind: "user", node: item.node });
        break;
      case "recall":
        flushThoughts();
        flushTools();
        out.push({ kind: "recall", node: item.node });
        break;
      case "thought-only":
        flushTools();
        thoughts.push(item.node);
        break;
      case "speech":
        if (item.thought != null) thoughts.push(item.thought);
        flushThoughts();
        flushTools();
        out.push({ kind: "speech", node: item.node });
        break;
      case "tool":
        flushThoughts();
        tools.push(item.node);
        break;
    }
  }
  flushThoughts();
  flushTools();
  return out;
}

/**
 * Predicate is `I["node"]`. Mixed arrays synthesize `thought?: undefined`;
 * `TapeItem<T>` would infer T from speech `thought` and poison it.
 */
export function filterFusedTools<I extends TapeItem<unknown>>(
  items: readonly I[],
  fused: (node: I["node"]) => boolean,
): I[] {
  return items.filter((item) => item.kind !== "tool" || !fused(item.node));
}

export type ThoughtClockMember = {
  readonly live: boolean;
  readonly startedAt: number | null;
  readonly durationMs: number | null;
};

/**
 * Cluster thinking time — sum of member spans, not wall-clock through tools.
 * Live: `startedAt` is origin so `elapsedLive` ticks the sum (sealed + live).
 */
export function clusterThoughtClock(
  members: readonly ThoughtClockMember[],
  now = Date.now(),
): {
  readonly live: boolean;
  readonly startedAt: number | undefined;
  readonly durationMs: number | undefined;
} {
  let sealedMs = 0;
  let anySealed = false;
  let live = false;
  let liveStartedAt: number | undefined;
  for (const member of members) {
    if (member.live) {
      live = true;
      if (member.startedAt != null && Number.isFinite(member.startedAt)) {
        liveStartedAt = member.startedAt;
      }
      continue;
    }
    if (member.durationMs != null && Number.isFinite(member.durationMs)) {
      sealedMs += Math.max(0, member.durationMs);
      anySealed = true;
    }
  }
  if (live) {
    const liveElapsed = liveStartedAt == null ? 0 : Math.max(0, now - liveStartedAt);
    return {
      live: true,
      startedAt: liveStartedAt == null ? undefined : liveStartedAt - sealedMs,
      durationMs: liveStartedAt != null || anySealed ? sealedMs + liveElapsed : undefined,
    };
  }
  return {
    live: false,
    startedAt: undefined,
    durationMs: anySealed ? sealedMs : undefined,
  };
}
