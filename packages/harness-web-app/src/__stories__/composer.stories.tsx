import type { SessionPlexus } from "@inhuman.tools/harness-peer";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { runInAction } from "mobx";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { approval, conversation, fresh, running, STYLES } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { asking, edit } from "./world.js";

const meta = {
  title: "Composer",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

const draft = (canvas: HTMLElement) => within(canvas).getByLabelText("Message draft");

/** Nothing typed: no Send, the model selector beside the field. */
export const Empty: Story = { args: { stage: sessionStage(fresh) } };

/** A draft shows Send. */
export const Drafting: Story = {
  args: { stage: sessionStage(conversation) },
  play: async ({ canvasElement }) => {
    await userEvent.type(draft(canvasElement), "now make the narrow layout match");
  },
};

/** A live turn with an empty draft offers Stop; Esc does the same. */
export const Running: Story = { args: { stage: sessionStage(running) } };

/** The port refused the message: the draft stays and the composer says so. */
export const Refused: Story = {
  args: { stage: sessionStage(conversation, { refuse: true }) },
  play: async ({ canvasElement }) => {
    await userEvent.type(draft(canvasElement), "one more pass{Enter}");
  },
};

/** A call waits on you: the cover shows the proposed edit as the tape will. */
export const ApprovalDiff: Story = { args: { stage: sessionStage(() => approval("diff")) } };

/** The proposed operation is a command. */
export const ApprovalShell: Story = { args: { stage: sessionStage(() => approval("shell")) } };

/** The proposed operation has only arguments to show. */
export const ApprovalArguments: Story = { args: { stage: sessionStage(() => approval("args")) } };

let drafting: SessionPlexus | null = null;

/** An ask lands while you type: the cover holds its buttons for a beat, then arms. */
export const ApprovalWhileDrafting: Story = {
  args: {
    stage: sessionStage(() => {
      drafting = running();
      return drafting;
    }),
  },
  play: async ({ canvasElement }) => {
    await userEvent.type(draft(canvasElement), "also check the narrow page");
    const head = drafting?.root.head;
    if (head == null) return;
    runInAction(() => {
      const ask = asking(
        edit("src/styles.css", STYLES, "  border-radius: 4px;", "  border-radius: var(--radius-md);", { live: true }),
      );
      head.doneWork.push(ask);
      head.pushChild(ask);
    });
    await within(canvasElement).findByText(/Decisions unlock after a short pause/);
    await expect(within(canvasElement).queryByText("Please wait…")).toBeNull();
    await expect(within(canvasElement).queryByText("Awaiting decision")).toBeNull();
  },
};

const trigger = (canvas: HTMLElement) => within(canvas).getByRole("button", { name: /^Model:/ });

/** The picker open: each provider with who is signed in and what is left; a failed wire says why. */
export const PickerOpen: Story = {
  args: { stage: sessionStage(conversation) },
  play: async ({ canvasElement }) => {
    await userEvent.click(trigger(canvasElement));
  },
};

/** Typing searches every provider at once. */
export const PickerSearch: Story = {
  args: { stage: sessionStage(conversation) },
  play: async ({ canvasElement }) => {
    await userEvent.click(trigger(canvasElement));
    await userEvent.keyboard("grok");
  },
};

/** A provider's models open beside its row. */
export const PickerProvider: Story = {
  args: { stage: sessionStage(conversation) },
  play: async ({ canvasElement }) => {
    await userEvent.click(trigger(canvasElement));
    const row = await waitFor(() => {
      const found = canvasElement.ownerDocument.querySelector<HTMLElement>(".model-wire");
      if (found == null) throw new Error("no provider rows");
      return found;
    });
    await userEvent.click(row);
  },
};

/** A connection lists no models yet: the model is named, not offered. */
export const NoCatalog: Story = {
  args: { stage: sessionStage(conversation, { kernel: { wires: [{ id: "chatgpt", name: "ChatGPT", models: [] }] } }) },
};
