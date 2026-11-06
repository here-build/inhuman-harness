import type { Meta, StoryObj } from "@storybook/react-vite";
import { BotSpec } from "@inhuman.tools/harness-model";
import { prompt } from "@inhuman.tools/harness-commons";
import { runInAction } from "mobx";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { StoryApp } from "./story-app.js";
import { PROJECT, worldOf } from "./world.js";
import { projectHref } from "../shell/path.js";
import { resetNewSessions } from "../shell/new-session.js";

const meta = {
  title: "Graphic Precision/Working editor",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;
export default meta;
type Story = StoryObj<typeof meta>;

function stage() {
  // Staged drafts intentionally survive route remounts in the product; each
  // independent story starts from a fresh staged workspace.
  resetNewSessions();
  const dial = worldOf([], { kernel: { projects: [PROJECT] } });
  // KernelSpec.bots is the live worker roster, not configured recipe faces.
  runInAction(() => {
    for (const name of ["Code Reviewer", "Редактор длинных технических документов"]) {
      dial.kernel!.root.bots[name] = new BotSpec({ name, instructions: prompt.system`Review this work.` });
    }
  });
  return { dial, at: projectHref(PROJECT) };
}

/** The actual staged editor, not a design-only replica. */
export const AgentChoice: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Agent: Default" }));
    await waitFor(() => expect(canvas.getByRole("menuitemradio", { name: "Code Reviewer" })).toBeVisible());
    await userEvent.click(canvas.getByRole("menuitemradio", { name: "Code Reviewer" }));
    await expect(canvas.getByRole("button", { name: "Agent: Code Reviewer" })).toHaveFocus();
    await expect(canvas.queryByRole("menu")).toBeNull();
  },
};

/** Canonical skill identifiers are literal values; explanations stay natural case. */
export const SkillSuggestions: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const draft = await canvas.findByRole("textbox", { name: "Message draft" });
    await userEvent.type(draft, "/");
    await waitFor(() => expect(canvas.getByRole("listbox", { name: "Skills" })).toBeVisible());
    await expect(draft).toHaveFocus();
  },
};

export const CompleteSkillWithoutSending: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const draft = await canvas.findByRole("textbox", { name: "Message draft" });
    await userEvent.type(draft, "/rev");
    await waitFor(() => expect(canvas.getAllByRole("option").length).toBeGreaterThan(0));
    await userEvent.keyboard("{Enter}");
    await expect(draft).toHaveValue("/review ");
    await expect(draft).toHaveFocus();
    await expect(canvas.queryByRole("listbox", { name: "Skills" })).toBeNull();
  },
};
