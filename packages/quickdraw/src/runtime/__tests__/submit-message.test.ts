import { expect, test } from "vitest";

import { submitRuns, type CommandBlock, type ImageBlock, type TextBlock } from "../../input/prompt-blocks.js";
import { receiveSubmit, submitMessage, type ResizeMessage, type SubmitMessage } from "../box_bus.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const pasted: TextBlock = { kind: "text", body: "line\nline" };
const shot: ImageBlock = { kind: "image", mime: "image/png", bytes: png };
const connect: CommandBlock = { kind: "command", name: "connect", args: { target: "LM Studio" } };

test("a submit message carries model parts and the command, and clones", () => {
  const message = submitMessage(submitRuns(["see ", pasted, shot, connect]));
  const cloned = structuredClone(message) as SubmitMessage;
  expect(cloned).toEqual({
    kind: "submit",
    parts: [{ text: "see " }, { text: "line\nline" }, { image: { mime: "image/png", bytes: png } }],
    command: { name: "connect", args: { target: "LM Studio" } },
  });
});

test("no command is null, not an empty object", () => {
  expect(submitMessage(submitRuns(["hi"])).command).toBeNull();
});

test("the host reads parts and the command without joining them", () => {
  const message = submitMessage(submitRuns(["see ", pasted, shot, connect]));
  expect(receiveSubmit(message)).toEqual({
    parts: [{ text: "see " }, { text: "line\nline" }, { image: { mime: "image/png", bytes: png } }],
    command: { name: "connect", args: { target: "LM Studio" } },
  });
});

test("a non-submit message is refused", () => {
  const resize: ResizeMessage = { kind: "resize", cols: 1, rows: 1 };
  expect(receiveSubmit(resize)).toBeNull();
});
