import type { SessionTurn, UserVisualIdentity } from "@inhuman.tools/harness-model";
import { isAtTip, previousPin, resolvedTip } from "@inhuman.tools/harness-model/session";

import { fillDraft, hasDraftSlot, noteDraft, releaseFilledDraft } from "./draft-slot.js";
import { readEmbed } from "./embed.js";
import { draftFromStored, readStoredVisual, type StoredVisual } from "./picture-draft.js";

type Rpc = {
  request: (method: string, params: unknown) => Promise<unknown>;
};

export type EditClient = {
  readonly attaching: boolean;
  readonly link: unknown;
  readonly session: {
    readonly root: {
      readonly uuid: string;
      findRunningTurn: () => unknown;
    };
  } | null;
  readonly sessionRpc: Rpc | null;
};

export type EditCut =
  | { readonly kind: "prefill"; readonly prompt: string; readonly visuals: readonly UserVisualIdentity[] }
  | {
      readonly kind: "rewind";
      readonly turnId: string;
      readonly prompt: string;
      readonly visuals: readonly UserVisualIdentity[];
    };

/**
 * Confirming a message cuts to the pin before it, because that prompt is what
 * gets resent. The first pin has no earlier pin, so the draft is filled and
 * the tape stays. Same cut as TUI history confirm (`packages/harness/src/tui/tea.ts`).
 */
export function editCut(turn: SessionTurn): EditCut {
  const text = String(turn.prompt);
  const visuals = turn.visuals;
  const before = previousPin(turn);
  if (before == null) return { kind: "prefill", prompt: text, visuals };
  return { kind: "rewind", turnId: before.uuid, prompt: text, visuals };
}

/** The turn `turn/rewind` names to put head back on the retained tip. Null while already there. */
export function restoreTarget(head: SessionTurn, tip: SessionTurn | null): string | null {
  if (isAtTip(head, tip)) return null;
  return resolvedTip(head, tip)?.uuid ?? null;
}

const inflight = new Set<string>();

export function canEditMessages(client: EditClient): boolean {
  return (
    client.session != null &&
    client.sessionRpc != null &&
    !client.attaching &&
    client.link == null &&
    client.session.root.findRunningTurn() == null
  );
}

/** Where an edit's prompt lands when the page has no composer of its own: the native client's draft. */
export type EditSink = (prompt: string, visuals: readonly StoredVisual[]) => void;

export async function editMessage(client: EditClient, turn: SessionTurn, sink?: EditSink): Promise<void> {
  const session = client.session;
  const rpc = client.sessionRpc;
  if (session == null || rpc == null || !canEditMessages(client)) return;
  const key = session.root.uuid;
  if (inflight.has(key)) return;
  // Rewinding with nowhere to put the prompt would drop the message.
  const bridged = sink != null || embedPoster() != null;
  if (!hasDraftSlot(key) && !bridged) return;
  const cut = editCut(turn);
  inflight.add(key);
  try {
    const opened = await reopenVisuals(rpc, cut.visuals);
    if (client.session !== session) return;
    if (opened == null) {
      noteDraft(key, "The picture could not be reopened.");
      return;
    }
    if (cut.kind === "rewind") {
      try {
        const result = await rpc.request("turn/rewind", { turnId: cut.turnId });
        if (!isOk(result)) {
          noteDraft(key, "That message could not be edited.");
          return;
        }
      } catch (error) {
        noteDraft(key, error instanceof Error ? error.message : "That message could not be edited.");
        return;
      }
      if (client.session !== session) return;
    }
    fillDraft(key, cut.prompt, opened.map(draftFromStored));
    postEditDraft(cut.prompt, opened);
    sink?.(cut.prompt, opened);
  } finally {
    inflight.delete(key);
  }
}

export async function restoreMessages(client: EditClient, head: SessionTurn, tip: SessionTurn | null): Promise<void> {
  const session = client.session;
  const rpc = client.sessionRpc;
  const turnId = restoreTarget(head, tip);
  if (session == null || rpc == null || turnId == null || !canEditMessages(client) || inflight.has(session.root.uuid))
    return;
  const key = session.root.uuid;
  inflight.add(key);
  try {
    const result = await rpc.request("turn/rewind", { turnId });
    if (client.session !== session) return;
    if (!isOk(result)) {
      noteDraft(key, "Later messages were not restored.");
      return;
    }
    releaseFilledDraft(key);
  } catch (error) {
    noteDraft(key, error instanceof Error ? error.message : "Later messages were not restored.");
  } finally {
    inflight.delete(key);
  }
}

async function reopenVisuals(
  rpc: Rpc,
  visuals: readonly UserVisualIdentity[],
): Promise<readonly StoredVisual[] | null> {
  const opened: StoredVisual[] = [];
  for (const visual of visuals) {
    const read = await reopenOne(rpc, visual.id);
    if (read == null) return null;
    opened.push(read);
  }
  return opened;
}

async function reopenOne(rpc: Rpc, id: string): Promise<StoredVisual | null> {
  try {
    const read = readStoredVisual(await rpc.request("turn/visual", { id }));
    if (read?.id !== id) return null;
    return read;
  } catch {
    return null;
  }
}

/** Present only inside `?embed=1` when the native shell is listening. */
function embedPoster(): ((body: string) => void) | null {
  if (typeof window === "undefined") return null;
  if (!readEmbed(window.location.search).active) return null;
  const bridge: unknown = Reflect.get(window, "ReactNativeWebView");
  if (typeof bridge !== "object" || bridge == null) return null;
  const post: unknown = Reflect.get(bridge, "postMessage");
  if (typeof post !== "function") return null;
  return (body: string) => {
    Reflect.apply(post, bridge, [body]);
  };
}

function postEditDraft(prompt: string, visuals: readonly StoredVisual[]): void {
  const post = embedPoster();
  if (post == null) return;
  const body: {
    kind: "inhuman:edit-draft";
    prompt: string;
    visuals: StoredVisual[];
  } = {
    kind: "inhuman:edit-draft",
    prompt,
    visuals: visuals.map((visual) => ({
      id: visual.id,
      mime: visual.mime,
      bytesBase64: visual.bytesBase64,
      width: visual.width,
      height: visual.height,
      resizedFrom: visual.resizedFrom,
      sourcePath: visual.sourcePath,
    })),
  };
  post(JSON.stringify(body));
}

function isOk(result: unknown): boolean {
  return typeof result === "object" && result != null && "ok" in result && result.ok === true;
}
