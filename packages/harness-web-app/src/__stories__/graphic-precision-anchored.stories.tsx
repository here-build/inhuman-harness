import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button as AriaButton, Header, Text } from "react-aria-components";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  Autocomplete,
  Dialog,
  DropdownSelect,
  Menu,
  MenuItem,
  MenuSection,
  MenuTrigger,
  NativePopover,
  SubmenuTrigger,
  Tooltip,
  type AnchoredOption,
} from "../components/ui/anchored.js";
import { Button } from "../components/ui/button.js";

const meta = {
  title: "Graphic Precision/Anchored",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const options: AnchoredOption[] = [
  { id: "draft", label: "Draft", description: "Only your team can see it" },
  { id: "review", label: "In review", description: "Ready for feedback" },
  { id: "published", label: "Published" },
  { id: "archived", label: "Archived", isDisabled: true },
];

export const Selection: Story = {
  render: () => (
    <Page
      historical={false}
      title="Anchored selection"
      lede="Native top-layer popovers stay attached with CSS anchors. React Aria owns keyboard navigation, typeahead, labels, and native form integration."
    >
      <Section
        title="Select and autocomplete"
        note="Use Tab, ArrowDown, typeahead, Enter, and Escape. Submit or reset the form to inspect its native values. Requires a browser with CSS anchor positioning and Popover API; no JavaScript positioning library is loaded."
      >
        <Schemes>
          <SelectionExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function SelectionExample() {
  const [submitted, setSubmitted] = useState("No submission yet");
  return (
    <form
      className="flex max-w-sm flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        setSubmitted(`Status: ${values.get("status")}; assignee: ${values.get("assignee") || "none"}`);
      }}
    >
      <DropdownSelect
        label="Status"
        name="status"
        options={options}
        defaultSelectedKey="draft"
        description="Choose the project's visibility."
        isRequired
        errorMessage="Choose a status."
      />
      <Autocomplete
        label="Assignee"
        name="assignee"
        options={[
          { id: "ada", label: "Ada Lovelace" },
          { id: "grace", label: "Grace Hopper" },
          { id: "margaret", label: "Margaret Hamilton" },
          { id: "alan", label: "Alan Turing", isDisabled: true },
        ]}
        placeholder="Search people"
        description="Type to filter, then use ArrowDown and Enter."
      />
      <div className="flex gap-3">
        <Button type="submit">Submit</Button>
        <Button variant="secondary" type="reset">
          Reset
        </Button>
      </div>
      <p role="status" className="text-sm text-muted">
        {submitted}
      </p>
    </form>
  );
}

export const States: Story = {
  render: () => (
    <Page
      historical={false}
      title="Selection states"
      lede="Availability and errors stay explicit; focus is an outline, never an accent-colored surface."
    >
      <Section
        title="Validation and availability"
        note="The required field participates in native form validation. Disabled options cannot be selected."
      >
        <Schemes>
          <div className="flex max-w-sm flex-col gap-5">
            <DropdownSelect
              label="Required status"
              name="status"
              options={options}
              isRequired
              description="Select a value before submitting."
            />
            <DropdownSelect
              label="Invalid status"
              options={options}
              selectedKey={null}
              isInvalid
              validationBehavior="aria"
              errorMessage="Choose an available status."
            />
            <DropdownSelect label="Disabled status" options={options} defaultSelectedKey="draft" isDisabled />
            <Autocomplete label="Unavailable search" options={options} isDisabled />
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};

export const Menus: Story = {
  render: () => (
    <Page
      historical={false}
      title="Anchored commands"
      lede="Menu items, sections, and submenus retain React Aria semantics in native popovers, without RAC positioning."
    >
      <Section
        title="Project actions"
        note="Open with Enter or ArrowDown. ArrowRight opens Share, ArrowLeft returns. Escape closes the current level; choosing an action returns focus."
      >
        <Schemes>
          <MenuExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function MenuExample() {
  const [action, setAction] = useState("No action yet");
  return (
    <div className="flex flex-col items-start gap-4">
      <MenuTrigger>
        <AriaButton className="gp-anchored-trigger">
          Project actions <span aria-hidden="true">▾</span>
        </AriaButton>
        <NativePopover>
          <Menu onAction={(key) => setAction(String(key))}>
            <MenuSection>
              <Header>Project</Header>
              <MenuItem id="Rename">Rename</MenuItem>
              <MenuItem id="Duplicate">Duplicate</MenuItem>
            </MenuSection>
            <MenuSection aria-label="Sharing and removal">
              <SubmenuTrigger>
                <MenuItem id="share">Share</MenuItem>
                <NativePopover>
                  <Menu onAction={(key) => setAction(String(key))}>
                    <MenuItem id="Copy link">Copy link</MenuItem>
                    <MenuItem id="Invite team">Invite team</MenuItem>
                  </Menu>
                </NativePopover>
              </SubmenuTrigger>
              <MenuItem id="Export" isDisabled>
                Export (unavailable)
              </MenuItem>
              <MenuItem id="Delete">
                <Text slot="label">Delete</Text>
                <Text slot="description" className="gp-anchored-description">
                  Requires confirmation
                </Text>
              </MenuItem>
            </MenuSection>
          </Menu>
        </NativePopover>
      </MenuTrigger>
      <p role="status" className="text-sm text-muted">
        {action}
      </p>
    </div>
  );
}

export const NativeOverlays: Story = {
  render: () => (
    <Page
      historical={false}
      title="Native hints and dialogs"
      lede="Hints use the native popover top layer and CSS anchors; dialogs use showModal, browser focus return, and React Aria labelling."
    >
      <Section
        title="Description and confirmation"
        note="Hover to delay a hint; keyboard focus describes immediately. Escape dismisses. Dialogs are controlled native modals, not RAC DialogTrigger children."
      >
        <Schemes>
          <OverlayExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function OverlayExample() {
  const [isOpen, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap gap-4">
      <Tooltip content="Copy the project's public URL.">
        <Button variant="secondary">Copy link</Button>
      </Tooltip>
      <Button onPress={() => setOpen(true)}>Delete project…</Button>
      <Dialog label="Delete project?" isOpen={isOpen} onOpenChange={setOpen}>
        <p className="mb-5 text-sm">This demonstration does not delete any data.</p>
        <div className="flex gap-3">
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" onPress={() => setOpen(false)}>
            Delete project
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export const EdgePlacement: Story = {
  render: () => (
    <Page
      historical={false}
      title="Viewport edge placement"
      lede="CSS position-try-fallbacks flip the native top-layer surface when its preferred position does not fit."
    >
      <Section
        title="Bottom and inline edges"
        note="Scroll this frame, open the control near its lower edge, and resize the viewport. These are native CSS anchors, not measured coordinates."
      >
        <div className="flex min-h-[65vh] items-end justify-end p-4">
          <DropdownSelect label="Status at the edge" options={options} />
        </div>
      </Section>
    </Page>
  ),
};
