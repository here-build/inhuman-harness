import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { approval, conversation, elsewhere, quiet, running } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { kernel, OTHER_PROJECT, project, PROJECT, StoryDial } from "./world.js";

const meta = {
  title: "Sidebar",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

const neighbours = () => [
  quiet("n1", "Hide context_need calls in the web UI"),
  quiet("n2", "у нас небольшая ошибка в реализации UI-слоя, давай разберёмся"),
  quiet("n3", "Compact is greedy and the 5s is chokidar, not the fold"),
];

/** Overview lists what needs you across projects, each row named with its project. */
export const Overview: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({
        kernel: kernel({
          projects: [PROJECT, OTHER_PROJECT],
          sessions: {
            wait: { title: "Approve the migration", unfinished: "ask", at: Date.now() - 20 * 60_000 },
            live: {
              title: "Still writing the rail",
              unfinished: "turn",
              openTurn: true,
              at: Date.now() - 5 * 60_000,
            },
            stale: {
              title: "Выкидываю обёртки liveness",
              unfinished: "tools",
              openTurn: false,
              at: Date.now() - 26 * 24 * 60 * 60_000,
            },
            frozen: {
              title: "Full error of Redesign theme invalidation",
              unfinished: "turn",
              openTurn: true,
              at: Date.now() - 32 * 24 * 60 * 60_000,
            },
            recent: { title: "Left-bar task and goal progress", at: Date.now() - 3 * 24 * 60 * 60_000 },
          },
        }),
        projects: [project(PROJECT, ["live", "stale", "frozen", "recent"]), project(OTHER_PROJECT, ["wait"])],
      }),
      at: "/",
    }),
  },
};

/** A selected project with no session open: the pane names the project, and the strip keeps that name. */
export const ProjectHome: Story = {
  args: {
    stage: () => {
      const long = "/Users/ada/work/project-0-with-a-long-directory-name";
      const other = "/Users/ada/work/packages/harness";
      return {
        dial: new StoryDial({
          kernel: kernel({
            projects: [long, other, OTHER_PROJECT],
            sessions: {
              a: { title: "Left-bar task and goal progress" },
              b: { title: "Hide context_need calls in the web UI" },
            },
          }),
          projects: [project(long, ["a", "b"]), project(other, []), project(OTHER_PROJECT, [])],
        }),
        at: `/p/${encodeURIComponent(long)}`,
      };
    },
  },
};

/** The open session is running: its row lights green from the room itself. */
export const Running: Story = { args: { stage: sessionStage(running, { others: neighbours }) } };

/** Every row lit from its kernel glance: running, waiting on an approval, a question left for you, idle. */
export const AllSessions: Story = { args: { stage: sessionStage(conversation, { others: elsewhere }) } };

/** The open session waits on you: its row rings amber. */
export const WaitingForYou: Story = { args: { stage: sessionStage(() => approval("diff"), { others: neighbours }) } };

/** Many conversations, long and non-Latin titles truncate in the rail. */
export const ManySessions: Story = {
  args: {
    stage: sessionStage(conversation, {
      others: () => [
        ...neighbours(),
        ...Array.from({ length: 24 }, (_, index) =>
          quiet(
            `m${index}`,
            `Session ${index + 1}: tighten one more corner of the tape layout so it reads at a glance`,
          ),
        ),
      ],
    }),
  },
};

/** Bots apart from sessions: the global roster, then each project's own under its name. */
export const Bots: Story = {
  args: {
    stage: () => {
      const dial = new StoryDial({
        kernel: kernel({
          bots: { reviewer: "bot-reviewer", scribe: "bot-scribe" },
          sessions: { a: { title: "Ship the bar" } },
        }),
        projects: [project(PROJECT, ["a"], { explorer: "bot-explorer" })],
      });
      return { dial, at: `/p/${encodeURIComponent(PROJECT)}` };
    },
  },
};

const many = (count: number, text: (index: number) => string) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`m${index}`, { title: text(index) }]));

/** Many sessions beside two bots: the bots take what they hold, the sessions the rest and scroll. */
export const SplitShort: Story = {
  args: {
    stage: () => {
      const sessions = many(30, (index) => `Session ${index + 1}: one more corner of the tape layout`);
      const dial = new StoryDial({
        kernel: kernel({ bots: { reviewer: "bot-reviewer" }, sessions }),
        projects: [project(PROJECT, Object.keys(sessions), { explorer: "bot-explorer" })],
      });
      return { dial, at: `/p/${encodeURIComponent(PROJECT)}` };
    },
  },
};

/** Many of both: each section holds half the rail and scrolls inside it. */
export const SplitEven: Story = {
  args: {
    stage: () => {
      const sessions = many(30, (index) => `Session ${index + 1}: one more corner of the tape layout`);
      const bots = Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`worker-${index + 1}`, `bot-${index}`]),
      );
      const dial = new StoryDial({
        kernel: kernel({ bots, sessions }),
        projects: [project(PROJECT, Object.keys(sessions))],
      });
      return { dial, at: `/p/${encodeURIComponent(PROJECT)}` };
    },
  },
};

/** A dozen projects: the strip scrolls and the active tab stays in view. */
export const ManyProjects: Story = {
  args: {
    stage: () => {
      const paths = Array.from(
        { length: 12 },
        (_, index) => `/Users/ada/work/project-${index}-with-a-long-directory-name`,
      );
      return {
        dial: new StoryDial({
          kernel: kernel({ projects: paths }),
          projects: paths.map((path) => project(path, [])),
        }),
        at: "/",
      };
    },
  },
};

/** Waiting outranks running: a count on one tab, a success dot on the other. */
export const TabStatus: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({
        kernel: kernel({
          projects: [PROJECT, OTHER_PROJECT],
          sessions: {
            wait1: { title: "Needs you", unfinished: "ask" },
            wait2: { title: "A question", unfinished: "question" },
            run1: { title: "Still going", unfinished: "turn", openTurn: true },
          },
        }),
        projects: [project(PROJECT, ["wait1", "wait2"]), project(OTHER_PROJECT, ["run1"])],
      }),
      at: "/",
    }),
  },
};

/** Add explains that `harness` in a directory is what registers a project. */
export const AddProject: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({ kernel: kernel({ projects: [PROJECT] }), projects: [project(PROJECT, [])] }),
      at: "/",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));
    await expect(canvas.getByRole("dialog", { name: "Add a project" })).toBeVisible();
  },
};

/** A project the rail has not attached yet, beside one it has. */
export const Attaching: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({
        kernel: kernel({ projects: [PROJECT, OTHER_PROJECT], sessions: { a: { title: "Ship the bar" } } }),
        projects: [project(PROJECT, ["a"])],
      }),
      at: `/p/${encodeURIComponent(OTHER_PROJECT)}`,
    }),
  },
};
