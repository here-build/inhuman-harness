import type { ReactNode } from "react";
import { Outcome } from "@inhuman.tools/harness-transcript";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconArrowRight, IconCornerDownLeft, IconPlayerStopFilled } from "@tabler/icons-react";

import { Label, Mono, Page, Rules, Schemes, Section, StoryLink } from "./brand-kit.js";
import { Button } from "../components/ui/button.js";
import { fieldGlyph, glyph } from "../components/ui/glyph.js";
import { Input, Textarea } from "../components/ui/input.js";

const meta = {
  title: "Brandbook/Patterns",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** One vocabulary of state, spoken by every surface that shows one. */
export const StatusLanguage: Story = {
  name: "Status language",
  render: () => (
    <Page
      title="Status language"
      lede={
        <p>
          The same four states appear in the rail, the tape’s lanes, the workflow graph, and the connection line. Each
          surface draws them in its own shape, but the hue and the word always agree.
        </p>
      }
    >
      <Section title="The vocabulary">
        <div className="grid gap-3 md:grid-cols-4">
          <StateCard hue="working" name="Working" body="An agent or call is running. Nothing is needed from you." />
          <StateCard
            hue="warning"
            name="Waiting on you"
            body="An approval or question is held. The one state that asks."
          />
          <StateCard hue="edge" name="Settled" body="Done or cancelled. Gray: a finished thing does not compete." />
          <StateCard hue="danger" name="Failed" body="Always with a word and a reason one hover away." />
        </div>
      </Section>
      <Section
        title="In the rail"
        note="A row is lit from the kernel's glance. Idle is unlit; running fills; waiting rings."
      >
        <Schemes className="bg-wash">
          <ul className="flex flex-col gap-1">
            <RailRow light="running">Ship the bar</RailRow>
            <RailRow light="waiting-for-you">Review the migration</RailRow>
            <RailRow light="idle" selected>
              Fix the rail
            </RailRow>
            <RailRow light="idle">Диагностика медленного старта ядра</RailRow>
          </ul>
        </Schemes>
      </Section>
      <Section
        title="In the lanes"
        note="An agent's note wears its state as a 2px bar on the left; the same bar runs down its peek dialog and its workflow card."
      >
        <Schemes>
          <div className="flex max-w-[22rem] flex-col gap-4">
            {(
              [
                ["working", "explore", "Map the tape reducer"],
                ["asking", "reviewer", "Needs approval to run pnpm test"],
                ["ok", "design-reviewer", "Reviewed the composer"],
                ["failed", "sweep", "Timed out after 180s"],
              ] as const
            ).map(([state, name, task]) => (
              <button key={state} type="button" className="agent-note" data-state={state}>
                <span className="agent-who">
                  <span className="agent-name">{name}</span>
                  <span className="mono text-muted">gpt-6.1-sol</span>
                </span>
                <span className="agent-task">{task}</span>
              </button>
            ))}
          </div>
        </Schemes>
      </Section>
      <Section
        title="On calls"
        note="A running call spins (linear, the only constant motion); a failed one says failed in a label. A finished call shows nothing: success is the default."
      >
        <div className="flex flex-col gap-0 rounded-sm border border-line text-sm">
          <ToolRow outcome="live">
            Searching for <Mono>CONTEXT_NEED</Mono> in <Mono>packages/harness-model</Mono>
          </ToolRow>
          <ToolRow outcome="failed">
            <Mono>$ pnpm test</Mono>
          </ToolRow>
          <ToolRow outcome="ok">
            Edit <Mono>src/shell/tape.tsx</Mono>
          </ToolRow>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-muted">
          <span className="wf-tabs">
            {(["working", "asking", "failed"] as const).map((state, index) => (
              <span key={state} className="wf-tab" aria-selected={index === 0}>
                <span className="wf-dot" data-state={state} /> pass {index + 1}
              </span>
            ))}
            <span className="wf-tab">pass 4</span>
          </span>
          <span>Workflow tabs: a pass with a live, asking, or failed call wears the dot.</span>
        </div>
      </Section>
      <Section
        title="On the line to the daemon"
        note="One sentence and at most one action, no box. A wait the system resolves breathes; a state that needs you rings."
      >
        <Schemes>
          <div className="flex flex-col gap-2">
            <p className="link-notice" data-waiting="" role="status">
              <span className="link-glyph" data-waiting="" aria-hidden />
              <span className="link-text">Reconnecting to the daemon…</span>
            </p>
            <p className="link-notice" role="status">
              <span className="link-glyph" data-needs="" aria-hidden />
              <span className="link-text">
                Can’t reach the harness daemon. Start it with <code>inhuman daemon start</code>, then retry.
              </span>
              <Button variant="secondary">Retry</Button>
            </p>
            <p className="text-sm">
              <span className="live-dot" aria-hidden />
              LM Studio <span className="mono text-muted">localhost:1234</span>
            </p>
          </div>
        </Schemes>
      </Section>
      <Section title="Usage">
        <Rules
          items={[
            {
              do: <>Give every new surface the same four states, in the same hues, before inventing a fifth.</>,
              dont: <>Introduce a purple “thinking” or a teal “queued”. Name the state you mean first.</>,
            },
            {
              do: <>Keep waiting-on-you rare and loud: a ring, an amber bar, ink-colored text.</>,
              dont: <>Ring for something the system will finish on its own.</>,
            },
            {
              do: <>Show success by absence: a call that worked just ends.</>,
              dont: <>Add a green check to every finished row.</>,
            },
            {
              do: <>Name the state of the work: running, done, failed, awaiting approval.</>,
              dont: <>Give the model a mood: thinking hard, confused, happy to help, excited.</>,
            },
          ]}
        />
      </Section>
    </Page>
  ),
};

function StateCard({ hue, name, body }: { readonly hue: string; readonly name: string; readonly body: string }) {
  return (
    <div
      className="rounded-sm border border-line bg-wash py-3 pr-4 pl-5"
      style={{ boxShadow: `inset 2px 0 0 var(--${hue})` }}
    >
      <h3 className="text-base">{name}</h3>
      <p className="mt-1 text-sm text-muted">{body}</p>
    </div>
  );
}

const rowClass =
  "touch-target flex min-h-8 w-full items-center gap-2 rounded-sm px-3 py-1 text-left text-sm hover:bg-hover aria-[current=page]:bg-selected aria-[current=page]:font-strong";

function RailRow({
  light,
  selected = false,
  children,
}: {
  readonly light: "running" | "waiting-for-you" | "idle";
  readonly selected?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <li>
      <a
        className={`${rowClass} pl-8`}
        href="#"
        aria-current={selected ? "page" : undefined}
        onClick={(event) => event.preventDefault()}
      >
        {light === "idle" ? (
          <span aria-hidden className="size-2 shrink-0" />
        ) : (
          <span
            role="img"
            aria-label={light === "waiting-for-you" ? "waiting for you" : light}
            className={`inline-block size-2 shrink-0 rounded-xs ${light === "running" ? "bg-success" : "border-2 border-warning"}`}
          />
        )}
        <span className="truncate">{children}</span>
      </a>
    </li>
  );
}

function ToolRow({ outcome, children }: { readonly outcome: "live" | "ok" | "failed"; readonly children: ReactNode }) {
  return (
    <details className="tape-tool rounded-none border-0 border-b border-line last:border-b-0">
      <summary>
        <span className="tool-summary">{children}</span>
        <Outcome outcome={outcome} />
      </summary>
      <pre className="tool-body">
        <code>…</code>
      </pre>
    </details>
  );
}

/** The kit, drawn from the components and classes the app uses. */
export const Components: Story = {
  render: () => (
    <Page
      title="Components"
      lede={
        <p>
          A small kit: three button variants, a field, and a handful of app-specific surfaces built from the same
          tokens. Each specimen here is the real class or component.
        </p>
      }
    >
      <Section
        title="Buttons"
        note={
          <>
            Primary is ink on canvas, one per decision. Secondary is bounded by the edge and sits beside a primary
            (Deny, Cancel, Retry). Ghost is for quiet actions in a row. Icons are Tabler at one stroke:{" "}
            <Mono>glyph</Mono> (16) beside text, <Mono>fieldGlyph</Mono> (20) alone in a field action.
          </>
        }
      >
        <Schemes>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Allow</Button>
            <Button variant="secondary">Deny</Button>
            <Button variant="ghost">Browse</Button>
            <Button disabled>Disabled</Button>
            <span className="composer-pill relative inline-flex size-12 items-center justify-center">
              <IconCornerDownLeft {...fieldGlyph} aria-label="Send" />
            </span>
            <span className="composer-pill relative inline-flex size-12 items-center justify-center">
              <IconPlayerStopFilled {...glyph} aria-label="Stop" />
            </span>
          </div>
        </Schemes>
        <Rules
          items={[
            {
              do: <>Label a button with its verb: Allow, Deny, Retry, Open it there.</>,
              dont: <>OK, Submit, Yes. A reader should know the effect without the sentence above.</>,
            },
            {
              do: <>Put the primary last, on the right: Deny, then Allow.</>,
              dont: <>Two primaries side by side, or a destructive primary in red.</>,
            },
          ]}
        />
      </Section>
      <Section
        title="Fields"
        note="Anything you type into has an edge and a field fill. The composer is the strongest outline on the page and turns ink on focus."
      >
        <Schemes>
          <div className="flex max-w-xl flex-col gap-4">
            <Input placeholder="Search" aria-label="Search" />
            <Textarea placeholder="Optional comment" aria-label="Comment" rows={2} />
            <div className="composer-pill relative overflow-hidden">
              <Textarea
                aria-label="Message draft"
                className="composer-draft rounded-none border-0 bg-transparent px-4 py-3.5 pr-14 text-base"
                placeholder="Ask or describe a change"
                rows={1}
              />
            </div>
            <div className="composer-pill relative overflow-hidden">
              <Textarea
                aria-label="Disabled draft"
                className="composer-draft rounded-none border-0 bg-transparent px-4 py-3.5 text-base"
                placeholder="Open or start a session to write"
                rows={1}
                disabled
              />
            </div>
          </div>
        </Schemes>
      </Section>
      <Section
        title="Containers"
        note="A fill contains; an edge bounds something you can act on. The person’s words sit in a container; the model’s output is the page itself, with no bubble or avatar staging it as someone across the table. Its identity is the model id in the left lane."
      >
        <Schemes>
          <div className="flex flex-col gap-4">
            <div className="tape-user">
              <p className="user-text">A sent message is a fill with no edge.</p>
            </div>
            <div className="tape-assistant prose text-sm">
              <p>The model’s answer is set straight on the canvas, as prose.</p>
            </div>
            <div className="prose text-sm">
              <p>
                A code span in prose is a chip: <code>field-sizing: content</code>. A path in a sentence is not.
              </p>
            </div>
            <p className="read-line">
              Reading{" "}
              <button type="button" className="read-path">
                src/shell/tape.tsx
              </button>{" "}
              and{" "}
              <button type="button" className="read-path">
                styles.css
              </button>
            </p>
            <p className="text-xs text-muted">The dashed underline means “opens beside the tape”.</p>
          </div>
        </Schemes>
      </Section>
      <Section
        title="Menus"
        note="Raised, a line for an edge, the overlay shadow, and rows nested 4px inside a 12px container."
      >
        <Schemes>
          <div className="model-menu static flex flex-col">
            <div className="model-list">
              <div className="model-option model-wire" data-active="">
                <span>Grok</span>
                <span className="model-wire-value">grok-4.7</span>
                <span className="model-wire-chevron">›</span>
                <span className="model-wire-account">
                  <span>merkle_bonsai</span>
                  <span className="model-wire-funds">84% weekly left</span>
                </span>
              </div>
              <div className="model-option model-wire">
                <span>ChatGPT</span>
                <span className="model-wire-value" />
                <span className="model-wire-chevron">›</span>
                <span className="model-wire-account">
                  <span>Vsevolod</span>
                  <span className="model-wire-funds" data-low="">
                    10% 5h left
                  </span>
                </span>
              </div>
              <div className="model-group">
                <div className="model-option">
                  Add a provider <span className="text-muted">+</span>
                </div>
              </div>
            </div>
            <input className="model-search" placeholder="Search models" aria-label="Search models" />
          </div>
        </Schemes>
      </Section>
      <Section
        title="Tiles"
        note="First run only. Size says how likely the choice is the answer: plans you pay for are large, the long tail is small and searchable."
      >
        <Schemes>
          <div className="flex flex-col gap-3">
            <ul className="tiles" data-size="large">
              <li className="tile-item">
                <button type="button" className="tile" data-size="large">
                  <span className="tile-name">ChatGPT</span>
                  <span className="tile-copy">Uses your ChatGPT plan</span>
                  <span className="tile-cue">
                    Sign in through the browser <IconArrowRight size={16} stroke={1.75} aria-hidden />
                  </span>
                </button>
              </li>
            </ul>
            <ul className="tiles" data-size="medium">
              <li className="tile-item">
                <button type="button" className="tile" data-size="medium">
                  <span className="tile-name">
                    <span className="live-dot" aria-hidden />
                    Ollama
                  </span>
                  <span className="tile-copy mono">localhost:11434</span>
                </button>
              </li>
            </ul>
            <ul className="tiles" data-size="small">
              {["Anthropic", "Mistral", "Groq"].map((name) => (
                <li key={name} className="tile-item">
                  <button type="button" className="tile" data-size="small">
                    <span className="tile-name">{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Schemes>
      </Section>
      <Section
        title="Approval cover"
        note="Not a dialog: it takes the composer's seat, keeps the draft mounted under it, and unlocks only after a short pause so a key meant for the draft cannot answer it."
      >
        <Schemes>
          <section className="rounded-md border border-edge bg-raised p-3" aria-label="Approval request">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-strong">Approval required</p>
                <p className="mono mt-1 text-sm text-muted">$ rm -rf dist</p>
              </div>
              <span className="shrink-0 rounded-xs border border-line px-2 py-1 text-xs text-muted">
                Awaiting decision
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted">Choose Allow or Deny explicitly. Your draft is saved below.</p>
              <div className="flex gap-2">
                <Button variant="secondary">Deny</Button>
                <Button>Allow</Button>
              </div>
            </div>
          </section>
        </Schemes>
        <p className="text-sm text-muted">
          Live: <StoryLink id="composer--approval-diff">Composer › Approval Diff</StoryLink>,{" "}
          <StoryLink id="composer--approval-while-drafting">Approval While Drafting</StoryLink>.
        </p>
      </Section>
    </Page>
  ),
};

/** How the product talks, read off the sentences it already says. */
export const Voice: Story = {
  render: () => (
    <Page
      title="Voice and copy"
      lede={
        <p>
          Plain, specific, calm. The interface says what happened, what it kept, and what you can do, in that order, in
          one sentence where it can. There are three voices on the board, and they are never mixed: the person’s, the
          model’s, and the interface’s own.
        </p>
      }
    >
      <Section
        title="Who is speaking"
        note="The interface narrates. It never speaks as the model, and never puts words in its mouth."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Tenet title="the person">
            Shown as written, in a container. Never edited, summarized, or retitled without saying so.
          </Tenet>
          <Tenet title="the model">
            Quoted as written and attributed by model id. Titles and progress notes are its own words when it wrote
            them.
          </Tenet>
          <Tenet title="the interface">
            Describes what was done, never what was thought: <q>Reading tape.tsx</q>, not{" "}
            <q>Let me look at your files</q>. No “I”, no “we”, no feelings.
          </Tenet>
        </div>
        <Rules
          items={[
            {
              do: <>Reading tape.tsx and styles.css</>,
              dont: <>I’m taking a look at your files!</>,
            },
            {
              do: <>reviewer · awaiting approval</>,
              dont: <>Your reviewer teammate needs your help</>,
            },
            {
              do: <>grok-4.7 · Grok</>,
              dont: <>Ask Grok, your AI assistant</>,
            },
          ]}
        />
      </Section>
      <Section
        title="Human words are readings"
        note="Agent, reasoning, workflow, round, step: familiar names chosen so a person recognises the shape at a glance. A named agent spec is called an agent because that is the common word; the reasoning lane is called Reasoning for the same reason. The name is for the reader, not a role the model was handed."
      >
        <Rules
          items={[
            {
              do: (
                <>
                  Name the shape by what produced it: an agent is a session the program spawned; a pass is one iteration
                  of its map.
                </>
              ),
              dont: (
                <>
                  Describe the model as following a workflow, playing a role, or completing step 3 of 5 when it was
                  never given one.
                </>
              ),
            },
            {
              do: <>Let the model’s own words title its work when it gave a title.</>,
              dont: <>Invent a narrative for a turn: “Planning…”, “Researching…”, “Almost there…”.</>,
            },
          ]}
        />
      </Section>
      <Section title="Principles">
        <div className="grid gap-4 md:grid-cols-2">
          <Tenet title="Say what was kept">
            When something fails, say first what is safe. <q>Message was not accepted. Your draft is saved.</q>
          </Tenet>
          <Tenet title="One sentence, one action">
            A notice is a sentence and at most one button. <q>This session belongs to kley.</q> [Open it there]
          </Tenet>
          <Tenet title="Name the thing, not the system">
            Paths, commands, and model ids appear verbatim, in mono. <q>Reading tape.tsx and styles.css</q>, not{" "}
            <q>Tool call: read_file (2)</q>.
          </Tenet>
          <Tenet title="Present tense for work in progress">
            Running work is a participle with an ellipsis: <q>Opening the session…</q>,{" "}
            <q>Reconnecting to the daemon…</q>, <q>Searching for</q>.
          </Tenet>
          <Tenet title="Escalate gently">
            A wait gains words only as it lengthens: <q>Reconnecting…</q> then, after 8s, <q>It hasn’t answered yet.</q>
          </Tenet>
          <Tenet title="Address the person sparingly">
            <q>Your workspace</q>, <q>Your draft is saved</q>, <q>Uses your ChatGPT plan</q>. Humane is not cute: never
            “Oops”, never a pep talk.
          </Tenet>
        </div>
      </Section>
      <Section title="Mechanics">
        <ul className="grid max-w-[68ch] gap-2 text-sm text-muted">
          <li>
            Sentence case everywhere: headings, buttons, menu items. Labels are lowercase and rendered in petite caps.
          </li>
          <li>Typographic punctuation: the ellipsis character (…), curly apostrophes (isn’t), en dash for ranges.</li>
          <li>Numbers as digits; units spelled the way the provider spells them (“84% weekly left”).</li>
          <li>
            No exclamation marks, no emoji in chrome. The user’s and the model’s text is theirs and is shown as written.
          </li>
          <li>
            Status regions use <Mono>role="status"</Mono>; the visible sentence is the announcement.
          </li>
        </ul>
      </Section>
      <Section title="Pairs">
        <Rules
          items={[
            {
              do: <>Could not send. Your draft is saved.</>,
              dont: <>Error: request failed (500).</>,
            },
            {
              do: <>Start Ollama or LM Studio and it shows up here.</>,
              dont: <>No local providers detected.</>,
            },
            {
              do: <>No projects yet. Open a project with the CLI to see it here.</>,
              dont: <>Empty.</>,
            },
            {
              do: <>A new request appeared. Decisions unlock after a short pause.</>,
              dont: <>Please wait…</>,
            },
          ]}
        />
        <p className="text-sm text-muted">
          The last pair is a live inconsistency: the approval chip says <q>Please wait…</q> while the line under it
          already explains why. Let the chip say <q>Unlocking…</q> or drop it during the pause.
        </p>
      </Section>
    </Page>
  ),
};

function Tenet({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="rounded-md bg-wash p-5">
      <Label>{title}</Label>
      <p className="mt-2 text-sm">{children}</p>
    </div>
  );
}
