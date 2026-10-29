/**
 * Session inbox: two lists, not a timing knob. Demote moves leftover steers
 * to the front of `promptQueue`.
 */
import { type UserPrompt } from "@inhuman.tools/harness-commons";

import { SessionAdmission } from "./SessionAdmission.js";
import type { SessionRoot } from "./SessionRoot.js";

export type AdmissionKind = "steer" | "queue";

/** TUI host verbs. `compact` and `rename` are system ops at dequeue. `agentic` / `background` never admit. */
export const HOST_QUEUE_VERBS = [
  "compact",
  "quit",
  "new",
  "rename",
  "agentic",
  "background",
  "rewind",
  "undo",
] as const;

export function admitSteer(
  root: SessionRoot,
  text: UserPrompt,
  composedAgainst: string,
  derivedMessage?: UserPrompt | null,
): SessionAdmission {
  return pushAdmission(root, "steer", text, composedAgainst, derivedMessage);
}

export function admitQueue(
  root: SessionRoot,
  text: UserPrompt,
  composedAgainst: string,
  derivedMessage?: UserPrompt | null,
): SessionAdmission {
  return pushAdmission(root, "queue", text, composedAgainst, derivedMessage);
}

function pushAdmission(
  root: SessionRoot,
  kind: AdmissionKind,
  text: UserPrompt,
  composedAgainst: string,
  derivedMessage?: UserPrompt | null,
): SessionAdmission {
  const row = new SessionAdmission({
    text,
    derivedMessage: derivedMessage ?? null,
    composedAtMs: Date.now(),
    composedAgainst,
  });
  if (kind === "steer") root.steerQueue.push(row);
  else root.promptQueue.push(row);
  return row;
}

/**
 * Turn exit: unclaimed steers move to the queue lane and run after the turn,
 * however it ended. A steer the user already sent is not dropped by Stop: it
 * is the next message, not part of the work that was stopped.
 *
 * `ownedBy` scopes the demotion to the rows composed against that turn (or
 * against none), so a
 * turn's close never touches a row a later turn is still waiting to claim.
 * Without it, every sitting row moves.
 */
export function demoteSteers(root: SessionRoot, ownedBy?: string): SessionAdmission[] {
  const moving: SessionAdmission[] = [];
  if (ownedBy === undefined) {
    moving.push(...root.steerQueue.splice(0));
  } else {
    for (let index = root.steerQueue.length - 1; index >= 0; index -= 1) {
      const row = root.steerQueue[index];
      // A row with no owner belongs to whoever closes first.
      if (row == null || (row.composedAgainst !== ownedBy && row.composedAgainst !== "")) continue;
      root.steerQueue.splice(index, 1);
      moving.unshift(row);
    }
  }
  if (moving.length === 0) return moving;
  root.promptQueue.unshift(...moving);
  return moving;
}

/** Empty-draft Enter: first queued row becomes a live-turn steer. Same object. */
export function steerFirstQueued(root: SessionRoot): SessionAdmission | undefined {
  const item = root.promptQueue.shift();
  if (item == null) return undefined;
  root.steerQueue.push(item);
  return item;
}

/** Empty-draft Esc: drop the last queued row. Does not touch `steerQueue`. */
export function retractLastQueued(root: SessionRoot): SessionAdmission | undefined {
  return root.promptQueue.pop();
}

/** `/Users/…`, `/tmp/…`, a second slash or backslash — not `/compact`. */
export function looksLikePath(text: string): boolean {
  const token = (text.split("\n")[0] ?? "").trim().split(/\s/)[0] ?? "";
  if (!token.startsWith("/")) return false;
  if (token.includes("/", 1) || token.includes("\\")) return true;
  const first = token.slice(1).split("/")[0] ?? "";
  return /^(Users|home|tmp|var|etc|opt|private|mnt|Volumes|usr)$/i.test(first);
}
