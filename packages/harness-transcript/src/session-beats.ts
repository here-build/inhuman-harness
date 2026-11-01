import type { SessionOverview, SessionRoot, SessionTurn } from "@inhuman.tools/harness-model";

import { pluginProgress, type PluginSnapshot } from "./plugin-progress.js";
import type { Dial } from "../../harness-web-app/src/client/dial.js";
import { readListParts, type ReadPart } from "../../harness-web-app/src/shell/read-line.js";
import { agentSpans, modelSpans, stickyBeats } from "../../harness-web-app/src/shell/tape-beats.js";
import { turnOutline } from "../../harness-web-app/src/shell/tape-live.js";
import { turnsOldestFirst, type LookItem, type LookVerb } from "../../harness-web-app/src/shell/tape-read.js";

// Keep cumulative historical logs out of the streaming render hot path. Cache only
// strings and projected items; this must not retain the session document.
const progressByTurn = new WeakMap<
  SessionTurn,
  {
    readonly keys: readonly (string | undefined)[];
    readonly items: ReturnType<typeof pluginProgress>;
  }
>();

function turnProgress(turn: SessionTurn, previous: PluginSnapshot, current: PluginSnapshot) {
  const keys = [
    previous["tasks:state"],
    previous["inhuman-plugin-goal:state"],
    current["tasks:state"],
    current["inhuman-plugin-goal:state"],
  ];
  const cached = progressByTurn.get(turn);
  if (cached != null && keys.every((key, index) => key === cached.keys[index])) return cached.items;
  const items = pluginProgress(previous, current);
  progressByTurn.set(turn, { keys, items });
  return items;
}

function outlineThoughts(id: string, hasThoughts: boolean): { readonly id: string; readonly text: string }[] {
  if (!hasThoughts) return [];
  return [{ id, text: "" }];
}

/** A session's rounds laid out for both lanes. Spans cross turns; a turn alone cannot see the round before it. */
export function sessionBeats(root: SessionRoot) {
  let previous: PluginSnapshot = {};
  return stickyBeats(
    agentSpans(
      modelSpans(
        turnsOldestFirst(root).flatMap((turn) => {
          // End snapshots cannot locate actions within historical rounds. Keep every
          // transition, but place this turn's delta on its last round. The head uses
          // live state so hooks and /goal update even without a tool or completion.
          const snapshot = turn === root.head ? root.pluginState : turn.pluginState;
          const items = snapshot == null ? [] : turnProgress(turn, previous, snapshot);
          if (snapshot != null) previous = snapshot;
          const outlines = [...turnOutline(turn, root.path)];
          if (items.length > 0) {
            let last = outlines.at(-1);
            if (last == null || last.id === `${turn.uuid}:user`) {
              last = {
                id: `${turn.uuid}:round`,
                mark: null,
                model: "",
                connection: "",
                hasThoughts: false,
                agents: [],
                settles: [],
              };
              outlines.push(last);
            }
            outlines[outlines.length - 1] = {
              ...last,
              mark: {
                title: last.mark?.title ?? "",
                description: last.mark?.description ?? "",
                items: [...(last.mark?.items ?? []), ...items],
              },
            };
          }
          return outlines.map((outline) => ({
            id: outline.id,
            mark: outline.mark,
            model: outline.model,
            connection: outline.connection,
            thoughts: outlineThoughts(outline.id, outline.hasThoughts),
            agents: outline.agents,
            settles: outline.settles,
            turn,
          }));
        }),
      ),
    ),
  );
}

/** The kernel's glance of a session, when it lists one. */
export function glanceOf(dial: Pick<Dial, "kernel">, sessionId: string): SessionOverview | null {
  const sessions = dial.kernel?.root.sessions;
  return sessions != null && Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : null;
}

export const LOOK_VERB: Readonly<Record<LookVerb, string>> = {
  read: "Reading",
  search: "Searching for",
  find: "Finding",
};

/** A run of read-family calls: one sentence per verb, in call order. */
export function lookSentences(items: readonly LookItem[]): LookItem[][] {
  const sentences: LookItem[][] = [];
  for (const item of items) {
    const last = sentences.at(-1);
    if (last?.[0]?.verb === item.verb) last.push(item);
    else sentences.push([item]);
  }
  return sentences;
}

/** The labels as one list sentence. A runtime without `Intl.ListFormat` still gets "a, b and c". */
export function lookParts(labels: readonly string[], locales?: readonly string[]): readonly ReadPart[] {
  try {
    return readListParts(labels, locales);
  } catch {
    const parts: ReadPart[] = [];
    for (const [index, label] of labels.entries()) {
      if (index > 0) parts.push({ kind: "text", text: index === labels.length - 1 ? " and " : ", " });
      parts.push({ kind: "path", label });
    }
    return parts;
  }
}
