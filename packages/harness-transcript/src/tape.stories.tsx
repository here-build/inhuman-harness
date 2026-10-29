import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { TranscriptStage } from "./stage.js";
import {
  agents,
  agentWorkers,
  agentWorkerTapes,
  conversation,
  diffs,
  fresh,
  looks,
  programRun,
  programWorkers,
  progress,
  reasoning,
  running,
  schemeBatch,
  terminals,
  tools,
} from "../../harness-web-app/src/__stories__/scenes.js";
import { sessionStage } from "../../harness-web-app/src/__stories__/story-app.js";

const meta = {
  title: "Tape",
  component: TranscriptStage,
} satisfies Meta<typeof TranscriptStage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A finished turn with every lane in use: title and tasks left, reasoning right, a model switch under them. */
export const Conversation: Story = { args: { stage: sessionStage(conversation) } };

/** The read family as ambient sentences: reading, searching, finding; a failure, a binary, two still running. */
export const Looks: Story = { args: { stage: sessionStage(looks) } };

/** Tool rows: a run shares one list, a failure says so, a live call spins. */
export const Tools: Story = { args: { stage: sessionStage(tools) } };

/** An edit in context, a new file, an overwrite, and a write that failed. */
export const Diffs: Story = { args: { stage: sessionStage(diffs) } };

/** Terminals: colored output, a failing run with badges, a heredoc script, one still printing. */
export const Terminals: Story = { args: { stage: sessionStage(terminals) } };

/** A scheme batch holds its own calls. */
export const SchemeBatch: Story = { args: { stage: sessionStage(schemeBatch) } };

/** The left lane across rounds: titles, a task list with a drop and a validate, a goal, a model change. */
export const Progress: Story = { args: { stage: sessionStage(progress) } };

/** Rounds that thought before acting; one says nothing at all. */
export const Reasoning: Story = { args: { stage: sessionStage(reasoning) } };

/** The executor is still inside the turn: speech mid-sentence, and a tool mid-call. */
export const Running: Story = { args: { stage: sessionStage(running) } };

/** A session with nothing said yet. The page names where the work happens. */
export const Fresh: Story = { args: { stage: sessionStage(fresh) } };

/** One column on a phone: notes inline, reasoning folded ahead of its round. */
export const Narrow: Story = {
  args: { stage: sessionStage(conversation) },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

/** Spawned agents beside the tape: one status each, from spawn until the round that took the result in. Two are still out; one asks. */
export const Agents: Story = {
  args: { stage: sessionStage(agents, { workers: agentWorkers, peeks: agentWorkerTapes }) },
};

/** A note opens its agent's own session in a dialog: the same transcript, live, read-only. */
export const AgentPeek: Story = {
  args: { stage: sessionStage(agents, { workers: agentWorkers, peeks: agentWorkerTapes }) },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(await page.findByRole("button", { name: /^implementer/ }));
    await page.findByRole("dialog", { name: /implementer/ });
  },
};

/** On a phone a round's agents follow it inline. */
export const AgentsNarrow: Story = {
  args: { stage: sessionStage(agents, { workers: agentWorkers, peeks: agentWorkerTapes }) },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};

/** A program's row opens its dataflow: Graph is inside the disclosure, and the dialog's cards are the session's own jobs. The reviewer is held at an approval. */
export const ProgramGraph: Story = {
  args: {
    stage: () => {
      const { open, workflows } = programRun();
      return sessionStage(() => open, { workers: programWorkers, workflows })();
    },
  },
  play: async ({ canvasElement }) => {
    const summary = await within(canvasElement).findByTitle("scheme_repl");
    const row = summary.closest("details")!;
    await userEvent.click(summary);
    await userEvent.click(await within(row).findByRole("button", { name: "Graph" }));
    const dialog = await within(document.body).findByRole("dialog", { name: /workflow/ });
    await waitFor(
      () => expect(within(dialog).getByLabelText(/awaiting approval/)).toHaveAttribute("data-state", "asking"),
      {
        timeout: 4000,
      },
    );
  },
};
