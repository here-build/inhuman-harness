import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";

import { conversation, looks } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { session, speech, tool } from "./world.js";

const meta = {
  title: "File preview",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Each item of a look run opens what it saw in the sidebar. */
const open = (label: string): Story["play"] =>
  async function play({ canvasElement }) {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: label }));
  };

/** A file read in full opens from the bytes the tool already has, highlighted. */
export const SourceFile: Story = {
  args: { stage: sessionStage(conversation) },
  play: open("packages/harness-web-app/src/shell/tape-read.ts"),
};

/** A Markdown file renders as prose. */
export const MarkdownFile: Story = { args: { stage: sessionStage(looks) }, play: open("README.md") };

/** A directory opens its listing. */
export const Listing: Story = {
  args: { stage: sessionStage(conversation) },
  play: open("packages/harness-web-app/src/shell/"),
};

/** A search opens its matches. */
export const SearchResults: Story = { args: { stage: sessionStage(conversation) }, play: open("update_metadata") };

/** A partial read opens from disk; with no daemon serving `/file` the sidebar says it is not found. */
export const NotOnDisk: Story = {
  args: {
    stage: sessionStage(() =>
      session({
        id: "partial",
        turns: [
          {
            prompt: "show me the head of app.tsx",
            work: [
              tool(
                "read_file",
                { path: "src/app.tsx", offset: 1, limit: 20 },
                { result: 'import { useState } from "react";' },
              ),
              speech("That is the router's entry."),
            ],
          },
        ],
      }),
    ),
  },
  play: open("src/app.tsx"),
};
