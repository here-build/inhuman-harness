/**
 * Clipboard image, macOS only.
 *
 * A terminal paste delivers text. Pixels stay on the pasteboard, so a paste
 * that should become an image chip has to ask for them separately. The probe
 * is injectable: tests never call osascript.
 */
import { execFileSync } from "node:child_process";

import type { RichRun } from "../input/rich-draft.js";
import { intakePaste, type PasteInput } from "../input/rich-intake.js";

const IMAGE_CLASSES = ["PNGf", "TIFF picture"];

export type ClipboardImage = {
  readonly id: "clip";
  readonly mime: "image/png";
  readonly bytes: Buffer;
};

export type ClipboardProbe = {
  readonly platform: NodeJS.Platform;
  readonly info: string;
  readonly readPng: () => Buffer | string;
};

function darwinProbe(): ClipboardProbe {
  return {
    platform: process.platform,
    info: execFileSync("osascript", ["-e", "clipboard info"], { encoding: "utf8" }),
    readPng: () => {
      try {
        return execFileSync("osascript", ["-e", "get the clipboard as «class PNGf»"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const failed = error as { stderr?: string; stdout?: string };
        return `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
      }
    },
  };
}

export async function clipboardImage(probe: ClipboardProbe = darwinProbe()): Promise<ClipboardImage | null> {
  if (probe.platform !== "darwin") return null;
  if (!IMAGE_CLASSES.some((kind) => probe.info.includes(kind))) return null;
  const bytes = decodeClipboardPng(probe.readPng());
  if (bytes.length === 0) return null;
  return { id: "clip", mime: "image/png", bytes };
}

/** osascript prints either raw bytes or `«data PNGf<hex>»`. Both become a buffer. */
export function decodeClipboardPng(printed: Buffer | string): Buffer {
  const text = typeof printed === "string" ? printed : printed.toString("utf8");
  const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(text)?.[1];
  if (hex !== undefined) return Buffer.from(hex, "hex");
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => /^\d+$/.test(word));
  if (words.length > 0) return Buffer.from(words.map(Number));
  return typeof printed === "string" ? Buffer.alloc(0) : printed;
}

/**
 * Paste prefers pixels. A path that happens to end in `.png` stays text
 * unless the pasteboard actually holds an image.
 */
export async function pasteRuns(text: string, probe?: ClipboardProbe): Promise<readonly RichRun[]> {
  const image = await clipboardImage(probe);
  const input: PasteInput = image === null ? { text } : { text, image };
  return intakePaste(input);
}
