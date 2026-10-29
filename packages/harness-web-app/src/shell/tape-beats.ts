import type { AgentCell, TapeBodyCell, TapeCell } from "./tape-read.js";

export type { TapeBodyCell } from "./tape-read.js";

export type ProgressMark = {
  readonly title: string;
  readonly description: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly detail: string }[];
};

export type TapeBeat = {
  readonly id: string;
  readonly mark: ProgressMark | null;
  /** The model and connection that ran this round; empty for the ask and before the first round. */
  readonly model: string;
  readonly connection: string;
  readonly cells: readonly TapeBodyCell[];
  readonly thoughts: readonly { readonly id: string; readonly text: string }[];
  readonly agents: readonly AgentCell[];
  /** Calls whose background result this round took in. */
  readonly settles: readonly string[];
};

function progressMark(prior: ProgressMark | null, cell: Extract<TapeCell, { kind: "progress" }>): ProgressMark {
  return {
    title: cell.title === "" ? (prior?.title ?? "") : cell.title,
    description: cell.title === "" ? (prior?.description ?? "") : cell.description,
    items: [...(prior?.items ?? []), ...cell.items],
  };
}

/** One block per model round; metadata annotates that round, not its tool position. */
export function groupBeats(cells: readonly TapeCell[]): TapeBeat[] {
  const beats: TapeBeat[] = [];
  let id = "start";
  let mark: ProgressMark | null = null;
  let model = "";
  let connection = "";
  let bucket: TapeBodyCell[] = [];
  let thoughts: { id: string; text: string }[] = [];
  let agents: AgentCell[] = [];
  let settles: string[] = [];
  const flush = (): void => {
    if (mark == null && bucket.length === 0 && thoughts.length === 0 && agents.length === 0 && settles.length === 0) {
      return;
    }
    beats.push({ id, mark, model, connection, cells: bucket, thoughts, agents, settles });
    bucket = [];
    thoughts = [];
    agents = [];
    settles = [];
  };
  for (const cell of cells) {
    switch (cell.kind) {
      case "round":
      case "user": {
        flush();
        id = cell.id;
        mark = null;
        model = cell.kind === "round" ? (cell.model ?? "") : "";
        connection = cell.kind === "round" ? (cell.connection ?? "") : "";
        if (cell.kind === "user") bucket.push(cell);

        break;
      }
      case "progress": {
        mark = progressMark(mark, cell);

        break;
      }
      case "speech": {
        if (cell.thought !== "") thoughts.push({ id: cell.id, text: cell.thought });
        if (cell.text !== "") bucket.push({ ...cell, thought: "" });

        break;
      }
      case "agent": {
        agents.push(cell);

        break;
      }
      case "settle": {
        settles.push(...cell.calls);

        break;
      }
      case "reads":
      case "tool": {
        bucket.push(cell);
      }
    }
  }
  flush();
  return beats;
}

export type TimelineBeat = TapeBeat & {
  readonly row: number;
  readonly titleEnd: number;
  readonly thoughtsEnd: number;
};

export type ModelSpan = {
  readonly model: string;
  readonly connection: string;
  /** Row of the span's last round; the span closes at that round's end. */
  readonly lastRow: number;
};

/**
 * Rounds in a row on one model and connection are one span, opened on its first
 * round and closed at the end of its last. An ask between them does not split it.
 */
export function modelSpans<T extends { readonly model: string; readonly connection: string }>(
  beats: readonly T[],
): (T & { readonly modelSpan: ModelSpan | null })[] {
  const spans: (ModelSpan | null)[] = beats.map(() => null);
  let open = -1;
  for (const [index, beat] of beats.entries()) {
    if (beat.model === "") continue;
    const span = open < 0 ? null : spans[open];
    if (span?.model === beat.model && span.connection === beat.connection) {
      spans[open] = { ...span, lastRow: index + 1 };
      continue;
    }
    open = index;
    spans[index] = { model: beat.model, connection: beat.connection, lastRow: index + 1 };
  }
  return beats.map((beat, index) => ({ ...beat, modelSpan: spans[index] }));
}

/** What the span pass needs of an agent: whether it can close in its own round. */
export type AgentMark = { readonly id: string; readonly background: boolean; readonly live: boolean };

export type AgentSpan = {
  readonly id: string;
  /** Row of the round that closed it; null while it is still out, which holds it to the tape's end. */
  readonly lastRow: number | null;
};

/**
 * An agent spans its spawn to the round that took its result in: its own round
 * for a call that waited, the round that claimed the notification for one sent
 * to the background.
 */
export function agentSpans<T extends { readonly agents: readonly AgentMark[]; readonly settles: readonly string[] }>(
  beats: readonly T[],
): (T & { readonly agentSpans: readonly AgentSpan[] })[] {
  const settledAt = new Map<string, number>();
  for (const [index, beat] of beats.entries()) {
    for (const id of beat.settles) if (!settledAt.has(id)) settledAt.set(id, index + 1);
  }
  return beats.map((beat, index) => {
    const row = index + 1;
    const spans = beat.agents.map((agent): AgentSpan => ({
      id: agent.id,
      lastRow: !agent.background && !agent.live ? row : (settledAt.get(agent.id) ?? null),
    }));
    return { ...beat, agentSpans: spans };
  });
}

/** Each lane persists independently until its next entity, or the tape end. */
export function stickyBeats<T extends { readonly mark: ProgressMark | null; readonly thoughts: readonly unknown[] }>(
  beats: readonly T[],
): (T & { readonly row: number; readonly titleEnd: number; readonly thoughtsEnd: number })[] {
  let titleEnd = beats.length + 1;
  let thoughtsEnd = beats.length + 1;
  const timeline: (T & { row: number; titleEnd: number; thoughtsEnd: number })[] = [];
  for (let index = beats.length - 1; index >= 0; index--) {
    const beat = beats[index];
    const row = index + 1;
    timeline.push({ ...beat, row, titleEnd, thoughtsEnd });
    if (beat.mark != null) titleEnd = row;
    if (beat.thoughts.length > 0) thoughtsEnd = row;
  }
  return timeline.toReversed();
}
