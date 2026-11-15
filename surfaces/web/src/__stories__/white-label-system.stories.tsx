import { useState, type CSSProperties } from "react";
import {
  Autocomplete,
  Button,
  ControlGroup,
  DensityScope,
  DropdownSelect,
  EmphasisScope,
  ProminenceScope,
  SurfaceScope,
  Visibility,
  VoiceProvider,
  defineVoiceCatalog,
  enVoiceCatalog,
  type AnchoredOption,
  type VisibilityMode,
} from "@inhuman.tools/harness-ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Page, Schemes, Section } from "./brand-kit.js";

const meta = {
  title: "White Label/Design System & Scopes",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const runtimeOptions: readonly AnchoredOption[] = [
  { id: "sandbox-strict", label: "Sandbox strict" },
  { id: "workspace-write", label: "Workspace write" },
  { id: "review-only", label: "Review only" },
];

const brandOptions: readonly AnchoredOption[] = [
  { id: "acme-pro", label: "Acme Workspace Pro" },
  { id: "acme-edge", label: "Acme Edge Runner" },
  { id: "acme-audit", label: "Acme Audit Mode" },
];

const softBrandVoice = defineVoiceCatalog(
  {
    common: {
      close: "Dismiss",
      empty: "Nothing queued",
    },
    select: {
      emptyText: "No profiles available",
      optionsLabel: "Workspace profiles",
      showSuggestions: "Browse profiles",
      noMatches: "No matching profiles",
    },
  },
  enVoiceCatalog,
);

const softBrandVars: CSSProperties = {
  "--radius-xs": "6px",
  "--radius-sm": "10px",
  "--radius-md": "14px",
  "--radius-lg": "18px",
  "--accent": "light-dark(oklch(0.55 0.2 260), oklch(0.68 0.18 258))",
  "--accent-ink": "oklch(0.99 0 0)",
  "--focus": "oklch(0.55 0.2 260)",
} as CSSProperties;

const visibilityModes: readonly AnchoredOption[] = [
  { id: "visible", label: "visible (Activity visible)" },
  { id: "hidden", label: "hidden (Activity hidden, state kept)" },
  { id: "display-none", label: "display-none (DOM kept, hidden attr)" },
  { id: "invisible", label: "invisible (layout box kept)" },
  { id: "unmounted", label: "unmounted (torn down)" },
];

export const DefaultVsSoftWhiteLabel: Story = {
  render: () => (
    <Page
      title="White-Label Foundation"
      lede="Primitives resolve radius, OKLCH ink/accent tokens, intrinsic Nlh/Nch rhythm, and VoiceProvider strings cleanly without component edits."
    >
      <Section
        title="Default Graphic Precision vs. Soft Rounded Override"
        note="Both columns render identical primitives from @inhuman.tools/harness-ui; the right column overrides CSS radius/accent custom properties and supplies a nested VoiceProvider."
      >
        <Schemes>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="border border-line bg-canvas p-4 flex flex-col gap-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Graphic Precision (default)</h3>
                <span className="text-xs text-muted">0px corners • enVoiceCatalog</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="default">Run verification</Button>
                <ControlGroup aria-label="View mode">
                  <Button variant="secondary">Diff</Button>
                  <Button variant="secondary">Trace</Button>
                  <Button variant="secondary">Logs</Button>
                </ControlGroup>
              </div>
              <DropdownSelect
                label="Execution profile"
                name="default-profile"
                options={runtimeOptions}
                defaultSelectedKey="sandbox-strict"
              />
              <Autocomplete
                label="Quick filter"
                name="default-filter"
                options={runtimeOptions}
                placeholder="Type a policy..."
              />
            </div>

            <VoiceProvider catalog={softBrandVoice}>
              <div
                style={softBrandVars}
                className="rounded-[var(--radius-md)] border border-line bg-canvas p-4 flex flex-col gap-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">White-Label Soft Theme</h3>
                  <span className="text-xs text-muted">rounded tokens • custom VoiceProvider</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="default">Launch check</Button>
                  <ControlGroup aria-label="Workspace actions">
                    <Button variant="secondary">Compare</Button>
                    <Button variant="secondary">Inspect</Button>
                    <Button variant="secondary">Export</Button>
                  </ControlGroup>
                </div>
                <DropdownSelect
                  label="Workspace profile"
                  name="brand-profile"
                  options={brandOptions}
                  defaultSelectedKey="acme-pro"
                />
                <Autocomplete
                  label="Browse profiles"
                  name="brand-filter"
                  options={brandOptions}
                  placeholder="Search workspace profile..."
                />
              </div>
            </VoiceProvider>
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getAllByRole("button", { name: /Workspace profile/ })[0]!;
    await userEvent.click(trigger);
    const listbox = body.getByRole("listbox");
    await userEvent.click(within(listbox).getByRole("option", { name: "Acme Edge Runner" }));
    await expect(body.queryByRole("listbox")).toBeNull();
    await expect(trigger.textContent).toContain("Acme Edge Runner");
  },
};

export const AxisScopesAndVisibility: Story = {
  render: () => (
    <Page
      title="Independent Donut Axes & Visibility"
      lede="Each Mercury design axis is an independent donut @scope stopped by its own boundary class, paired with 5-state Visibility."
    >
      <Section
        title="Nested Axis Scopes"
        note="Changing an outer axis leaves inner boundary elements isolated per axis rather than cascading indiscriminately."
      >
        <Schemes>
          <AxisShowcase />
        </Schemes>
      </Section>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const probe = canvas.getAllByRole("button", { name: /Increment stateful probe/ })[0]!;
    await userEvent.click(probe);
    await expect(probe.textContent).toContain("(1)");

    const visibilityTrigger = canvas.getAllByRole("button", { name: /Visibility mode/ })[0]!;
    await userEvent.click(visibilityTrigger);
    await userEvent.click(within(body.getByRole("listbox")).getByRole("option", { name: /hidden \(Activity hidden/ }));
    await expect(body.queryByRole("listbox")).toBeNull();

    await userEvent.click(visibilityTrigger);
    await userEvent.click(
      within(body.getByRole("listbox")).getByRole("option", { name: /visible \(Activity visible/ }),
    );
    await expect(body.queryByRole("listbox")).toBeNull();
    await expect(canvas.getAllByText(/counter = 1/i).length).toBeGreaterThan(0);
  },
};

function AxisShowcase() {
  const [mode, setMode] = useState<VisibilityMode>("visible");
  const [ticks, setTicks] = useState(0);

  return (
    <div className="flex flex-col gap-6">
      <SurfaceScope surface="soft" className="border border-line p-4 flex flex-col gap-4">
        <div className="text-xs text-muted">Outer SurfaceScope=&quot;soft&quot;</div>
        <DensityScope density="compact" className="flex flex-wrap items-center gap-3">
          <ProminenceScope prominence="raised" className="border border-edge bg-raised p-3 flex flex-col gap-2">
            <span className="text-xs font-semibold">
              ProminenceScope=&quot;raised&quot; + DensityScope=&quot;compact&quot;
            </span>
            <EmphasisScope emphasis="accent" className="inline-flex items-center gap-2">
              <Button variant="default" onPress={() => setTicks((n) => n + 1)}>
                Increment stateful probe ({ticks})
              </Button>
            </EmphasisScope>
          </ProminenceScope>

          <SurfaceScope surface="well" className="border border-edge p-3 flex flex-col gap-2">
            <span className="text-xs font-semibold">Nested SurfaceScope=&quot;well&quot; boundary</span>
            <EmphasisScope emphasis="danger">
              <Button variant="danger">Destructive action</Button>
            </EmphasisScope>
          </SurfaceScope>
        </DensityScope>
      </SurfaceScope>

      <div className="border border-line p-4 flex flex-col gap-3">
        <DropdownSelect
          label="Visibility mode"
          name="visibility-mode"
          options={visibilityModes}
          selectedKey={mode}
          onSelectionChange={(key) => {
            if (typeof key === "string") setMode(key as VisibilityMode);
          }}
        />
        <Visibility mode={mode} className="border border-line p-3 bg-wash">
          <p className="text-sm">
            Active Visibility probe state: <strong>{mode}</strong> (counter = {ticks})
          </p>
        </Visibility>
      </div>
    </div>
  );
}
