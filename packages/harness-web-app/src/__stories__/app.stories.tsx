import type { Meta, StoryObj } from "@storybook/react-vite";

import { conversation, quiet } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { kernel, OTHER_PROJECT, project, PROJECT, StoryDial, worldOf } from "./world.js";
import { projectHref } from "../shell/path.js";

const meta = {
  title: "App",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No kernel yet: the frame waits for the local daemon. */
export const Connecting: Story = {
  args: { stage: () => ({ dial: new StoryDial({ kernel: null, attaching: true }), at: "/" }) },
};

/** The kernel is up, no route chosen: the workspace greeting over a disabled composer. */
export const Workspace: Story = {
  args: {
    stage: () => ({
      dial: worldOf([quiet("q1", "fix the rail"), quiet("q2", "audit the picker")], {
        kernel: { projects: [OTHER_PROJECT] },
      }),
      at: "/",
    }),
  },
};

/** A kernel that knows no project. */
export const NoProjects: Story = {
  args: {
    stage: () => ({ dial: new StoryDial({ kernel: kernel({ projects: [] }), projects: [] }), at: "/" }),
  },
};

/** A project with nothing in it yet. */
export const EmptyProject: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({ kernel: kernel({ projects: [PROJECT] }), projects: [project(PROJECT, [])] }),
      at: projectHref(PROJECT),
    }),
  },
};

/** A project's index: pick a session or start one. */
export const ProjectIndex: Story = {
  args: {
    stage: () => ({
      dial: worldOf([quiet("q1", "fix the rail"), quiet("q2", "audit the picker")]),
      at: projectHref(PROJECT),
    }),
  },
};

/** A conversation on a phone: the sidebar collapses behind Browse. */
export const Phone: Story = {
  args: { stage: sessionStage(conversation) },
  globals: { viewport: { value: "mobile2", isRotated: false } },
};
