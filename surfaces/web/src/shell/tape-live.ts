import type { SessionTurn } from "@inhuman.tools/harness-model";
import { comparer, computed, type IComputedValue } from "mobx";

import { type AgentMark, groupBeats, type ProgressMark, type TapeBeat } from "./tape-beats.js";
import { projectTurn } from "./tape-read.js";

export type BeatOutline = {
  readonly id: string;
  readonly mark: ProgressMark | null;
  readonly model: string;
  readonly connection: string;
  readonly hasThoughts: boolean;
  readonly agents: readonly AgentMark[];
  readonly settles: readonly string[];
};

type TurnLive = {
  readonly path: string;
  readonly beats: IComputedValue<TapeBeat[]>;
  readonly outline: IComputedValue<BeatOutline[]>;
};

// Keyed by the turn. The value closes over the path string, not the session, so leaving the session can collect the document.
const lives = new WeakMap<SessionTurn, TurnLive>();

function turnLive(turn: SessionTurn, projectPath: string): TurnLive {
  const existing = lives.get(turn);
  if (existing?.path === projectPath) return existing;
  const beats = computed(() => groupBeats(projectTurn(turn, projectPath)), { name: "turnBeats" });
  // A token changes response text but not beat identity, marks, or thought presence.
  // Object.is would treat each new outline array as a change and re-render every other beat.
  const outline = computed(
    () =>
      beats.get().map((beat) => ({
        id: beat.id,
        mark: beat.mark,
        model: beat.model,
        connection: beat.connection,
        hasThoughts: beat.thoughts.length > 0,
        agents: beat.agents.map((agent) => ({
          id: agent.id,
          background: agent.background,
          live: agent.outcome === "live",
        })),
        settles: beat.settles,
      })),
    { equals: comparer.structural, name: "turnOutline" },
  );
  const created = { path: projectPath, beats, outline };
  lives.set(turn, created);
  return created;
}

export function turnOutline(turn: SessionTurn, projectPath: string): readonly BeatOutline[] {
  return turnLive(turn, projectPath).outline.get();
}

export function turnBeats(turn: SessionTurn, projectPath: string): readonly TapeBeat[] {
  return turnLive(turn, projectPath).beats.get();
}
