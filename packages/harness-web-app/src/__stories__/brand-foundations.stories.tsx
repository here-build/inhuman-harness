import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Label, Mono, Page, Rules, Schemes, Section, StoryLink, Swatch } from "./brand-kit.js";
import { Button } from "../components/ui/button.js";

const meta = {
  title: "Brandbook/Foundations",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Why the product is called what it is, and what that asks of every screen. */
export const Principles: Story = {
  render: () => (
    <Page
      title="Inhuman, at a glance"
      lede={
        <>
          <p>
            The name is an acknowledgment, not a boast. The intelligence on the other side of this harness is utterly
            inhuman, and we do not pretend otherwise. The harness is not alien technology. It is Louise Banks’s
            whiteboard from “Story of Your Life” and its film, “Arrival”: a plain, shared surface built so two very
            different minds can talk. The model-facing language in this repo is already called Arrival.
          </p>
          <p className="mt-3">
            The name says the opposite of “not for humans”: it is why the human side has to be humane.
          </p>
        </>
      }
    >
      <Section
        title="Two surfaces, one bridge"
        note="Every part of the product sits on one side of the bridge or the other, and is judged by that side's constraint."
      >
        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
          <Surface name="Human surface" constraint="Humane, and compatible with the bridge">
            The web UI, the TUI, copy, color, motion. It is built for people: readable, calm, forgiving of mistakes, and
            honest about what is happening. Every word and shape here has to translate faithfully to something real on
            the other side.
          </Surface>
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-edge px-5 py-4 text-center">
            <Label>the bridge</Label>
            <p className="font-heading text-lg font-strong">the harness</p>
            <p className="max-w-[12rem] text-xs text-muted">
              Documents, jobs, approvals. One shared board that both sides read and write.
            </p>
          </div>
          <Surface name="AI surface" constraint="No human concepts imposed">
            What the model touches: the Arrival language, tools, documents, programs. It offers building blocks, not a
            script. Roles, workflows, agents, and steps are human ideas; the intelligence is free to build whatever
            structure it needs out of the blocks.
          </Surface>
        </div>
      </Section>
      <Section
        title="The whiteboard"
        note="What Louise does at the glass in Arrival, and what each of those things asks of the interface."
      >
        <ul className="grid gap-x-10 gap-y-5 md:grid-cols-2">
          <Echo
            scene="Her first word is “human”, with her hand on her chest."
            asks="Say who is who. The person’s words sit in a container; the model’s are the page, attributed by its model id."
          />
          <Echo
            scene="She writes in plain, large strokes on a white board."
            asks="Neutral chrome. The surface carries no ornament, so whatever is written on it is what you read."
          />
          <Echo
            scene="She pairs each word with its logogram."
            asks="Translation with the original one step away. A human reading on top (“Reading tape.tsx”); the actual call, diff, or program underneath."
          />
          <Echo
            scene="She takes off the hazmat suit and shows her face."
            asks="The human side is humane, not defensive: drafts kept, decisions explicit, failures explained."
          />
          <Echo
            scene="She never pretends to be a heptapod, or that they are human."
            asks="No mask for the AI: no avatar, persona, typing dots, or “I” in the chrome. The model is quoted, not impersonated."
          />
          <Echo
            scene="Both sides see the same board."
            asks="One document, many peers. The web UI, the TUI, and the daemon read the same session, so nothing is private to a view."
          />
          <Echo
            scene="It goes slowly, one exchange at a time."
            asks="Unhurried. Waits breathe, an approval pauses before it arms, and only an exchange that needs you rings."
          />
        </ul>
      </Section>
      <Section title="Character">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Trait
            name="Humane"
            body="Built for the person at the board: familiar controls, plain words, nothing lost. Looks like a well-made tool you already know."
          />
          <Trait
            name="Candid"
            body="Honest about the other side. No persona, no simulated feelings, no pretending a model is a colleague."
          />
          <Trait
            name="Legible"
            body="Translates inhuman work into human terms without claiming that is how it works. The original is always one step away."
          />
          <Trait
            name="Unhurried"
            body="Waits stay silent for a beat, then breathe. Leaving is quicker than arriving. Nothing animates to look busy."
          />
        </div>
      </Section>
      <Section title="Laws" note="These hold on every surface. The pages after this one are their detail.">
        <ol className="grid gap-x-10 gap-y-5 md:grid-cols-2">
          <Law n={1} title="Human concepts are readings">
            Agents, workflows, rounds, and steps on screen are drawn from what actually ran: spawned sessions, a
            program’s dataflow, a turn’s calls. Their names are the familiar ones (an agent, the Reasoning lane) because
            people already know them. The UI names what it saw; it never hands those shapes to the model as a script.
          </Law>
          <Law n={2} title="The original is one step away">
            Every summary opens onto its source: a look onto the file, a tool row onto its receipt, a graph onto its
            program. A translation that cannot be checked is not shipped.
          </Law>
          <Law n={3} title="No mask">
            The chrome speaks as the interface, never as the model. The model’s words are shown as written and
            attributed by its id. It gets no face, color, or name it did not take.
          </Law>
          <Law n={4} title="Color is state">
            The chrome is achromatic (hue 286, chroma 0.005). Blue is working, amber is waiting on you, green is live or
            added, red is failed or removed. No hue stands for the AI or for the person.
          </Law>
          <Law n={5} title="Shape carries it too">
            No state is hue alone: running fills a dot, waiting rings it, failed adds a word. The page must read in
            grayscale.
          </Law>
          <Law n={6} title="Proximity is grouping">
            A tool run touches, cells in a round sit 16px apart, rounds 32px. Boxes are the last resort, not the first.
          </Law>
          <Law n={7} title="Fills contain, edges control">
            A sent message is a fill with no edge. Anything you type into or press has an edge that holds 3:1. The field
            you write on is the strongest outline on the page.
          </Law>
          <Law n={8} title="One scale per quantity, AA in both schemes">
            Type, space, radius, and motion each have one scale. Every color is a <Mono>light-dark()</Mono> pair, and{" "}
            <Mono>contrast.test.ts</Mono> holds each text tier to 4.5:1 on every surface.
          </Law>
        </ol>
      </Section>
      <Section
        title="The name"
        note="“Inhuman” describes the other side of the bridge, honestly. It is not an aesthetic for this side."
      >
        <div className="flex flex-wrap items-end gap-10">
          <div>
            <p className="font-heading text-2xl font-strong">Inhuman</p>
            <p className="mt-1 text-sm text-muted">Nunito Sans 620, in the rail header, once per page.</p>
          </div>
          <div>
            <p className="font-heading text-base font-strong">Inhuman</p>
            <p className="mt-1 text-sm text-muted">At rail size (16px).</p>
          </div>
        </div>
        <Rules
          items={[
            {
              do: <>Set the name as a plain heading in a warm, human sans. It appears once in the frame.</>,
              dont: <>Make the name look alien: glyph fonts, logogram motifs, neon, glitch, or terminal green.</>,
            },
            {
              do: <>Explain the name as an acknowledgment: we know what we are talking to.</>,
              dont: <>Pitch it as “not human” versus the user, or as a machine replacing people.</>,
            },
            {
              do: <>Pick one casing and use it in the header and the tab title alike.</>,
              dont: (
                <>
                  Today the header says <q>Inhuman</q> and the document title says <q>inhuman</q>. Settle it.
                </>
              ),
            },
          ]}
        />
      </Section>
      <Section title="Rejected on purpose">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>a face for the ai</Label>
            <p className="mt-1 text-sm text-muted">
              Avatars, mascots, personas, a signature hue, “your AI teammate”, typing indicators, and chat bubbles that
              stage the model as someone across the table.
            </p>
          </div>
          <div>
            <Label>an alien theme</Label>
            <p className="mt-1 text-sm text-muted">
              Sci-fi chrome, glyph or logogram decoration, glow, and any theme that illustrates the product name. The
              whiteboard is not decorated with the heptapods’ script.
            </p>
          </div>
          <div>
            <Label>imposed structure</Label>
            <p className="mt-1 text-sm text-muted">
              Fixed roles, canned workflows, or a step template the model must fill in. The UI may draw those shapes
              from what ran; the AI surface does not require them.
            </p>
          </div>
          <div>
            <Label>visual noise</Label>
            <p className="mt-1 text-sm text-muted">
              A purple accent, glassy panels as decoration, a display serif, the kit’s default sans, and Source Sans
              italic. Backdrop blur appears only where a lane note floats over moving text.
            </p>
          </div>
        </div>
      </Section>
    </Page>
  ),
};

function Surface({
  name,
  constraint,
  children,
}: {
  readonly name: string;
  readonly constraint: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="rounded-md bg-wash p-5">
      <h3 className="text-base">{name}</h3>
      <p className="label mt-1 text-sm text-muted">{constraint}</p>
      <p className="mt-3 text-sm">{children}</p>
    </div>
  );
}

function Echo({ scene, asks }: { readonly scene: string; readonly asks: string }) {
  return (
    <li className="flex flex-col gap-1">
      <p className="text-sm text-muted">{scene}</p>
      <p className="text-sm">{asks}</p>
    </li>
  );
}

function Trait({ name, body }: { readonly name: string; readonly body: string }) {
  return (
    <div className="rounded-md bg-wash p-5">
      <h3 className="text-base">{name}</h3>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}

function Law({ n, title, children }: { readonly n: number; readonly title: string; readonly children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="mono w-5 shrink-0 text-sm text-subtle tabular-nums">{n}</span>
      <div>
        <h3 className="text-base">{title}</h3>
        <p className="mt-1 text-sm text-muted">{children}</p>
      </div>
    </li>
  );
}

const SURFACES = [
  ["canvas", "The page. The tape, dialogs, diff wells."],
  ["wash", "Containers: the rail, sent messages, code, tiles."],
  ["raised", "Menus and popovers. In dark it carries the lift a shadow cannot."],
  ["field", "Inside anything you type into."],
] as const;

const STRUCTURE = [
  ["line", "Divides and decorates. Never the only edge of a control."],
  ["edge", "Bounds a control; holds 3:1 against what is around it."],
] as const;

const STATES = [
  ["working", "An agent or call in progress. Blue."],
  ["warning", "Waiting on you; low quota. Amber."],
  ["success", "Live, running, added. Green."],
  ["danger", "Failed, removed, a non-zero exit. Red."],
] as const;

export const Color: Story = {
  render: () => (
    <Page
      title="Color"
      lede={
        <p>
          OKLCH, so equal steps read as equal. Each token is one <Mono>light-dark()</Mono> pair resolved by the
          element’s <Mono>color-scheme</Mono>: the OS preference, or <Mono>data-scheme</Mono> on the root. Values below
          are read from <Mono>styles.css</Mono>, so this page cannot drift from the app.
        </p>
      }
    >
      <Section
        title="Surfaces"
        note="Surfaces rise by lightness: canvas, then wash, then raised. Shadows exist only on overlays."
      >
        <Schemes>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {SURFACES.map(([name, role]) => (
              <Swatch key={name} name={name} role={role} />
            ))}
          </div>
        </Schemes>
      </Section>
      <Section
        title="Text tiers"
        note="Three tiers, each AA on every surface. Ink for what you read, muted for what explains it, subtle for what you can skip."
      >
        <Schemes>
          <div className="grid gap-3">
            {(["canvas", "wash", "raised"] as const).map((surface) => (
              <div
                key={surface}
                className="grid grid-cols-[5rem_1fr] items-center gap-3 rounded-sm border border-line p-3"
                style={{ background: `var(--${surface})` }}
              >
                <span className="mono text-xs text-subtle">{surface}</span>
                <p className="flex flex-wrap gap-x-4">
                  <span className="text-ink">Ink</span>
                  <span className="text-muted">Muted</span>
                  <span className="text-subtle">Subtle</span>
                </p>
              </div>
            ))}
          </div>
        </Schemes>
      </Section>
      <Section
        title="Structure and interaction"
        note="Hover and selection are ink laid over whatever is under them (7% and 11%), so one token works on every surface."
      >
        <Schemes>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {STRUCTURE.map(([name, role]) => (
              <Swatch key={name} name={name} role={role} />
            ))}
            <Swatch
              name="hover"
              role="Ink at 7%: a row or tile under the pointer."
              style={{
                backgroundColor: "var(--wash)",
                backgroundImage: "linear-gradient(var(--hover), var(--hover))",
              }}
            />
            <Swatch
              name="selected"
              role="Ink at 11%: the current row, an open provider."
              style={{
                backgroundColor: "var(--wash)",
                backgroundImage: "linear-gradient(var(--selected), var(--selected))",
              }}
            />
          </div>
        </Schemes>
      </Section>
      <Section
        title="State hues"
        note="The only chroma in the chrome. Each is AA as text, so a failed path can be read, not just seen."
      >
        <Schemes>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {STATES.map(([name, role]) => (
              <Swatch key={name} name={name} role={role} />
            ))}
          </div>
        </Schemes>
      </Section>
      <Section
        title="Changed lines"
        note="Lightness held near the surface so syntax colors keep AA; hue alone marks the line, and the changed words keep the strong mark."
      >
        <Schemes>
          <div className="grid grid-cols-2 gap-4">
            <Swatch name="added-line" role="An added line's wash." />
            <Swatch name="removed-line" role="A removed line's wash." />
          </div>
        </Schemes>
      </Section>
      <Section
        title="Terminal"
        note="The 16 ANSI colors, each AA on the output's wash. Grays are the page's own tiers, so a terminal never brings its own gray."
      >
        <Schemes>
          <div className="shell-term grid grid-cols-8 gap-2">
            {Array.from({ length: 16 }, (_, i) => (
              <div key={i} className="flex flex-col items-center gap-1 rounded-xs bg-wash py-2">
                <span className="mono text-sm font-strong" style={{ color: `var(--vt-${i})` }}>
                  Ab
                </span>
                <span className="mono text-xs text-subtle">{i}</span>
              </div>
            ))}
          </div>
        </Schemes>
      </Section>
      <Section title="Usage">
        <Rules
          items={[
            {
              do: <>Keep both sides of the bridge in the same neutral ink. The board belongs to neither.</>,
              dont: <>Give the model a signature hue, or color the person’s words to set them against it.</>,
            },
            {
              do: <>Reach for a state hue only when something is in that state right now.</>,
              dont: <>Tint a button, a header, or a link with a state hue to make it stand out.</>,
            },
            {
              do: (
                <>
                  Use <Mono>edge</Mono> for anything pressable; <Mono>line</Mono> for rules and dividers.
                </>
              ),
              dont: (
                <>
                  Bound an input with <Mono>line</Mono>: it falls under 3:1.
                </>
              ),
            },
            {
              do: <>Stack wash on canvas, raised on wash; one step per level.</>,
              dont: <>Put a shadow on a surface that is not floating over content.</>,
            },
          ]}
        />
      </Section>
    </Page>
  ),
};

const HEADING = "font-heading font-strong";
const SCALE = [
  [
    "2xl",
    "28 / 1.2",
    `text-2xl tracking-[-0.025em] ${HEADING}`,
    "Empty states, first-run heading, a fresh session's place.",
  ],
  ["xl", "23 / 1.25", `text-xl tracking-[-0.02em] ${HEADING}`, "Display size. The tape does not use it."],
  ["lg", "19 / 1.3", `text-lg ${HEADING}`, "Answer h1, peek titles, large tiles."],
  ["base", "16 / 1.5", "text-base", "Prose, the composer, rail header."],
  ["sm", "13 / 1.45", "text-sm", "Rows, tool summaries, menus, notes, buttons."],
  ["xs", "11 / 1.45", "text-xs", "Lane notes, account lines, workflow cards, paths."],
] as const;

export const Typography: Story = {
  render: () => (
    <Page
      title="Typography"
      lede={
        <p>
          Four roles on three self-hosted families, and a minor-third scale (×1.2) on a 16px base. Nothing loads from a
          font host.
        </p>
      }
    >
      <Section
        title="Roles"
        note={
          <>
            Two scripts share the board. Sans is the human reading: prose, summaries, the interface’s own words. Mono is
            the original: code, argv, paths, model ids, programs, exactly as the other side wrote or ran them. A reader
            can always tell a translation from its source.
          </>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Role name="Text" face="Source Sans 3" use="Tape prose, the composer, button verbs, rows.">
            <p className="text-lg">The agent read three files and proposed one edit.</p>
          </Role>
          <Role
            name="Headings"
            face="Nunito Sans, 620"
            use="h1–h4 and the product name. Tight tracking at display sizes."
          >
            <p className="font-heading text-xl font-strong tracking-[-0.02em]">Hide context_need calls in the web UI</p>
          </Role>
          <Role
            name="Code and paths"
            face="JetBrains Mono, roman"
            use="Code, argv, paths, model ids. Roman inside code; no faux styles."
          >
            <p className="mono text-sm">$ pnpm test -- packages/harness-web-app</p>
          </Role>
          <Role
            name="Labels"
            face="Source Sans 3, all-petite-caps"
            use="Field names, section names, mode chips. Written lowercase; never a heading or a button verb."
          >
            <p className="label text-base text-muted">sessions · bots · subscriptions</p>
          </Role>
        </div>
        <div className="rounded-md border border-line p-5" style={{ boxShadow: "inset 2px 0 0 var(--warning)" }}>
          <Label>emphasis — intended, not yet shipped</Label>
          <p className="mt-2 text-sm text-muted">
            The plan sets every italic run in JetBrains Mono italic, so emphasis never swaps to a faux or Source Sans
            italic. <Mono>styles.css</Mono> has no <Mono>em, i</Mono> rule yet, so prose emphasis renders as{" "}
            <em>Source Sans italic, like this</em>, which the plan rejected. Intended:{" "}
            <em className="mono not-italic" style={{ fontStyle: "italic" }}>
              JetBrains Mono italic, like this
            </em>
            .
          </p>
        </div>
      </Section>
      <Section
        title="Scale"
        note="Tailwind's scale is replaced, not extended: text-xs through text-2xl are the only sizes."
      >
        <div className="flex flex-col">
          {SCALE.map(([step, metrics, className, use]) => (
            <div
              key={step}
              className="grid grid-cols-[4rem_6rem_1fr] items-baseline gap-4 border-b border-line py-4 last:border-b-0"
            >
              <span className="mono text-xs text-subtle">{step}</span>
              <span className="mono text-xs text-subtle">{metrics}</span>
              <div className="min-w-0">
                <p className={className}>Sessions keep their drafts</p>
                <p className="mt-1 text-sm text-muted">{use}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Weights"
        note="Two weights, and the theme defines no others: regular for reading, font-strong (620) for every emphasis, heading or name."
      >
        <div className="flex flex-wrap gap-10">
          <p className="text-lg">Regular 400</p>
          <p className="text-lg font-strong">Name 620</p>
          <p className="font-heading text-lg font-strong">Heading 620</p>
        </div>
      </Section>
      <Section title="Usage">
        <Rules
          items={[
            {
              do: <>Answer headings are 19, 16, 16, 13.</>,
              dont: (
                <>
                  Let a model's <Mono># Heading</Mono> use a display size.
                </>
              ),
            },
            {
              do: (
                <>
                  Use <Mono>font-variant-caps: all-petite-caps</Mono> via <Mono>.label</Mono>.
                </>
              ),
              dont: (
                <>
                  Use <Mono>small-caps</Mono> or uppercase text: neither is the font's petite caps.
                </>
              ),
            },
            {
              do: <>Set paths and ids in mono at the size of the sentence around them.</>,
              dont: <>Put a path in a chip when it sits in a sentence; the chip is for code spans in prose.</>,
            },
          ]}
        />
      </Section>
    </Page>
  ),
};

function Role({
  name,
  face,
  use,
  children,
}: {
  readonly name: string;
  readonly face: string;
  readonly use: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-wash p-5">
      <div>
        <Label>{name}</Label>
        <p className="mono text-xs text-subtle">{face}</p>
      </div>
      {children}
      <p className="text-sm text-muted">{use}</p>
    </div>
  );
}

const RADII = [
  ["xs", "4px", "rounded-xs", "Chips, code spans, workflow tabs, status dots."],
  ["sm", "8px", "rounded-sm", "Rows, buttons, inputs, tool lists, small tiles."],
  ["md", "12px", "rounded-md", "Containers: messages, menus, panels, dialogs."],
] as const;

const GAPS = [
  ["tool run", "0", "Consecutive tools share edges: one list."],
  ["read lines", "4px", "A run of looks is one ambient block."],
  ["cell", "16px", "Cells inside one round."],
  ["note", "24px", "Notes in a lane."],
  ["round", "32px", "One round to the next."],
] as const;

export const SpaceAndShape: Story = {
  name: "Space and shape",
  render: () => (
    <Page
      title="Space and shape"
      lede={
        <p>
          A strict 4px grid with no half steps, three squircle radii, and two kinds of elevation. Distance does the
          grouping a border would otherwise do.
        </p>
      }
    >
      <Section
        title="Proximity"
        note="The tape's rhythm. Read it top to bottom: the closer two things sit, the more they belong together."
      >
        <div className="flex flex-col gap-3">
          {GAPS.map(([name, size, use]) => (
            <div key={name} className="grid grid-cols-[6rem_4rem_1fr] items-center gap-4">
              <span className="text-sm">{name}</span>
              <span className="mono text-xs text-subtle">{size}</span>
              <div className="flex items-center gap-3">
                <span className="h-4 shrink-0 rounded-xs bg-working" style={{ width: size === "0" ? 1 : size }} />
                <span className="text-sm text-muted">{use}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Radius"
        note="Every corner is a squircle (corner-shape: squircle), so a radius reads softer without growing into a pill; nothing takes a full radius. Outer equals inner plus inset: an 8px row inside a 12px container sits 4px in."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {RADII.map(([step, size, className, use]) => (
            <div key={step} className="flex flex-col gap-3">
              <div className={`h-20 border border-edge bg-wash ${className}`} />
              <p className="mono text-sm">
                rounded-{step} <span className="text-subtle">{size}</span>
              </p>
              <p className="text-sm text-muted">{use}</p>
            </div>
          ))}
        </div>
        <div className="max-w-sm rounded-md border border-line bg-raised p-1">
          <div className="rounded-sm bg-selected px-3 py-2 text-sm">A row nested 4px inside a menu</div>
          <div className="rounded-sm px-3 py-2 text-sm">Its sibling</div>
        </div>
      </Section>
      <Section
        title="Elevation"
        note="Two levels only. Flat content on the page; overlays float with a shadow that is stronger in dark, where the raised surface also carries the lift."
      >
        <Schemes>
          <div className="flex flex-wrap items-start gap-6 bg-wash p-6">
            <div className="rounded-md bg-canvas p-4 text-sm">Flat: wash under canvas</div>
            <div className="rounded-md border border-line bg-raised p-4 text-sm shadow-[var(--overlay-shadow)]">
              Overlay: raised + shadow
            </div>
          </div>
        </Schemes>
      </Section>
      <Section
        title="Targets"
        note="Fine pointers keep a 24px floor (rows are 32px); coarse pointers get 44px through .touch-target."
      >
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid size-6 place-items-center rounded-xs border border-dashed border-edge text-xs text-subtle">
            24
          </span>
          <span className="grid size-8 place-items-center rounded-sm border border-dashed border-edge text-xs text-subtle">
            32
          </span>
          <span className="grid size-11 place-items-center rounded-sm border border-dashed border-edge text-xs text-subtle">
            44
          </span>
        </div>
      </Section>
    </Page>
  ),
};

const DURATIONS = [
  ["120ms", "A tile's press."],
  ["150ms", "Feedback: hover, a chevron, a workflow card appearing."],
  ["200ms", "Something arriving: a dialog, a panel, a delayed notice."],
  ["140ms", "Something leaving. Quicker than arriving: the reader is done."],
  ["400ms", "Silence before any wait is shown. Most connects finish inside it."],
  ["4s / 8s", "When a wait adds its hint, then its “still trying”."],
  ["1600ms", "One breath of a waiting glyph."],
] as const;

export const Motion: Story = {
  render: () => <MotionPage />,
};

function MotionPage() {
  const [run, setRun] = useState(0);
  return (
    <Page
      title="Motion"
      lede={
        <p>
          Enter and exit ease out, strongly: <Mono>cubic-bezier(0.23, 1, 0.32, 1)</Mono>. Constant motion is linear.
          Nothing eases in. Under <Mono>prefers-reduced-motion</Mono> movement stops and fades stay, since opacity is
          not movement.
        </p>
      }
    >
      <Section title="Curve">
        <div className="flex flex-wrap items-end gap-10">
          <svg viewBox="-4 -4 108 108" className="size-40 overflow-visible" aria-label="The ease-out curve">
            <rect x="0" y="0" width="100" height="100" fill="none" stroke="var(--line)" />
            <path d="M0 100 C 23 0, 32 0, 100 0" fill="none" stroke="var(--ink)" strokeWidth="2" />
            <path d="M0 100 L100 0" fill="none" stroke="var(--line)" strokeDasharray="3 3" />
          </svg>
          <div className="flex flex-col gap-3">
            <Button variant="ghost" className="self-start border border-edge" onClick={() => setRun((n) => n + 1)}>
              Replay
            </Button>
            <div key={run} className="flex flex-col gap-3">
              <div className="w-64 rounded-md border border-line bg-raised p-3 text-sm shadow-[var(--overlay-shadow)] [animation:tile-in_200ms_var(--ease-out)_both]">
                A panel arriving: 6px rise, 200ms
              </div>
              <div className="link-notice" data-waiting="">
                <span className="link-glyph" data-waiting="" aria-hidden />
                <span className="link-text">Opening the session… (shows after 400ms)</span>
              </div>
              <div className="connecting-lines w-72">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </div>
      </Section>
      <Section title="Durations">
        <div className="flex flex-col">
          {DURATIONS.map(([time, use]) => (
            <div key={time} className="grid grid-cols-[6rem_1fr] gap-4 border-b border-line py-3 last:border-b-0">
              <span className="mono text-sm">{time}</span>
              <span className="text-sm text-muted">{use}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Usage">
        <Rules
          items={[
            {
              do: (
                <>Animate opacity, transform, and clip-path; a loader's bars draw by clip so their round ends keep.</>
              ),
              dont: <>Animate width, height, or anything that moves layout.</>,
            },
            {
              do: <>Show text as it arrives, at the rate it arrives.</>,
              dont: (
                <>Pace tokens, add typing dots, or stage a “thinking” animation to make the model feel like a person.</>
              ),
            },
            {
              do: <>Let a wait be silent for 400ms, then breathe.</>,
              dont: <>Flash a spinner for a connect that takes 80ms.</>,
            },
            {
              do: <>Use the spinner only for a call that is running right now.</>,
              dont: <>Loop motion to suggest activity the daemon has not reported.</>,
            },
          ]}
        />
        <p className="text-sm text-muted">
          See them live: <StoryLink id="app--connecting">App › Connecting</StoryLink>,{" "}
          <StoryLink id="connection--reconnecting">Connection › Reconnecting</StoryLink>,{" "}
          <StoryLink id="tape--agent-peek">Tape › Agent Peek</StoryLink>.
        </p>
      </Section>
    </Page>
  );
}
