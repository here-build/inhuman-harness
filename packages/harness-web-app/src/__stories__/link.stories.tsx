import type { Meta, StoryObj } from "@storybook/react-vite";

import { conversation, quiet } from "./scenes.js";
import { sessionStage, StoryApp } from "./story-app.js";
import { kernel, OTHER_PROJECT, project, PROJECT, StoryDial, worldOf } from "./world.js";
import { sessionHref } from "../shell/path.js";

const meta = {
  title: "Connection",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The first connect found no daemon: the notice takes the loader's place, with the command and a retry. */
export const Unreachable: Story = {
  args: { stage: () => ({ dial: new StoryDial({ kernel: null, link: { kind: "unreachable" } }), at: "/" }) },
};

/** A socket answered but the room never synced in time. */
export const Unanswered: Story = {
  args: { stage: () => ({ dial: new StoryDial({ kernel: null, link: { kind: "unanswered" } }), at: "/" }) },
};

/** Attached, then the line dropped: the composer locks while the room redials on its own. */
export const Reconnecting: Story = {
  args: { stage: sessionStage(conversation, { link: { kind: "reconnecting" } }) },
};

/** The route asked for a session the kernel does not list. */
export const Missing: Story = {
  args: {
    stage: () => ({
      dial: worldOf([quiet("q1", "fix the rail")], { link: { kind: "missing", sessionId: "gone" } }),
      at: sessionHref(PROJECT, "gone"),
    }),
  },
};

/** The session lives in another project; the notice opens it there. */
export const Elsewhere: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({
        kernel: kernel({ projects: [PROJECT, OTHER_PROJECT] }),
        projects: [project(PROJECT, []), project(OTHER_PROJECT, [])],
        link: { kind: "elsewhere", sessionId: "s-kley", path: OTHER_PROJECT },
      }),
      at: sessionHref(PROJECT, "s-kley"),
    }),
  },
};

/** Opening was cancelled before it committed. */
export const Cancelled: Story = {
  args: { stage: sessionStage(conversation, { link: { kind: "cancelled" } }) },
};

/** A route still attaching past the beat: the composer says what it is opening. */
export const Opening: Story = {
  args: {
    stage: () => ({
      dial: new StoryDial({ kernel: kernel(), projects: [project(PROJECT, [])], attaching: true }),
      at: sessionHref(PROJECT, "slow"),
    }),
  },
};
