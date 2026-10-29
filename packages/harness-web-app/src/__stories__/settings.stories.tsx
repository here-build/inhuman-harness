import { prompt } from "@inhuman.tools/harness-commons";
import { BotSpec, InstalledPlugin } from "@inhuman.tools/harness-model";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { StoryApp, type Staged } from "./story-app.js";
import { kernel, PROJECT, project, StoryDial, WIRES, type WireSpec } from "./world.js";

const meta = {
  title: "Settings",
  component: StoryApp,
} satisfies Meta<typeof StoryApp>;

export default meta;
type Story = StoryObj<typeof meta>;

const SENTRY: WireSpec = {
  id: "sentry",
  name: "Sentry",
  driver: "mcp-http",
  can: ["mcp"],
  models: [],
};

function stage(): Staged {
  const made = kernel({ projects: [PROJECT], wires: [...WIRES, SENTRY] });
  const sentry = made.root.connections.sentry;
  sentry.configuration = { url: "https://mcp.sentry.dev/mcp", alwaysAllow: ["list_issues"] };
  sentry.stampProcess({
    readyState: "ready",
    error: "",
    live: { tools: [{ name: "list_issues" }, { name: "search_issues" }] },
  });
  made.root.plugins.tasks = new InstalledPlugin({
    pluginName: "tasks",
    sourceNpm: "@inhuman.tools/plugin-tasks",
    sourceVersion: "0.4.2",
    enabled: true,
  });
  const goal = new InstalledPlugin({
    pluginName: "goal",
    sourceNpm: "@inhuman.tools/plugin-goal",
    sourceVersion: "0.2.0",
    enabled: false,
  });
  Object.assign(goal, { foreground: false });
  goal.problem = "Could not load ./plugin.scm";
  made.root.plugins.goal = goal;
  made.root.bots.scribe = new BotSpec({
    name: "scribe",
    description: "Writes the notes",
    instructions: prompt.system`Be brief.`,
    tools: ["read_file"],
    recipeScope: "session",
  });
  const directory = project(PROJECT, []);
  directory.root.bots.keeper = new BotSpec({
    name: "keeper",
    description: "Keeps the project notes",
    recipeScope: "project",
  });
  return {
    dial: new StoryDial({ kernel: made, projects: [directory] }),
    at: `/p/${encodeURIComponent(PROJECT)}`,
  };
}

async function open(canvasElement: HTMLElement, section: string) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Settings" }));
  const dialog = within(canvas.getByRole("dialog"));
  if (section !== "Connections") await userEvent.click(dialog.getByRole("button", { name: section }));
  await expect(canvas.getByRole("dialog", { name: section })).toBeVisible();
  return within(canvas.getByRole("dialog", { name: section }));
}

/** Models only. Each row is a switch; MCP servers live on their own page. */
export const Connections: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "Connections");
    await expect(dialog.getByText("ChatGPT")).toBeVisible();
    await expect(dialog.queryByText("Sentry")).toBeNull();
    await expect(dialog.queryByText("Always allowed")).toBeNull();
    await expect(dialog.getByText("Off keeps a model out of new sessions.")).toBeVisible();
    const chat = dialog.getByRole("switch", { name: /ChatGPT/ });
    await expect(chat).toBeChecked();
    await userEvent.click(chat);
    await expect(chat).not.toBeChecked();
  },
};

/** MCP servers. Search adds another copy; each copy shows its own login. */
export const Mcp: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "MCP");
    await expect(dialog.getByRole("switch", { name: "Sentry, Signed in" })).toBeVisible();
    await expect(dialog.queryByText("ChatGPT")).toBeNull();
    await expect(dialog.queryByText("list_issues")).toBeNull();
    await expect(dialog.getByText("Off keeps a server out of new sessions.")).toBeVisible();
    const search = dialog.getByRole("textbox", { name: "Search servers" });
    await userEvent.type(search, "sentry");
    await expect(await dialog.findByRole("button", { name: "Add another Sentry" })).toBeVisible();
    await expect(dialog.getByText("Sentry · Signed in")).toBeVisible();
    await userEvent.clear(search);
    await expect(dialog.queryByRole("button", { name: "Add another Sentry" })).toBeNull();
    const sentry = dialog.getByRole("switch", { name: "Sentry, Signed in" });
    sentry.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(dialog.getByRole("button", { name: "Log out of Sentry" })).toBeVisible();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(dialog.queryByRole("button", { name: "Log out of Sentry" })).toBeNull();
    await userEvent.click(dialog.getByRole("button", { name: "Delete Sentry" }));
    await expect(dialog.queryByText("Sentry")).toBeNull();
    await expect(dialog.getByText("No MCP server is connected.")).toBeVisible();
    await userEvent.type(search, "sentry");
    await userEvent.click(await dialog.findByRole("button", { name: "Add Sentry" }));
    await expect(await dialog.findByRole("switch", { name: "Sentry, Signed out" })).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Add another Sentry" }));
    await waitFor(() => {
      const copies = dialog.getAllByRole("switch", { name: "Sentry, Signed out" });
      if (copies.length !== 2) throw new Error(`expected 2 signed-out copies, saw ${copies.length}`);
    });
  },
};

/** Installed packs: one enabled, one that failed to load. */
export const Plugins: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "Plugins");
    await expect(dialog.getByText("tasks")).toBeVisible();
    await expect(dialog.getByText("Could not load ./plugin.scm")).toBeVisible();
  },
};

/** Project and home skills. The list is what `skill/list` returns. */
export const Skills: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "Skills");
    await expect(dialog.getByText("review")).toBeVisible();
    await expect(dialog.getByText("ponytail")).toBeVisible();
  },
};

/** Home recipes and this project's override. A session bot names the project's servers. */
export const Bots: Story = {
  args: { stage: botsStage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "Bots");
    await expect(dialog.getByText("scribe")).toBeVisible();
    await expect(dialog.getByText("keeper")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Edit scribe" }));
    await userEvent.click(dialog.getByRole("button", { name: "Add server" }));
    await expect(dialog.getByText("MCP servers pinned to this project")).toBeVisible();
    await expect(dialog.getByRole("option", { name: "notes" })).toBeVisible();
    await expect(dialog.queryByRole("option", { name: "Sentry" })).toBeNull();
    await userEvent.selectOptions(dialog.getByLabelText("Scope"), "global");
    await expect(dialog.getByText("Global MCP servers")).toBeVisible();
    await userEvent.selectOptions(dialog.getByLabelText("Server"), "Sentry");
    await userEvent.type(dialog.getByLabelText("Server tools"), "list_issues");
    await userEvent.type(dialog.getByLabelText("Account"), "desk");
    await userEvent.click(dialog.getByRole("button", { name: "Save bot" }));
    await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await expect(dialog.getByText("Sentry")).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Edit scribe" }));
    await expect(dialog.getByLabelText("Scope")).toHaveValue("global");
    await expect(dialog.getByLabelText("Server")).toHaveValue("Sentry");
    await expect(dialog.getByLabelText("Server tools")).toHaveValue("list_issues");
    await expect(dialog.getByLabelText("Account")).toHaveValue("desk");
  },
};

function botsStage(): Staged {
  const staged = stage();
  const root = staged.dial.kernel?.root;
  if (root == null) return staged;
  const driver = root.drivers["mcp-stdio"] ?? new DriverSpec({ name: "mcp-stdio", abilityClaim: ["mcp"] });
  root.drivers["mcp-stdio"] = driver;
  const notes = new ConnectionSpec({ driver, name: "notes" });
  notes.configuration = { command: "echo", project: PROJECT, account: "desk", session: "s1" };
  notes.stampProcess({
    readyState: "ready",
    error: "",
    live: { tools: [{ name: "search" }, { name: "write" }] },
  });
  root.connections.notes = notes;
  return staged;
}

/** The rest of `config.json`. */
export const Runtime: Story = {
  args: { stage },
  play: async ({ canvasElement }) => {
    const dialog = await open(canvasElement, "Runtime");
    await expect(dialog.getByRole("textbox", { name: "Compact strategy" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Approval pause (ms)" })).toHaveValue("1000");
  },
};
