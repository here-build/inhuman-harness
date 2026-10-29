/**
 * Honest prompt runs.
 *
 * A string is what was typed. A text block is a paste: the body is the whole
 * insertion, and the short form is derived, never stored. An image block is
 * bytes. Its label is derived the same way, so the chip cannot drift from
 * the payload.
 */

export const PASTE_TEXT_MIN = 800;

export type TextBlock = {
  readonly kind: "text";
  readonly body: string;
};

export type ImageBlock = {
  readonly kind: "image";
  readonly mime: string;
  readonly bytes: Uint8Array;
};

export type CommandBlock = {
  readonly kind: "command";
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
};

export type PromptRun = string | TextBlock | ImageBlock | CommandBlock;

export type PromptPaste = {
  readonly text?: string;
  readonly image?: { readonly id: string; readonly mime: string; readonly bytes: Uint8Array };
};

export function textLabel(block: TextBlock): string {
  const lines = block.body.split("\n").length;
  return `[Pasted text +${lines - 1} lines]`;
}

export function commandLabel(block: CommandBlock): string {
  return `/${block.name}`;
}

export type ModelPart =
  { readonly text: string } | { readonly image: { readonly mime: string; readonly bytes: Uint8Array } };

export type PromptSubmit = {
  readonly parts: readonly ModelPart[];
  readonly command: { readonly name: string; readonly args: Readonly<Record<string, string>> } | null;
  readonly extra: readonly { readonly name: string; readonly args: Readonly<Record<string, string>> }[];
};

/** Text and images go to the model. The first command is the command. */
export function submitRuns(runs: readonly PromptRun[]): PromptSubmit {
  const parts: ModelPart[] = [];
  const commands: PromptSubmit["extra"][number][] = [];
  for (const run of runs) {
    if (typeof run === "string") parts.push({ text: run });
    else if (run.kind === "text") parts.push({ text: run.body });
    else if (run.kind === "image") parts.push({ image: { mime: run.mime, bytes: run.bytes } });
    else commands.push({ name: run.name, args: run.args });
  }
  return { parts, command: commands[0] ?? null, extra: commands.slice(1) };
}

export function imageLabel(block: ImageBlock, index?: number): string {
  void block;
  return typeof index === "number" && index > 0 ? `[Image #${index}]` : "[Image]";
}

export function intakePaste(input: PromptPaste): PromptRun[] {
  if (input.image) {
    return [{ kind: "image", mime: input.image.mime, bytes: input.image.bytes }];
  }
  const text = input.text ?? "";
  if (text.length === 0) return [""];
  if (text.length >= PASTE_TEXT_MIN) return [{ kind: "text", body: text }];
  return [text];
}
