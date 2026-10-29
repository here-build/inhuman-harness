/**
 * Live shell tails. Awareness last-write, not a Yjs body. The spill file
 * holds the bytes; this frame is the last-N peek the operator and the
 * model share.
 *
 * One lane (`shell-tails`) holds the map. Schema is append-only
 * (`PlexusAwareness.MAX_LANES` = 64); a lane per job exhausts the budget
 * and crashes the daemon on the 65th announce. Retract the uuid on seal —
 * sealed paint reads `outcomeJson`, not this map.
 *
 * Reads go through the lane atom, the same way `roleOf` does. An unhomed
 * job has no hub, so a report there is absence. A process-local atom
 * would miss every peer frame.
 */
import { type PlexusAwareness } from "@here.build/plexus";
import { docPlexus } from "@here.build/plexus/internals";
import { MapFieldAwareness, SHELL_TAILS_LANE, type SessionAwareness } from "@inhuman.tools/plexus-expectations";

import { ToolCallJob } from "./jobs/ToolCallJob.js";

export type ShellTail = {
  readonly text: string;
  readonly totalBytes: number;
};

class ShellTailAwareness extends MapFieldAwareness<PlexusAwareness<SessionAwareness>, typeof SHELL_TAILS_LANE> {
  constructor(hub: PlexusAwareness<SessionAwareness>) {
    super(hub, SHELL_TAILS_LANE);
  }

  /** A frame that does not parse is absence, so a bad local cell does not hide a peer frame. */
  override mapGet(uuid: string): ShellTail | null {
    const own = this.#frame(this.get(), uuid);
    if (own !== null) return own;
    for (const id of this.clientIds) {
      const frame = this.#frame(this.getOther(id), uuid);
      if (frame !== null) return frame;
    }
    return null;
  }

  #frame(value: unknown, uuid: string): ShellTail | null {
    if (!isRecord(value)) return null;
    return readShellTail(value[uuid]);
  }
}

export function reportShellTail(job: ToolCallJob, frame: ShellTail): void {
  const lane = laneOf(job);
  if (lane == null) return;
  lane.mapSet(job.uuid, frame);
}

export function retractShellTail(job: ToolCallJob): void {
  const lane = laneOf(job);
  if (lane == null) return;
  lane.mapDelete(job.uuid);
}

/** First frame for this job across bases. A missing key is null. */
export function shellTailOf(job: ToolCallJob): ShellTail | null {
  return laneOf(job)?.mapGet(job.uuid) ?? null;
}

function laneOf(job: ToolCallJob): ShellTailAwareness | null {
  const doc = job.__doc__;
  if (doc == null) return null;
  const awareness = docPlexus.get(doc)?.awareness;
  if (awareness == null) return null;
  return new ShellTailAwareness(awareness as PlexusAwareness<SessionAwareness>);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readShellTail(value: unknown): ShellTail | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("text" in value) || !("totalBytes" in value)) return null;
  const { text, totalBytes } = value;
  if (typeof text !== "string" || typeof totalBytes !== "number") return null;
  return { text, totalBytes };
}
