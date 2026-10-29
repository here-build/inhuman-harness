import { describe, expect, it } from "vitest";

import {
  applyEditedDraft,
  pictureFromClipboard,
  queuePrompt,
  readDraft,
  readVisuals,
  takePrompt,
  writeDraft,
  writeVisuals,
} from "./drafts.js";

const picture = { mime: "image/png", bytesBase64: "aaaa", sourcePath: "/tmp/shot.png" };

describe("picture queue", () => {
  it("keeps pictures with the prompt after the project draft is cleared", () => {
    writeDraft("project:/work", "look");
    writeVisuals("project:/work", [picture]);
    queuePrompt("minted", readDraft("project:/work"), readVisuals("project:/work"));
    writeDraft("project:/work", "");
    writeVisuals("project:/work", []);
    expect(readDraft("project:/work")).toBe("");
    expect(readVisuals("project:/work")).toEqual([]);
    expect(takePrompt("minted")).toEqual({ prompt: "look", visuals: [picture] });
    expect(takePrompt("minted")).toBeNull();
  });

  it("queues text alone when there are no pictures", () => {
    queuePrompt("text-only", "hello");
    expect(takePrompt("text-only")).toEqual({ prompt: "hello", visuals: [] });
  });
});

describe("edit draft", () => {
  it("writes the edited prompt and pictures, naming a picture only when it has a source", () => {
    writeDraft("edited", "old");
    writeVisuals("edited", [{ mime: "image/png", bytesBase64: "old" }]);
    applyEditedDraft("edited", "revised", [
      { mime: "image/jpeg", bytesBase64: "qq", sourcePath: null },
      { mime: "image/png", bytesBase64: "rr", sourcePath: "/tmp/rr.png" },
      { mime: "image/png", bytesBase64: "", sourcePath: null },
    ]);
    expect(readDraft("edited")).toBe("revised");
    expect(readVisuals("edited")).toEqual([
      { mime: "image/jpeg", bytesBase64: "qq" },
      { mime: "image/png", bytesBase64: "rr", sourcePath: "/tmp/rr.png" },
    ]);
  });
});

describe("clipboard picture", () => {
  it("reads a pasted image as mime plus base64, and ignores an empty clipboard", () => {
    expect(pictureFromClipboard("")).toBeNull();
    expect(pictureFromClipboard("   ")).toBeNull();
    expect(pictureFromClipboard("aaaa")).toEqual({ mime: "image/png", bytesBase64: "aaaa" });
    expect(pictureFromClipboard("data:image/png;base64,aa\nbb")).toEqual({
      mime: "image/png",
      bytesBase64: "aabb",
    });
    expect(pictureFromClipboard("data:image/jpeg;base64,qq==")).toEqual({
      mime: "image/jpeg",
      bytesBase64: "qq==",
    });
  });
});
