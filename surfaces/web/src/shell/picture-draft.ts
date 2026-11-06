import type { DraftPicture } from "./draft-slot.js";

/** What `turn` accepts. `sourcePath` is omitted when the chip has no name. */
export type TurnVisualPayload = {
  mime: string;
  bytesBase64: string;
  sourcePath?: string;
};

/** One `turn/visual` body. A remote URL is not a picture. */
export type StoredVisual = {
  readonly id: string;
  readonly mime: string;
  readonly bytesBase64: string;
  readonly width: number;
  readonly height: number;
  readonly resizedFrom: { readonly width: number; readonly height: number } | null;
  readonly sourcePath: string | null;
};

const PICKED_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type PictureDraftState = {
  pictures: DraftPicture[];
  revision: number;
  status: string;
};

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
