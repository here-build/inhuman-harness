import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Label, Mono, Page, StoryLink } from "./brand-kit.js";

const meta = {
  title: "Brandbook/Journeys",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type Step = {
  readonly see: ReactNode;
  readonly pattern: string;
  readonly story?: readonly [id: string, name: string];
};
type Branch = {
  readonly when: string;
  readonly outcome: ReactNode;
  readonly story?: readonly [id: string, name: string];
};
type Journey = {
  readonly name: string;
  readonly goal: string;
  readonly entry: ReactNode;
  readonly steps: readonly Step[];
  readonly branches?: readonly Branch[];
};

const JOURNEYS: readonly Journey[] = [
  {
    name: "Connect a model",
    goal: "Get from nothing connected to a workspace that can answer.",
    entry: <>Any route, while the kernel lists no completion connection. The page is the one task.</>,
    steps: [
      {
        see: <>“Connect a model”: provider tiles clustered by kind, sized by likelihood.</>,
        pattern: "Tiles",
        story: ["onboarding--splash", "Onboarding › Splash"],
      },
      {
        see: <>Local servers appear live with a green dot and their port, while the page is open.</>,
        pattern: "Live dot",
        story: ["onboarding--local-servers", "Local Servers"],
      },
      {
        see: <>A tile’s connect flow replaces the grid in a raised panel: browser link, key field, or endpoint.</>,
        pattern: "Panel in place",
        story: ["onboarding--browser", "Browser"],
      },
      {
        see: <>Waiting for the browser breathes and stays cancellable.</>,
        pattern: "Breathing wait",
        story: ["onboarding--browser-waiting", "Browser Waiting"],
      },
      {
        see: <>“Connected. Opening your workspace…” until the kernel lists it; then the frame appears.</>,
        pattern: "Landing",
        story: ["onboarding--landing", "Landing"],
      },
    ],
    branches: [
      {
        when: "Cancel or Esc",
        outcome: <>Back to the grid, focus on the tile that started it.</>,
        story: ["onboarding--cancelled", "Cancelled"],
      },
      {
        when: "Sign-in fails",
        outcome: <>The reason and Retry, in the panel.</>,
        story: ["onboarding--failed", "Failed"],
      },
      {
        when: "A step only the terminal can finish",
        outcome: <>Says so instead of faking a form.</>,
        story: ["onboarding--unknown-form", "Unknown Form"],
      },
    ],
  },
  {
    name: "Arrive and orient",
    goal: "Open the web UI and know where everything is.",
    entry: (
      <>
        <Mono>harness web</Mono> opens <Mono>127.0.0.1:8787</Mono>; the browser dials the daemon.
      </>
    ),
    steps: [
      {
        see: <>Nothing for 400ms, then three drawing bars where the greeting will land.</>,
        pattern: "Connecting skeleton",
        story: ["app--connecting", "App › Connecting"],
      },
      {
        see: (
          <>“Your workspace”: the rail lists projects as disclosures, then bots; the composer is present but inert.</>
        ),
        pattern: "Frame + rail",
        story: ["app--workspace", "App › Workspace"],
      },
      {
        see: <>Rows light from the kernel: green running, amber ring waiting on you.</>,
        pattern: "Row lights",
        story: ["sidebar--all-sessions", "Sidebar › All Sessions"],
      },
    ],
    branches: [
      {
        when: "No daemon",
        outcome: <>One sentence with the start command, and Retry.</>,
        story: ["connection--unreachable", "Connection › Unreachable"],
      },
      {
        when: "Phone width",
        outcome: <>The rail folds behind Browse.</>,
        story: ["app--phone", "App › Phone"],
      },
    ],
  },
  {
    name: "Resume a session",
    goal: "Pick up a conversation where it was left.",
    entry: <>Expand a project in the rail; click a row. Rows are real links: middle-click and copy-link work.</>,
    steps: [
      {
        see: <>The row selects at once; the previous view stays while the session attaches.</>,
        pattern: "Retained view",
      },
      {
        see: <>Past a beat, “Opening the session…” breathes above the composer.</>,
        pattern: "Breathing wait",
        story: ["connection--opening", "Connection › Opening"],
      },
      {
        see: <>The tape lands at its tail; the composer arms with “Message” and the model in its lane.</>,
        pattern: "Tape + composer",
        story: ["tape--conversation", "Tape › Conversation"],
      },
    ],
    branches: [
      {
        when: "Unknown id",
        outcome: <>“There is no session at this link.” [Open the project]</>,
        story: ["connection--missing", "Missing"],
      },
      {
        when: "Wrong project in URL",
        outcome: <>“This session belongs to …” [Open it there]</>,
        story: ["connection--elsewhere", "Elsewhere"],
      },
    ],
  },
  {
    name: "Start new work",
    goal: "Ask for a change in a project.",
    entry: <>The + beside a project opens its page. The session starts when the first message is sent.</>,
    steps: [
      {
        see: <>The project’s place and the composer sit together above center: “Ask or describe a change”.</>,
        pattern: "Fresh seat",
        story: ["tape--fresh", "Tape › Fresh"],
      },
      {
        see: (
          <>
            Enter sends; the draft clears only after the daemon accepts. The seat falls to the bottom without a remount.
          </>
        ),
        pattern: "Composer",
        story: ["composer--drafting", "Composer › Drafting"],
      },
      {
        see: <>While the turn runs, the field’s action is Stop; Esc also stops.</>,
        pattern: "Send / Stop",
        story: ["composer--running", "Composer › Running"],
      },
    ],
    branches: [
      {
        when: "Refused",
        outcome: <>“Message was not accepted. Your draft is saved.”</>,
        story: ["composer--refused", "Composer › Refused"],
      },
    ],
  },
  {
    name: "Watch and audit a turn",
    goal: "Read what the other side did, in human terms, and check each reading against its original.",
    entry: <>Any attached session with history or a live turn.</>,
    steps: [
      {
        see: <>Three lanes: round titles and the model on the left, the work in the center, reasoning on the right.</>,
        pattern: "Timeline lanes",
        story: ["tape--progress", "Tape › Progress"],
      },
      {
        see: <>Looks read as sentences: “Reading a and b”, “Searching for X in scope”. Paths open the preview.</>,
        pattern: "Read lines",
        story: ["tape--looks", "Tape › Looks"],
      },
      {
        see: <>Tools are one bordered list of disclosures; a receipt is the real result: diff, terminal, text.</>,
        pattern: "Tool rows",
        story: ["tape--tools", "Tape › Tools"],
      },
      {
        see: (
          <>
            A session the model spawned is drawn as an agent: a note with a state bar. A click opens that session
            itself, read-only.
          </>
        ),
        pattern: "Agent notes + peek",
        story: ["tape--agent-peek", "Tape › Agent Peek"],
      },
      {
        see: (
          <>
            A program the model wrote offers Graph: the workflow is read off its actual dataflow, not a template it was
            given.
          </>
        ),
        pattern: "Workflow graph",
        story: ["tape--program-graph", "Tape › Program Graph"],
      },
    ],
    branches: [
      {
        when: "Narrow page",
        outcome: <>Lanes fold in: reasoning collapses ahead of its round.</>,
        story: ["tape--narrow", "Tape › Narrow"],
      },
    ],
  },
  {
    name: "Approve or deny",
    goal: "Decide on an action the agent cannot take alone.",
    entry: <>An ask lands on the running turn. The rail row rings amber.</>,
    steps: [
      {
        see: <>The approval cover takes the composer’s seat; any draft stays mounted underneath.</>,
        pattern: "Cover, not dialog",
        story: ["composer--approval-while-drafting", "Approval While Drafting"],
      },
      {
        see: <>“Please wait…” for the throttle, so a key meant for the draft cannot answer.</>,
        pattern: "Throttled arm",
      },
      {
        see: <>The receipt shows exactly what would run: a diff, a terminal, or the arguments.</>,
        pattern: "Receipt",
        story: ["composer--approval-diff", "Approval Diff"],
      },
      {
        see: <>An optional comment; Deny, then Allow. The draft returns.</>,
        pattern: "Primary last",
        story: ["composer--approval-shell", "Approval Shell"],
      },
    ],
  },
  {
    name: "Switch model or add a provider",
    goal: "Change what answers, mid-session.",
    entry: <>The model name in the composer’s lane.</>,
    steps: [
      {
        see: <>A menu above the trigger: search, providers with who is signed in and what is left.</>,
        pattern: "Anchored menu",
        story: ["composer--picker-open", "Composer › Picker Open"],
      },
      {
        see: <>A provider’s models open beside its row.</>,
        pattern: "Submenu",
        story: ["composer--picker-provider", "Picker Provider"],
      },
      {
        see: <>“Add a provider” runs the same connect step inside the menu.</>,
        pattern: "Connect step",
        story: ["onboarding--add-provider-step", "Onboarding › Add Provider Step"],
      },
    ],
  },
  {
    name: "Lose and regain the line",
    goal: "Survive a daemon restart without losing work.",
    entry: <>The socket drops after attach.</>,
    steps: [
      {
        see: <>“Reconnecting to the daemon…” breathes; the composer locks but keeps the draft.</>,
        pattern: "Breathing wait",
        story: ["connection--reconnecting", "Connection › Reconnecting"],
      },
      {
        see: <>After 8s: “It hasn’t answered yet.” The room redials on its own; no button to press.</>,
        pattern: "Gentle escalation",
      },
    ],
  },
];

export const JourneyMap: Story = {
  name: "Map",
  render: () => (
    <Page
      title="User journeys"
      lede={
        <p>
          Eight flows cover the product. Each is an exchange at the board: setting it up, reading what the other side
          wrote, answering when it asks. Each step names the pattern it relies on and links to the scene that shows it.
          Read with <StoryLink id="brandbook-journeys--findings">Findings</StoryLink>, which records where the live app
          departs from them.
        </p>
      }
    >
      <nav aria-label="Journeys" className="flex flex-wrap gap-2">
        {JOURNEYS.map((journey, index) => (
          <a
            key={journey.name}
            href={`#j${index}`}
            className="rounded-xs border border-line px-2 py-1 text-sm text-muted hover:bg-hover hover:text-ink"
          >
            {journey.name}
          </a>
        ))}
      </nav>
      {JOURNEYS.map((journey, index) => (
        <JourneyView key={journey.name} journey={journey} id={`j${index}`} />
      ))}
    </Page>
  ),
};

function JourneyView({ journey, id }: { readonly journey: Journey; readonly id: string }) {
  return (
    <section id={id} className="flex scroll-mt-6 flex-col gap-5">
      <div className="border-b border-line pb-3">
        <h2 className="text-lg">{journey.name}</h2>
        <p className="mt-1 text-sm text-muted">{journey.goal}</p>
      </div>
      <p className="text-sm">
        <span className="label text-muted">entry </span>
        {journey.entry}
      </p>
      <ol className="flex flex-col">
        {journey.steps.map((step, index) => (
          <li key={index} className="grid grid-cols-[2rem_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span className="mono grid size-6 place-items-center rounded-xs border border-edge text-xs">
                {index + 1}
              </span>
              {index === journey.steps.length - 1 ? null : <span className="w-px flex-1 bg-line" />}
            </div>
            <div className="grid gap-x-6 gap-y-1 pb-5 md:grid-cols-[1fr_14rem]">
              <p className="text-sm">{step.see}</p>
              <p className="text-xs text-muted">
                <span className="label">{step.pattern}</span>
                {step.story == null ? null : (
                  <>
                    <br />
                    <StoryLink id={step.story[0]}>{step.story[1]}</StoryLink>
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {journey.branches == null ? null : (
        <div className="rounded-md bg-wash p-4">
          <Label>branches</Label>
          <ul className="mt-2 flex flex-col gap-2">
            {journey.branches.map((branch) => (
              <li key={branch.when} className="grid gap-x-4 text-sm md:grid-cols-[12rem_1fr_14rem]">
                <span className="font-[620]">{branch.when}</span>
                <span className="text-muted">{branch.outcome}</span>
                <span className="text-xs">
                  {branch.story == null ? null : <StoryLink id={branch.story[0]}>{branch.story[1]}</StoryLink>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

type Finding = {
  readonly title: string;
  readonly weight: "friction" | "drift" | "polish";
  readonly seen: ReactNode;
  readonly why: ReactNode;
  readonly next: ReactNode;
};

const FINDINGS: readonly Finding[] = [
  {
    title: "The project index has no way in",
    weight: "friction",
    seen: (
      <>
        Clicking a project in the rail only toggles its disclosure; the URL stays at <Mono>/</Mono>.{" "}
        <Mono>/p/$path</Mono> renders a project index, but nothing links to it.
      </>
    ),
    why: (
      <>“Start new work” and “Resume” both want a project-level place; today it is reachable only by typing the URL.</>
    ),
    next: <>Make the project name a link to its index and keep the caret as the disclosure.</>,
  },
  {
    title: "A project can sit at “Attaching…” with no escalation",
    weight: "friction",
    seen: (
      <>
        <Mono>packages/harness</Mono> stayed “Attaching…” for the whole walk, its + disabled, with no hint or retry.
      </>
    ),
    why: (
      <>
        Every other wait escalates: silent for 400ms, then it breathes, then adds a hint (4s while connecting, “It
        hasn’t answered yet.” at 8s while reconnecting). This one never does.
      </>
    ),
    next: <>Give the rail’s attach the link-notice ladder, and a Retry once it fails.</>,
  },
  {
    title: "Opening a session can take seconds behind a contradicting view",
    weight: "friction",
    seen: (
      <>
        Opening a large session took several seconds; meanwhile the retained workspace still said “Select a project or a
        bot in the sidebar to get started.”
      </>
    ),
    why: (
      <>
        Retaining the committed view is right, but its copy tells you to do what you just did. Only a small line above
        the composer says otherwise.
      </>
    ),
    next: (
      <>While a route is pending from the workspace greeting, swap the greeting for the connecting bars, or dim it.</>
    ),
  },
  {
    title: "The rail does not scale past a few dozen sessions",
    weight: "friction",
    seen: (
      <>
        <Mono>here.build/harness</Mono> lists about 77 sessions in one undifferentiated, truncated column. No time
        grouping, no filter.
      </>
    ),
    why: <>Resuming is the most common journey; lights are the only scannable signal.</>,
    next: (
      <>
        Group by recency (today, this week, older) and add a filter field at the section label. Both fit the existing
        label and row patterns.
      </>
    ),
  },
  {
    title: "Opening a file preview collapses the lanes",
    weight: "friction",
    seen: (
      <>
        The preview takes up to 36rem; the tape drops under its 68rem container breakpoint and folds into the narrow
        layout, hiding round titles and reasoning.
      </>
    ),
    why: <>A side action re-flows the whole conversation, and the reader loses their place.</>,
    next: <>Let the preview overlay the right lane on wide screens, or narrow the lanes before folding them.</>,
  },
  {
    title: "Italic is not the specified face",
    weight: "drift",
    seen: (
      <>
        No <Mono>em, i</Mono> rule exists; prose emphasis renders Source Sans 3 italic.
      </>
    ),
    why: (
      <>
        The web-app plan rejects Source Sans italic and assigns all italic runs to JetBrains Mono italic, which is
        already loaded.
      </>
    ),
    next: (
      <>
        Add <Mono>{"em, i { font-family: var(--font-mono); font-style: italic }"}</Mono> scoped to prose, or amend the
        plan.
      </>
    ),
  },
  {
    title: "The name is cased two ways",
    weight: "drift",
    seen: <>The header reads “Inhuman”; the document title reads “inhuman”.</>,
    why: <>The name is the brand's only mark, so it has to be consistent.</>,
    next: <>Pick one. The plan writes it lowercase.</>,
  },
  {
    title: "The model menu opens over the rail",
    weight: "polish",
    seen: <>From the lane at bottom-left, the picker spans left and covers the session list.</>,
    why: <>Acceptable for a transient menu, but it hides the rows you might be comparing against.</>,
    next: (
      <>
        Prefer <Mono>top span-right</Mono> on wide pages so it grows over the empty lane.
      </>
    ),
  },
  {
    title: "A narrow round title's rule overruns the column",
    weight: "polish",
    seen: <>At narrow widths the progress mark’s bottom border runs from the column to the scrollport edge.</>,
    why: <>Every other rule stops at the content edge.</>,
    next: <>Inset the border to the content edge.</>,
  },
];

const WEIGHT_HUE: Readonly<Record<Finding["weight"], string>> = {
  friction: "warning",
  drift: "working",
  polish: "edge",
};

export const Findings: Story = {
  render: () => (
    <Page
      title="Findings"
      lede={
        <p>
          Where the running app departs from its journeys or its own rules, from a walk of the live UI at{" "}
          <Mono>127.0.0.1:8787</Mono> and a read of the source. Friction blocks or slows a journey; drift is the code
          disagreeing with the spec; polish is visual.
        </p>
      }
    >
      <ol className="flex flex-col gap-4">
        {FINDINGS.map((finding) => (
          <li
            key={finding.title}
            className="rounded-md border border-line py-4 pr-5 pl-6"
            style={{
              boxShadow: `inset 2px 0 0 var(--${WEIGHT_HUE[finding.weight]})`,
            }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-base">{finding.title}</h2>
              <span className="label text-sm text-muted">{finding.weight}</span>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[6rem_1fr]">
              <dt className="label text-muted">seen</dt>
              <dd>{finding.seen}</dd>
              <dt className="label text-muted">why</dt>
              <dd className="text-muted">{finding.why}</dd>
              <dt className="label text-muted">next</dt>
              <dd>{finding.next}</dd>
            </dl>
          </li>
        ))}
      </ol>
    </Page>
  ),
};
