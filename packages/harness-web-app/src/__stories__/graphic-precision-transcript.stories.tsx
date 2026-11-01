/* eslint-disable import-x/no-relative-packages -- Story fixture renders the workspace transcript. */
import { FailureOutcome } from "@inhuman.tools/harness-model";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { agents, agentWorkers, agentWorkerTapes, looks } from "./scenes.js";
import { sessionStage } from "./story-app.js";
import { agent, session, speech } from "./world.js";
import { TranscriptStage } from "../../../harness-transcript/src/stage.js";

const meta = {
  title: "Graphic Precision/Working transcript",
  component: TranscriptStage,
} satisfies Meta<typeof TranscriptStage>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Literal paths stay exact; the failed call's explanation is available on focus. */
export const PathsAndFailure: Story = {
  args: { stage: sessionStage(looks) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const path = await page.findByRole("button", { name: "README.md" });
    await userEvent.click(path);
    await page.findByRole("complementary", { name: "File" });
    const why = canvasElement.querySelector<HTMLButtonElement>(".fail-info > button");
    if (why == null) throw new Error("Missing failure explanation trigger");
    await userEvent.click(why);
    const tip = why.parentElement?.querySelector<HTMLElement>(".fail-info-bubble");
    // The shared mount gate stubs native popover methods. Lifecycle is tested
    // with a stateful platform shim in the specialized interaction suite.
    await expect(tip?.textContent).toContain("grep:");
    await expect(why.getAttribute("aria-describedby")).toBe(tip?.id);
    await userEvent.keyboard("{Escape}");
    await expect(document.activeElement).toBe(why);
  },
};

/** Read-only agent context retains natural-case names, modal ownership and close. */
export const AgentContext: Story = {
  args: { stage: sessionStage(agents, { workers: agentWorkers, peeks: agentWorkerTapes }) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const note = await page.findByRole("button", { name: /^implementer/ });
    await userEvent.click(note);
    const dialog = await within(document.body).findByRole("dialog", { name: /implementer/ });
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  },
};

const longBrief = `Inspect the implementation and report concrete findings.\n${"Retain every technical detail in the delegated instructions.\n".repeat(
  80,
)}`;
export const CancelledAgentWithLongBrief: Story = {
  args: {
    stage: () => {
      const worker = session({
        id: "long-brief-worker",
        turns: [
          { prompt: longBrief, work: [speech("I inspected the cancellation path and found the stored outcome.")] },
          {
            prompt: "Please check the status label too.",
            work: [speech("The cancellation receipt is authoritative.")],
          },
        ],
      });
      const call = agent("Reviewer", longBrief, { worker: worker.root.sessionId });
      call.outcome = new FailureOutcome({
        code: "cancelled",
        message: "The parent finished before this agent replied.",
      });
      const parent = session({
        id: "long-brief-parent",
        turns: [{ prompt: "Review the current work.", work: [call] }],
      });
      return sessionStage(() => parent, { peeks: () => [worker] })();
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: /^Reviewer/ }));
    const dialog = await within(document.body).findByRole("dialog", { name: /Reviewer/ });
    await expect(dialog).toHaveAttribute("data-state", "cancelled");
    await expect(within(dialog).getByText("Cancelled: The parent finished before this agent replied.")).toBeVisible();
    await expect(
      await within(dialog).findByText("I inspected the cancellation path and found the stored outcome."),
    ).toBeVisible();
    const brief = within(dialog).getByRole("button", { name: "Delegated brief" });
    await expect(brief).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(brief);
    await expect(within(dialog).getByRole("region", { name: "Delegated brief" })).toHaveAttribute(
      "data-copy",
      longBrief,
    );
    await expect(within(dialog).getByText("Please check the status label too.")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  },
};
