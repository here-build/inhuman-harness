/* eslint-disable import-x/no-relative-packages -- The workspace brand documents are the single normative source, not a runtime package dependency. */
import { useState } from "react";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import type { Meta, StoryObj } from "@storybook/react-vite";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Page, Schemes, Section, StoryLink, Swatch } from "./brand-kit.js";
import brandCore from "../../../../docs/brand/brand-core.md?raw";
import designDirection from "../../../../docs/brand/design-direction.md?raw";
import designSystem from "../../../../docs/brand/design-system.md?raw";
import textBrandbook from "../../../../docs/brand/text-brandbook.md?raw";

const guide = [brandCore, textBrandbook, designDirection, designSystem].join("\n\n---\n\n");

const meta = {
  title: "Graphic Precision/System",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The consolidated normative brand and UI architecture documents rendered directly. */
export const Guidelines: Story = {
  render: () => (
    <Page
      title="Graphic Precision"
      lede="The design, tone-of-voice, and white-label system for sustained everyday work."
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
    <Page title="Meaning determines appearance" lede="Assign a role before choosing a font, size, color, or boundary.">
      <Section
        title="Three voices, stable meanings"
        note="Test both schemes, literal case, and long names. Petite caps are a font treatment; underlying text stays unchanged."
      >
        <Schemes>
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="font-heading text-xl">Autumn campaign launch</h2>
              <p className="mt-2">A long project title remains content in natural case, not a command.</p>
            </div>
            <div className="flex flex-wrap gap-6">
              <span className="label text-sm">Overview</span>
              <span className="label text-sm">Settings</span>
              <span className="label text-sm">Published</span>
            </div>
            <p>Changes saved cleanly across active surfaces.</p>
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

const CORE_SWATCHES: ReadonlyArray<readonly [string, string]> = [
  ["canvas", "Primary document surface"],
  ["wash", "Recessed band and secondary surface"],
  ["raised", "Floating popover and dialog ground"],
  ["field", "Editable control ground"],
  ["line", "Hairline structural divider"],
  ["edge", "Control border and interactive rule"],
  ["ink", "Primary copy and headings"],
  ["muted", "Secondary labels and notes"],
  ["subtle", "Low-emphasis technical metadata"],
  ["accent", "Primary action fill"],
  ["accent-ink", "Foreground paired with --accent"],
  ["selection-marker", "Selected tab, item, and indicator rule"],
  ["focus", "Keyboard focus outline"],
  ["added-line", "Diff addition wash"],
  ["removed-line", "Diff removal wash"],
];

export const TokensAndSurfaces: Story = {
  render: () => (
    <Page
      title="Tokens and surfaces"
      lede="Live OKLCH light-dark pairs read straight from the shipped @inhuman.tools/harness-ui token sheet."
    >
      <Section
        title="Surface, ink, and interactive pairs"
        note="Overriding any token in :root or @layer overrides re-themes every control without altering structure."
      >
        <Schemes>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CORE_SWATCHES.map(([name, role]) => (
              <Swatch key={name} name={name} role={role} />
            ))}
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};

const STATUS_ITEMS: ReadonlyArray<{ readonly label: string; readonly token: string; readonly note: string }> = [
  { label: "Running", token: "working", note: "Active agent round or queued tool execution." },
  { label: "Attention", token: "warning", note: "Connection interrupted or confirmation needed." },
  { label: "Failed", token: "danger", note: "Action rejected, invalid input, or fatal tool error." },
  { label: "Ready", token: "success", note: "Completed verification or healthy session state." },
];

export const StatusLanguage: Story = {
  render: () => (
    <Page
      title="Status and terminal language"
      lede="Four operational states and the 16-color terminal ANSI palette (--vt-0 through --vt-15)."
    >
      <Section title="Four-state operational signals">
        <Schemes>
          <div className="grid gap-4 sm:grid-cols-2">
            {STATUS_ITEMS.map((item) => (
              <div key={item.label} className="border-l-2 pl-4" style={{ borderColor: `var(--${item.token})` }}>
                <p className="label text-sm" style={{ color: `var(--${item.token})` }}>
                  {item.label}
                </p>
                <p className="mt-1 text-sm text-muted">{item.note}</p>
              </div>
            ))}
          </div>
        </Schemes>
      </Section>
      <Section title="Terminal ANSI palette (--vt-0 .. --vt-15)">
        <Schemes>
          <div
            className="shell-term grid grid-cols-4 gap-3 rounded-sm border border-line p-4 sm:grid-cols-8"
            style={{ marginInline: 0, paddingInlineStart: "1rem" }}
          >
            {Array.from({ length: 16 }, (_, index) => (
              <div key={index} className="flex flex-col gap-1">
                <div className="h-7 rounded-xs border border-line" style={{ background: `var(--vt-${index})` }} />
                <span className="mono text-xs text-muted">--vt-{index}</span>
              </div>
            ))}
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};

export const VisualAndVerbalLanguage: Story = {
  render: () => (
    <Page
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
      title="Implementation contract"
      lede="Documentation -> tokens & axis scopes -> accessible primitives -> composable product blocks. Shared rules apply to the full app, not only this catalog."
    >
      <Section title="Behavior ownership">
        <ul className="flex max-w-[70ch] list-disc flex-col gap-3 pl-5">
          <li>
            React Aria owns interaction semantics for reusable controls. Product state, drafts, and RPC behavior stay in
            feature components.
          </li>
          <li>
            Floating blocks use native HTML top-layer popovers and viewport-clamped positioning (useFloatingPosition)
            for Safari 18.7+ support with zero CSS Anchor Positioning.
          </li>
          <li>
            Both schemes use the same semantic OKLCH light-dark tokens. Axis scopes (.surface-boundary,
            .prominence-boundary, .emphasis-boundary, .density-boundary) isolate nested overrides.
          </li>
          <li>
            Names, messages, and field labels use natural case. Only commands, modes, navigation, and status symbols use
            petite caps.
          </li>
          <li>
            Keyboard focus, selection, hover, progress, and errors remain visually distinct without motion or color
            alone.
          </li>
        </ul>
      </Section>
      <Section
        title="Product and white-label verification"
        note="Shared controls, contextual axes, and product surfaces are tested interactively in Vitest and Chromium."
      >
        <div className="flex flex-col items-start gap-3">
          <StoryLink id="white-label-design-system-scopes--axis-scopes-and-visibility">
            Axis scopes & visibility
          </StoryLink>
          <StoryLink id="graphic-precision-anchored--selection">Anchored selection</StoryLink>
          <StoryLink id="app--workspace">Workspace</StoryLink>
          <StoryLink id="settings--connections">Settings</StoryLink>
          <StoryLink id="composer--empty">Composer</StoryLink>
        </div>
      </Section>
    </Page>
  ),
};
