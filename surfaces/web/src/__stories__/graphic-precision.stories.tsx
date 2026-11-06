import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// The workspace document is the single normative source, not a runtime package dependency.
// eslint-disable-next-line import-x/no-relative-packages
import guide from "../../../../docs/graphic-precision.md?raw";
import { Page, Schemes, Section, StoryLink } from "./brand-kit.js";
import { Button } from "../components/ui/button.js";

const meta = {
  title: "Graphic Precision/System",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The normative document itself, not a separately maintained abridgement. */
export const Guidelines: Story = {
  render: () => (
    <Page
      historical={false}
      title="Graphic Precision"
      lede="The design and tone-of-voice system for sustained, everyday work."
    >
      <div className="prose max-w-none">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Keep document navigation inside Storybook; repository documents remain the source.
            a: ({ children }) => <span>{children}</span>,
          }}
        >
          {guide}
        </ReactMarkdown>
      </div>
    </Page>
  ),
};

export const MeaningAndTypography: Story = {
  render: () => (
    <Page
      historical={false}
      title="Meaning determines appearance"
      lede="Assign a role before choosing a font, size, color, or boundary."
    >
      <Section
        title="Three voices, stable meanings"
        note="Test both themes, Cyrillic, literal case, and long names. Petite caps are a font treatment; underlying text stays unchanged."
      >
        <Schemes>
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="font-heading text-xl">Осенний запуск проекта</h2>
              <p className="mt-2">Autumn campaign launch — a long project name remains content, not a command.</p>
            </div>
            <div className="flex flex-wrap gap-6">
              <span className="label text-sm">Overview</span>
              <span className="label text-sm">Настройки</span>
              <span className="label text-sm">Published</span>
            </div>
            <p>Changes saved. Изменения сохранены.</p>
            <p>
              <code className="mono">PRJ-0284 / production / ⌘K</code>
            </p>
            <p className="tabular-nums">248 records · 18.5% · 31 October 2026</p>
            <p className="text-xs text-muted">Amounts, percentages, and dates stay in Source Sans 3.</p>
          </div>
        </Schemes>
      </Section>
      <Section title="Starting scale" note="Hierarchy comes from size, spacing, and placement before weight.">
        <div className="flex flex-col gap-6">
          <h1 className="font-heading text-2xl">Page title · 28 / 34</h1>
          <h2 className="font-heading text-xl">Section heading · 20 / 26</h2>
          <p className="text-base">Body text · 16 / 24</p>
          <p className="text-sm">Compact interface · 14 / 20</p>
          <p className="label text-sm">Export CSV · textual symbol</p>
          <p className="text-xs text-muted">Supporting information · 13 / 18</p>
        </div>
      </Section>
    </Page>
  ),
};

export const VisualAndVerbalLanguage: Story = {
  render: () => (
    <Page
      historical={false}
      title="Visual and verbal language"
      lede="Commands identify actions. Natural-case text explains consequences. Literal values remain exact."
    >
      <Section
        title="Export flow"
        note="One primary action, a neutral working surface, and a quiet local completion status."
      >
        <Schemes>
          <ExportExample />
        </Schemes>
      </Section>
      <Section title="Consequence determines prominence">
        <Schemes>
          <div className="flex flex-col gap-6">
            <p className="text-sm text-muted">Changes saved</p>
            <div className="border-l-2 border-warning pl-4">
              <p>Connection lost.</p>
              <p className="text-sm text-muted">Your draft is still available. Reconnect to send it.</p>
            </div>
            <div className="border-l-2 border-danger pl-4">
              <h3 className="font-heading text-xl">Delete project?</h3>
              <p className="mt-2">The project and its 24 tasks will be deleted. This cannot be undone.</p>
            </div>
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};

function ExportExample() {
  const [ready, setReady] = useState(false);
  return (
    <div className="flex flex-col items-start gap-4">
      <h3 className="font-heading text-xl">Export records</h3>
      <p>The file will include 248 records matching your current filters.</p>
      <code className="mono text-sm">projects-2026-10-31.csv</code>
      <Button onClick={() => setReady(true)}>Download CSV</Button>
      <p role="status" className="min-h-5 text-sm text-muted">
        {ready ? "File ready" : ""}
      </p>
      <p className="text-xs text-muted">Typography and feedback example; no file is generated.</p>
    </div>
  );
}

export const ImplementationContract: Story = {
  render: () => (
    <Page
      historical={false}
      title="Implementation contract"
      lede="Documentation → foundations → accessible components → product surfaces. Shared foundations apply to the actual app, not only this catalog."
    >
      <Section title="Behavior ownership">
        <ul className="flex max-w-[70ch] list-disc flex-col gap-3 pl-5">
          <li>
            React Aria owns interaction semantics for reusable controls. Product state, drafts, and RPC behavior stay in
            feature components.
          </li>
          <li>
            Floating blocks retain native Popover API and CSS Anchor Positioning. Do not introduce a second positioning
            engine.
          </li>
          <li>
            Both themes use the same semantic tokens. The existing data-scheme contract remains shared with syntax
            highlighting.
          </li>
          <li>
            Names, messages, and field labels use natural case. Only commands, modes, navigation, and status symbols use
            petite caps.
          </li>
          <li>
            Keyboard focus, selection, hover, progress, and errors must remain distinct without motion or color alone.
          </li>
        </ul>
      </Section>
      <Section
        title="Product verification"
        note="The existing journeys stay live against the real router and models. A token update is not a claim that every journey has passed visual and assistive-technology review."
      >
        <div className="flex flex-col items-start gap-3">
          <StoryLink id="app--workspace">Workspace</StoryLink>
          <StoryLink id="settings--connections">Settings</StoryLink>
          <StoryLink id="composer--empty">Composer</StoryLink>
          <StoryLink id="brandbook-journeys--map">Journey map</StoryLink>
        </div>
      </Section>
    </Page>
  ),
};
