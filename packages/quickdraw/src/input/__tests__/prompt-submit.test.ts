import { expect, test } from "vitest";

import { commandLabel, submitRuns, type CommandBlock, type ImageBlock, type TextBlock } from "../prompt-blocks.js";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const pasted: TextBlock = { kind: "text", body: "line\nline" };
const shot: ImageBlock = { kind: "image", mime: "image/png", bytes: png };
const connect: CommandBlock = { kind: "command", name: "connect", args: { target: "LM Studio" } };

test("a submit splits model parts from a command", () => {
  expect(submitRuns(["see ", pasted, shot, connect])).toEqual({
    parts: [{ text: "see " }, { text: "line\nline" }, { image: { mime: "image/png", bytes: png } }],
    command: { name: "connect", args: { target: "LM Studio" } },
    extra: [],
  });
});

test("a command label is the name, never a stored string", () => {
  expect(commandLabel(connect)).toBe("/connect");
});

test("two commands keep the first and report the rest", () => {
  const second: CommandBlock = { kind: "command", name: "plan", args: {} };
  expect(submitRuns([connect, second]).command).toEqual({ name: "connect", args: { target: "LM Studio" } });
  expect(submitRuns([connect, second]).extra).toEqual([{ name: "plan", args: {} }]);
});
