// @vitest-environment happy-dom
/**
 * Every story mounts over its frozen world and plays through.
 * Tape stories mount the transcript alone; the rest mount the whole app.
 * A story that throws, or a tape cell that falls back to its fence, fails here
 * before anyone opens Storybook.
 */
import { composeStories, setProjectAnnotations } from "@storybook/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import * as transcriptStories from "../../../harness-transcript/src/tape.stories.js";
import preview from "../../.storybook/preview.js";

type StoryModule = Parameters<typeof composeStories>[0];
type Playable = { run(context: { readonly canvasElement: HTMLElement }): Promise<void> };

const modules: Record<string, StoryModule> = {
  ...import.meta.glob<StoryModule>("../__stories__/*.stories.tsx", { eager: true }),
  "transcript/tape.stories.tsx": transcriptStories,
};

// happy-dom has no popover API. The platform owns open and dismiss; stories only need the calls to land.
for (const name of ["showPopover", "hidePopover", "togglePopover"] as const) {
  if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { value: () => false });
}

beforeAll(() => {
  setProjectAnnotations(preview);
  // No daemon serves `/file` here, as none does in Storybook: the sidebar meets the same 404.
  globalThis.fetch = async () => new Response("", { status: 404 });
});

let canvases: HTMLElement[] = [];
afterEach(() => {
  for (const canvas of canvases) canvas.remove();
  canvases = [];
});

describe.each(Object.entries(modules))("%s", (_, module) => {
  const stories = Object.entries(composeStories(module) as Record<string, Playable>);
  it.each(stories)("%s mounts and plays", async (_name, story) => {
    const canvasElement = document.createElement("div");
    document.body.append(canvasElement);
    canvases.push(canvasElement);
    await story.run({ canvasElement });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(canvasElement.textContent).not.toBe("");
    expect(canvasElement.textContent).not.toContain("could not be shown");
  });
});
