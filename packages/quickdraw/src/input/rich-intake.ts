import { intakePaste as intakeBlocks, type ImageBlock, type PromptRun } from "./prompt-blocks.js";
import type { RichRun } from "./rich-draft.js";

export type PasteInput = {
  readonly text?: string;
  readonly image?: { readonly id: string; readonly mime: string; readonly bytes?: Uint8Array };
  readonly index?: number;
};

/**
 * Rich-draft face of {@link intakeBlocks}. The index is not stored: a chip
 * carries the bytes, and the label is painted later from its position.
 */
export function intakePaste(input: PasteInput): RichRun[] {
  const image =
    input.image === undefined ? undefined : { ...input.image, bytes: input.image.bytes ?? new Uint8Array() };
  return intakeBlocks({ text: input.text, image }).map(toRichRun);
}

function toRichRun(run: PromptRun): RichRun {
  if (typeof run === "string") return run;
  if (run.kind === "text") return run.body;
  if (run.kind === "command") return `/${run.name}`;
  return imageChip(run);
}

function imageChip(block: ImageBlock): RichRun {
  return { kind: "image", id: "clip", clipboard: "", submit: `image:${block.mime}:${block.bytes.length}` };
}
