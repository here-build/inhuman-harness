import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { IconX } from "@tabler/icons-react";

import { Button } from "../primitives/button.js";
import { glyph } from "../primitives/glyph.js";
import { NativeDialog } from "../primitives/index.js";
import { useVoice } from "../voice/index.js";

/** One unsent picture. Bytes are standard base64, with no `data:` prefix. */
export interface DraftPicture {
  readonly key: string;
  readonly mime: string;
  readonly bytesBase64: string;
  /** Null until the image has been measured. */
  readonly width: number | null;
  readonly height: number | null;
  /** A file name, or the path a reopened turn already stored. Never invented. */
  readonly sourcePath: string | null;
}

/** What `turn` accepts. `sourcePath` is omitted when the chip has no name. */
export interface TurnVisualPayload {
  mime: string;
  bytesBase64: string;
  sourcePath?: string;
}

/** One `turn/visual` body. A remote URL is not a picture. */
export interface StoredVisual {
  readonly id: string;
  readonly mime: string;
  readonly bytesBase64: string;
  readonly width: number;
  readonly height: number;
  readonly resizedFrom: { readonly width: number; readonly height: number } | null;
  readonly sourcePath: string | null;
}

export type WindowDropPhase = "idle" | "over" | "hot";

const PICKED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface PictureDraftState {
  pictures: DraftPicture[];
  revision: number;
  status: string;
}

/** Files riding a drag. A drag with no files is not an add-image gesture. */
export function dragCarriesFiles(data: DataTransfer | null): boolean {
  if (data == null) return false;
  if (data.types.includes("Files")) return true;
  return [...data.items].some((item) => item.kind === "file");
}

/**
 * Window-level file drag. Entering the window is "over"; entering `hot` is
 * "hot". Leaving the hot target returns to "over" until the drag leaves the
 * window or ends. `relatedTarget` null is the window edge.
 */
export function bindWindowFileDrop(options: {
  readonly hot: () => Element | null;
  readonly onPhase: (phase: WindowDropPhase) => void;
  readonly onDrop: (files: readonly File[]) => void;
}): () => void {
  const root = document.documentElement;
  let phase: WindowDropPhase = "idle";
  let insideHot = false;

  const paint = (next: WindowDropPhase): void => {
    if (phase === next) return;
    phase = next;
    options.onPhase(next);
  };

  const enteredHot = (event: DragEvent): boolean => {
    const target = options.hot();
    return target != null && event.target instanceof Node && target.contains(event.target);
  };

  const onEnter = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (enteredHot(event)) insideHot = true;
    paint(insideHot ? "hot" : "over");
  };

  const onOver = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer != null) event.dataTransfer.dropEffect = "copy";
    const nextInside = enteredHot(event);
    if (nextInside === insideHot && phase !== "idle") return;
    insideHot = nextInside;
    paint(insideHot ? "hot" : "over");
  };

  const onLeave = (event: DragEvent): void => {
    if (phase === "idle") return;
    const next = event.relatedTarget;
    if (next instanceof Node && root.contains(next)) return;
    insideHot = false;
    paint("idle");
  };

  const finish = (): void => {
    insideHot = false;
    paint("idle");
  };

  const onDrop = (event: DragEvent): void => {
    if (!dragCarriesFiles(event.dataTransfer)) {
      finish();
      return;
    }
    event.preventDefault();
    const files = event.dataTransfer == null ? [] : [...event.dataTransfer.files];
    finish();
    if (files.length > 0) options.onDrop(files);
  };

  root.addEventListener("dragenter", onEnter);
  root.addEventListener("dragover", onOver);
  root.addEventListener("dragleave", onLeave);
  root.addEventListener("drop", onDrop);
  window.addEventListener("drop", finish);
  window.addEventListener("dragend", finish);

  return () => {
    root.removeEventListener("dragenter", onEnter);
    root.removeEventListener("dragover", onOver);
    root.removeEventListener("dragleave", onLeave);
    root.removeEventListener("drop", onDrop);
    window.removeEventListener("drop", finish);
    window.removeEventListener("dragend", finish);
    finish();
  };
}

export function chipLabel(picture: DraftPicture): string {
  const name = picture.sourcePath?.trim() ?? "";
  const size = picture.width == null || picture.height == null ? "" : `${picture.width}×${picture.height}`;
  if (name !== "" && size !== "") return `${name} · ${picture.mime} · ${size}`;
  if (name !== "") return `${name} · ${picture.mime}`;
  if (size === "") return picture.mime;
  return `${picture.mime} · ${size}`;
}

/** A data URL the chip can paint. Remote bytes are not a preview. */
export function picturePreviewUrl(picture: DraftPicture): string | null {
  if (!picture.mime.startsWith("image/")) return null;
  if (picture.bytesBase64.trim() === "") return null;
  if (remote(picture.bytesBase64) || remote(picture.mime)) return null;
  return `data:${picture.mime};base64,${picture.bytesBase64}`;
}

export function turnVisualPayload(pictures: readonly DraftPicture[]): TurnVisualPayload[] {
  const visuals: TurnVisualPayload[] = [];
  for (const picture of pictures) {
    if (picture.mime.trim() === "" || picture.bytesBase64.trim() === "") continue;
    const source = picture.sourcePath;
    if (source != null && source.trim() !== "") {
      visuals.push({ mime: picture.mime, bytesBase64: picture.bytesBase64, sourcePath: source });
    } else {
      visuals.push({ mime: picture.mime, bytesBase64: picture.bytesBase64 });
    }
  }
  return visuals;
}

export function draftFromStored(visual: StoredVisual): DraftPicture {
  return {
    key: visual.id,
    mime: visual.mime,
    bytesBase64: visual.bytesBase64,
    width: visual.width,
    height: visual.height,
    sourcePath: visual.sourcePath,
  };
}

/** Clipboard images only. A file name on a paste is not a source path. */
export function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (data == null) return [];
  const files: File[] = [];
  for (const item of data.items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file != null) files.push(file);
  }
  return files;
}

/**
 * `named` is the file input: the chip's source path is the file name, not a path.
 * A paste leaves `sourcePath` empty.
 */
export async function readDraftPictures(files: readonly File[], named: boolean): Promise<DraftPicture[]> {
  const pictures: DraftPicture[] = [];
  for (const file of files) {
    const picture = await readOne(file, named);
    if (picture != null) pictures.push(picture);
  }
  return pictures;
}

export async function adoptPictureFiles(
  state: PictureDraftState,
  files: readonly File[],
  named: boolean,
  refresh: () => void,
): Promise<void> {
  const wanted = files.filter((file) => (named ? PICKED_MIMES.has(file.type) : file.type.startsWith("image/")));
  if (wanted.length === 0) return;
  const added = await readDraftPictures(wanted, named);
  if (added.length === 0) {
    state.status = "The picture could not be read.";
    refresh();
    return;
  }
  state.pictures = [...state.pictures, ...added];
  state.revision += 1;
  state.status = "";
  refresh();
  void measurePictures(state, added, refresh);
}

/** Identity from the turn, bytes from `turn/visual`. An http(s) value is refused. */
export function readStoredVisual(result: unknown): StoredVisual | null {
  if (!isRecord(result)) return null;
  const id = text(result, "id");
  const mime = text(result, "mime");
  const bytesBase64 = text(result, "bytesBase64");
  const width = count(result, "width");
  const height = count(result, "height");
  const resizedFrom = readResized(result);
  const sourcePath = readSource(result);
  if (id == null || mime == null || bytesBase64 == null || width == null || height == null) return null;
  if (resizedFrom === undefined || sourcePath === undefined) return null;
  if (id.trim() === "" || bytesBase64.trim() === "" || !usableMime(mime)) return null;
  if (remote(bytesBase64) || remote(mime)) return null;
  return { id, mime, bytesBase64, width, height, resizedFrom, sourcePath };
}

export interface PictureChipsBlockProps {
  readonly pictures: readonly DraftPicture[];
  readonly onRemove: (key: string) => void;
  readonly onPick: (files: readonly File[]) => void;
  readonly disabled?: boolean;
}

/** The file input and the attachment chips that sit inside the composer pill. */
export function PictureChipsBlock({ pictures, onRemove, onPick, disabled = false }: PictureChipsBlockProps) {
  const voice = useVoice();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const open = pictures.find((picture) => picture.key === openKey) ?? null;
  const openPreview = open == null ? null : picturePreviewUrl(open);

  return (
    <>
      <input
        className="composer-file sr-only"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label={voice.composer.attachImageLabel}
        tabIndex={-1}
        multiple
        disabled={disabled}
        onChange={(event) => {
          const chosen = event.currentTarget.files;
          const files = chosen == null ? [] : [...chosen];
          event.currentTarget.value = "";
          if (files.length > 0) onPick(files);
        }}
      />
      {pictures.length === 0 ? null : (
        <ul className="composer-chips" aria-label={voice.composer.attachmentsLabel}>
          {pictures.map((picture) => {
            const preview = picturePreviewUrl(picture);
            const label = chipLabel(picture);
            return (
              <li key={picture.key} className="composer-chip" title={label}>
                <Button
                  variant="ghost"
                  className="composer-chip-open focus-visible:-outline-offset-2 data-[focus-visible]:-outline-offset-2"
                  aria-label={label}
                  disabled={disabled || preview == null}
                  onClick={() => setOpenKey(picture.key)}
                >
                  {preview == null ? null : <img className="composer-chip-preview" src={preview} alt="" />}
                </Button>
                <Button
                  variant="ghost"
                  className="composer-chip-remove p-0 focus-visible:-outline-offset-2 data-[focus-visible]:-outline-offset-2"
                  aria-label={`${voice.common.remove} ${label}`}
                  disabled={disabled}
                  onClick={() => onRemove(picture.key)}
                >
                  <IconX {...glyph} aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {open == null || openPreview == null ? null : (
        <PicturePreviewModal url={openPreview} label={chipLabel(open)} onClose={() => setOpenKey(null)} />
      )}
    </>
  );
}

function PicturePreviewModal({
  url,
  label,
  onClose,
}: {
  readonly url: string;
  readonly label: string;
  readonly onClose: () => void;
}) {
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (node == null || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, [node]);
  return (
    <NativeDialog
      ref={setNode}
      className="picture-preview"
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <img src={url} alt={label} />
    </NativeDialog>
  );
}

export interface PictureDropSurfaceProps {
  readonly fieldRef: RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
  readonly onDrop: (files: readonly File[]) => void;
  readonly children: ReactNode;
}

/** Drop zone container wrapping the composer input pill for window-wide file drops. */
export function PictureDropSurface({ fieldRef, enabled, onDrop, children }: PictureDropSurfaceProps) {
  const voice = useVoice();
  const [phase, setPhase] = useState<WindowDropPhase>("idle");

  useEffect(() => {
    if (!enabled) return;
    return bindWindowFileDrop({
      hot: () => fieldRef.current,
      onPhase: setPhase,
      onDrop,
    });
  }, [enabled, fieldRef, onDrop]);

  useEffect(() => {
    if (enabled) return;
    setPhase("idle");
  }, [enabled]);

  return (
    <div
      ref={fieldRef}
      className="composer-pill relative overflow-hidden"
      data-drop={phase === "idle" ? undefined : phase}
    >
      {children}
      {phase === "idle" ? null : (
        <div className="composer-drop label" aria-hidden="true">
          {voice.composer.dropHint}
        </div>
      )}
    </div>
  );
}

async function readOne(file: File, named: boolean): Promise<DraftPicture | null> {
  const mime = file.type;
  if (named) {
    if (!PICKED_MIMES.has(mime)) return null;
  } else if (!mime.startsWith("image/")) return null;
  try {
    const bytesBase64 = await blobBase64(file);
    if (bytesBase64.trim() === "") return null;
    const name = named ? fileName(file.name) : "";
    return {
      key: crypto.randomUUID(),
      mime,
      bytesBase64,
      width: null,
      height: null,
      sourcePath: name === "" ? null : name,
    };
  } catch {
    return null;
  }
}

function fileName(name: string): string {
  const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = slash === -1 ? name : name.slice(slash + 1);
  return base.trim();
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const size = 0x8000;
  for (let index = 0; index < bytes.length; index += size) {
    const chunk = bytes.subarray(index, index + size);
    let piece = "";
    for (const byte of chunk) piece += String.fromCodePoint(byte);
    binary += piece;
  }
  return btoa(binary);
}

async function measurePictures(
  state: PictureDraftState,
  added: readonly DraftPicture[],
  refresh: () => void,
): Promise<void> {
  for (const picture of added) {
    const size = await pictureSize(picture.mime, picture.bytesBase64);
    if (size == null) continue;
    if (!state.pictures.some((item) => item.key === picture.key)) continue;
    state.pictures = state.pictures.map((item) =>
      item.key === picture.key ? { ...item, width: size.width, height: size.height } : item,
    );
    refresh();
  }
}

async function pictureSize(mime: string, bytesBase64: string): Promise<{ width: number; height: number } | null> {
  if (remote(bytesBase64) || remote(mime)) return null;
  const image = new Image();
  image.src = `data:${mime};base64,${bytesBase64}`;
  try {
    await image.decode();
  } catch {
    return null;
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  return width > 0 && height > 0 ? { width, height } : null;
}

function readResized(value: object): { width: number; height: number } | null | undefined {
  if (!Object.hasOwn(value, "resizedFrom")) return undefined;
  const found = own(value, "resizedFrom");
  if (found === null) return null;
  if (!isRecord(found)) return undefined;
  const width = count(found, "width");
  const height = count(found, "height");
  if (width == null || height == null) return undefined;
  return { width, height };
}

function readSource(value: object): string | null | undefined {
  if (!Object.hasOwn(value, "sourcePath")) return undefined;
  const found = own(value, "sourcePath");
  if (found === null) return null;
  return typeof found === "string" ? found : undefined;
}

function usableMime(mime: string): boolean {
  if (mime.trim() === "" || mime !== mime.trim()) return false;
  return !mime.includes(" ") && !mime.includes(";");
}

function remote(value: string): boolean {
  const head = value.trim().toLowerCase();
  return head.startsWith("http://") || head.startsWith("https://");
}

function text(value: object, key: string): string | null {
  const found = own(value, key);
  return typeof found === "string" ? found : null;
}

function count(value: object, key: string): number | null {
  const found = own(value, key);
  return typeof found === "number" && Number.isInteger(found) && found > 0 ? found : null;
}

function own(value: object, key: string): unknown {
  if (!Object.hasOwn(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor == null || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
