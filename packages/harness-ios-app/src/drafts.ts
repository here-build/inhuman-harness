import { useEffect, useState } from "react";

export type DraftVisual = {
  readonly mime: string;
  readonly bytesBase64: string;
  readonly sourcePath?: string;
};

export type QueuedPrompt = {
  readonly prompt: string;
  readonly visuals: readonly DraftVisual[];
};

const NO_VISUALS: readonly DraftVisual[] = [];

const drafts = new Map<string, string>();
const visuals = new Map<string, readonly DraftVisual[]>();
const queued = new Map<string, QueuedPrompt>();
const listeners = new Set<() => void>();
let revision = 0;
let statusText = "";
let sending = false;
let stopping = "";

function emit(): void {
  revision += 1;
  for (const listen of listeners) listen();
}

/** One draft per place. The composer reads it from whichever screen is up. */
export function useDrafts(): void {
  const [, setRevision] = useState(revision);
  useEffect(() => {
    const listen = (): void => setRevision(revision);
    listeners.add(listen);
    return () => {
      listeners.delete(listen);
    };
  }, []);
}

export function readDraft(key: string): string {
  return drafts.get(key) ?? "";
}

export function writeDraft(key: string, value: string): void {
  if ((drafts.get(key) ?? "") === value) return;
  drafts.set(key, value);
  emit();
}

export function readVisuals(key: string): readonly DraftVisual[] {
  return visuals.get(key) ?? NO_VISUALS;
}

export function writeVisuals(key: string, next: readonly DraftVisual[]): void {
  const current = visuals.get(key) ?? NO_VISUALS;
  if (sameVisuals(current, next)) return;
  if (next.length === 0) visuals.delete(key);
  else visuals.set(key, next);
  emit();
}

export function peekPrompt(sessionId: string): QueuedPrompt | null {
  return queued.get(sessionId) ?? null;
}

export function queuePrompt(sessionId: string, prompt: string, pictures: readonly DraftVisual[] = NO_VISUALS): void {
  queued.set(sessionId, { prompt, visuals: [...pictures] });
  emit();
}

export function takePrompt(sessionId: string): QueuedPrompt | null {
  const turn = queued.get(sessionId);
  if (turn == null) return null;
  queued.delete(sessionId);
  emit();
  return turn;
}

export function readStatus(): string {
  return statusText;
}

export function writeStatus(value: string): void {
  if (statusText === value) return;
  statusText = value;
  emit();
}

export function isSending(): boolean {
  return sending;
}

export function markSending(value: boolean): void {
  if (sending === value) return;
  sending = value;
  emit();
}

export function stoppingTurn(): string {
  return stopping;
}

export function markStopping(turnId: string): void {
  if (stopping === turnId) return;
  stopping = turnId;
  emit();
}

function sameVisuals(left: readonly DraftVisual[], right: readonly DraftVisual[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((picture, index) => {
    const other = right[index];
    return (
      picture.mime === other.mime &&
      picture.bytesBase64 === other.bytesBase64 &&
      picture.sourcePath === other.sourcePath
    );
  });
}

/** Clipboard.getImage resolves "" or a data URL. The base64 is line-wrapped, and the mime is in the header. */
export function pictureFromClipboard(value: string): DraftVisual | null {
  const compact = value.replaceAll(/\s+/g, "");
  if (compact === "") return null;
  const marker = ";base64,";
  if (!compact.startsWith("data:")) return { mime: "image/png", bytesBase64: compact };
  const at = compact.indexOf(marker);
  if (at === -1) return null;
  const mime = compact.slice("data:".length, at).split(";")[0] ?? "";
  const bytesBase64 = compact.slice(at + marker.length);
  if (bytesBase64 === "") return null;
  return { mime: mime.startsWith("image/") && mime.length > "image/".length ? mime : "image/png", bytesBase64 };
}

/** An edited message's prompt and pictures land in that session's composer draft. */
export function applyEditedDraft(
  sessionId: string,
  prompt: string,
  pictures: readonly { readonly mime: string; readonly bytesBase64: string; readonly sourcePath: string | null }[],
): void {
  writeDraft(sessionId, prompt);
  writeVisuals(
    sessionId,
    pictures
      .filter((picture) => picture.mime.trim() !== "" && picture.bytesBase64.trim() !== "")
      .map((picture) =>
        picture.sourcePath != null && picture.sourcePath !== ""
          ? { mime: picture.mime, bytesBase64: picture.bytesBase64, sourcePath: picture.sourcePath }
          : { mime: picture.mime, bytesBase64: picture.bytesBase64 },
      ),
  );
}
