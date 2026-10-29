/** The composer draft is local UI state. The tape fills it when a message is edited. */

/** One unsent picture. Bytes are standard base64, with no `data:` prefix. */
export type DraftPicture = {
  readonly key: string;
  readonly mime: string;
  readonly bytesBase64: string;
  /** Null until the image has been measured. */
  readonly width: number | null;
  readonly height: number | null;
  /** A file name, or the path a reopened turn already stored. Never invented. */
  readonly sourcePath: string | null;
};

export type DraftPocket = {
  draft: string;
  pictures: DraftPicture[];
  revision: number;
  status: string;
};

export function cloneDraftPicture(picture: DraftPicture): DraftPicture {
  return {
    key: picture.key,
    mime: picture.mime,
    bytesBase64: picture.bytesBase64,
    width: picture.width,
    height: picture.height,
    sourcePath: picture.sourcePath,
  };
}

type Slot = {
  state: DraftPocket;
  refresh: () => void;
  focus: () => void;
  /** The prompt last placed here by an edit. Restore clears the draft only while it still matches. */
  filled: string | null;
};

function copyPictures(pictures: readonly DraftPicture[]): DraftPicture[] {
  return pictures.map(cloneDraftPicture);
}

const slots = new Map<string, Slot>();

export function bindDraft(sessionId: string, slot: Omit<Slot, "filled">): () => void {
  const next: Slot = { ...slot, filled: slots.get(sessionId)?.filled ?? null };
  slots.set(sessionId, next);
  return () => {
    if (slots.get(sessionId) === next) slots.delete(sessionId);
  };
}

export function hasDraftSlot(sessionId: string): boolean {
  return slots.has(sessionId);
}

/** `pictures` omitted means this draft has no pictures. */
export function fillDraft(sessionId: string, text: string, pictures?: readonly DraftPicture[]): void {
  const slot = slots.get(sessionId);
  if (slot == null) return;
  slot.state.draft = text;
  slot.state.pictures = pictures == null ? [] : copyPictures(pictures);
  slot.state.revision += 1;
  slot.state.status = "";
  slot.filled = text;
  slot.refresh();
  slot.focus();
}

export function noteDraft(sessionId: string, status: string): void {
  const slot = slots.get(sessionId);
  if (slot == null) return;
  slot.state.status = status;
  slot.refresh();
}

/** Drop an edit's prompt once the draft is still that prompt. A later keystroke is kept. Pictures clear with that prompt. */
export function releaseFilledDraft(sessionId: string): void {
  const slot = slots.get(sessionId);
  if (slot?.filled == null || slot.state.draft !== slot.filled) return;
  slot.state.draft = "";
  slot.state.pictures = [];
  slot.state.revision += 1;
  slot.filled = null;
  slot.refresh();
}
