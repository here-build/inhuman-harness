import { useEffect } from "react";
import { traceToRegions, type RegionGraph } from "@here.build/arrival-provenance";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  type Call,
  WORKFLOWS,
  WorkflowClock,
  type WorkflowName,
  type WorkflowRun,
  type WorkflowScript,
  runWorkflow,
} from "./workflow-world.js";
import type { AgentState } from "../shell/tape-read.js";
import type { WorkflowCell } from "../workflow/cell.js";
import { useRegionGraph } from "../workflow/use-region-graph.js";
import { WorkflowGraph } from "../workflow/workflow-graph.js";

const meta = { title: "Workflow/Graph" } satisfies Meta;

export default meta;
type Story = StoryObj;
type Loaded = { readonly graph: RegionGraph; readonly cells: ReadonlyMap<number, WorkflowCell> };

/** The graph gets the whole viewport, as it will have a pane. */
const Canvas = ({ children }: { readonly children: React.ReactNode }) => <div className="h-dvh">{children}</div>;

/** A corpus program run to completion, read once. `find` is a card that must be on the canvas. */
const settled = (name: WorkflowName, find: string): Story => ({
  loaders: [
    async (): Promise<Loaded> => {
      const { source, script } = WORKFLOWS[name];
      const run = runWorkflow(source, script());
      await run.done;
      return { graph: traceToRegions(run.trace), cells: run.cells };
    },
  ],
  render: (_, { loaded }) => {
    const { graph, cells } = loaded as Loaded;
    return (
      <Canvas>
        <WorkflowGraph graph={graph} cells={cells} />
      </Canvas>
    );
  },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(find, undefined, { timeout: 5000 });
  },
});

/** Three explorers in parallel under one frame and its tabs, a reviewer reading all three, an implementer acting on the verdict. */
export const Fanout = settled("fanout", "reviewer");

/** Draft, review, rewrite: a loop whose value wraps the frame back into the reviewer until it signs off. */
export const Loop = settled("loop", "writer");

/** A fixer only where the audit found something: the clause is a dashed frame, the other iteration's route a ghost. */
export const Branch = settled("branch", "fixer");

/** Every file read, the pill on the trunk says `kept 2 of 3`, and only the survivors are ported. */
export const Filter = settled("filter", "porter");

/** A scout feeds a lead, once per area, inside one frame. */
export const Nested = settled("nested", "lead");

/** Instruments, not actors: tool calls as compact cards, one failing, and the program carrying on with a value. */
export const Tools = settled("tools", "shell");

/* Live: the incremental fold over a run that may still be going. */

type LiveRun = WorkflowRun & { readonly clock: WorkflowClock };
type LivePlay = (page: ReturnType<typeof within>, run: LiveRun, canvas: HTMLElement) => Promise<void>;

/** Park calls on the clock: `keyOf` names a call's hold, given its position among calls to the same worker. */
const holding = (
  name: WorkflowName,
  keyOf: (call: Call, nth: number) => string | undefined,
  tune: (base: WorkflowScript) => WorkflowScript = (base) => base,
): LiveRun => {
  const clock = new WorkflowClock();
  const { source, script } = WORKFLOWS[name];
  const base = tune(script());
  const seen = new Map<string, number>();
  const run = runWorkflow(
    source,
    (call) => {
      const nth = (seen.get(call.name) ?? 0) + 1;
      seen.set(call.name, nth);
      const key = keyOf(call, nth);
      return key === undefined ? base(call) : { ...base(call), hold: key };
    },
    clock,
  );
  return { ...run, clock };
};

function Live({ run }: { readonly run: LiveRun }) {
  const graph = useRegionGraph(run.trace);
  // A story that leaves the clock holding would park its program past the unmount.
  useEffect(() => () => run.clock.releaseAll(), [run]);
  return <Canvas>{graph === null ? null : <WorkflowGraph graph={graph} cells={run.cells} />}</Canvas>;
}

const live = (start: () => LiveRun, play: LivePlay, extra: Story = {}): Story => ({
  ...extra,
  loaders: [async () => ({ run: start() })],
  render: (_, { loaded }) => <Live run={(loaded as { run: LiveRun }).run} />,
  play: ({ canvasElement, loaded }) => play(within(canvasElement), (loaded as { run: LiveRun }).run, canvasElement),
});

const WAIT = { timeout: 4000 };

/** A card by who it is and what state it is in. Cards carry both on the element, so no layout is needed to see them. */
const card = (page: ReturnType<typeof within>, who: string, state: AgentState) =>
  waitFor(async () => {
    const el = page.getByLabelText((label: string) => label.startsWith(`${who},`));
    await expect(el).toHaveAttribute("data-state", state);
    return el;
  }, WAIT);

/** An iteration's tab, with the dot it wears when named. */
const tab = (page: ReturnType<typeof within>, n: number, dot?: string) =>
  page.findByRole(
    "tab",
    { name: (name: string) => (dot === undefined ? name.split(" ")[0] === `#${n}` : name === `#${n} ${dot}`) },
    WAIT,
  );

/** The reviewer waits for a person: its card asks, and nothing downstream has happened. */
const asking =
  (base: WorkflowScript): WorkflowScript =>
  (call) =>
    call.name === "reviewer" ? { hold: "review", asking: "awaiting approval", value: "" } : base(call);

/** The incremental path: explorers settled grey, the reviewer asking in yellow, the rest of the program not yet written. */
export const FanoutLive: Story = live(
  () => holding("fanout", () => undefined, asking),
  async (page) => {
    await page.findByText("awaiting approval", undefined, WAIT);
    await page.findByText("reviewer");
  },
);

const STREAM = [
  { hold: "explore 1", who: "agent/call explore" },
  { hold: "explore 2", who: "agent/call explore" },
  { hold: "explore 3", who: "agent/call explore" },
  { hold: "reviewer", who: "agent/ask reviewer" },
  { hold: "implementer", who: "agent/call implementer" },
] as const;

/** Every call held, then let go one at a time: each card turns grey as the next one starts blue. */
export const Streaming: Story = live(
  () => holding("fanout", (call, nth) => (call.name === "explore" ? `explore ${nth}` : call.name)),
  async (page, { clock }) => {
    for (const [at, step] of STREAM.entries()) {
      await clock.held(step.hold);
      // The tabs are the explorers; a new pass opens behind the selected one, so follow it.
      if (step.hold.startsWith("explore") && at > 0) await userEvent.click(await tab(page, at + 1, "running"));
      await card(page, step.who, "live");
      clock.release(step.hold);
      await card(page, step.who, "ok");
    }
  },
);

/** The second scout fails: its pass is the tab with the red dot, the program stops there. */
export const FailedAgent: Story = live(
  () =>
    holding(
      "nested",
      () => undefined,
      (base) => (call) =>
        call.name === "scout" && call.input === "ui"
          ? { fail: "scout lost the repository", value: undefined }
          : base(call),
    ),
  async (page) => {
    await userEvent.click(await tab(page, 2, "failed"));
    const failed = await card(page, "agent/call scout", "failed");
    await expect(failed).toHaveTextContent("scout lost the repository");
  },
);

/** The implementer is cancelled: gray like any settled card, and nothing says it went wrong. */
export const CancelledAgent: Story = live(
  () =>
    holding(
      "fanout",
      () => undefined,
      (base) => (call) => (call.name === "implementer" ? { cancel: true, value: undefined } : base(call)),
    ),
  async (page) => {
    await card(page, "agent/call implementer", "cancelled");
    await tab(page, 1);
    await expect(page.queryByRole("img", { name: "failed" })).toBeNull();
  },
);

/** The second explorer still out: its tab wears the working dot, and the card behind it is live. */
export const LiveInIteration: Story = live(
  () => holding("fanout", (call, nth) => (call.name === "explore" && nth === 2 ? "explore 2" : undefined)),
  async (page) => {
    await userEvent.click(await tab(page, 2, "running"));
    await card(page, "agent/call explore", "live");
  },
);

/** A loop's passes are tabs: the last one is the reviewer's sign-off. */
export const LoopTabs: Story = live(
  () => holding("loop", () => undefined),
  async (page) => {
    await userEvent.click(await tab(page, 3));
    await page.findByText(/^LGTM/, undefined, WAIT);
  },
);

/** A phone: the canvas scrolls inside its pane, the page does not. */
export const Narrow: Story = live(
  () => holding("fanout", () => undefined),
  async (page) => {
    await page.findByText("reviewer", undefined, WAIT);
    await card(page, "agent/call implementer", "ok");
  },
  { globals: { viewport: { value: "mobile2", isRotated: false } } },
);
