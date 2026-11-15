import { useState } from "react";
import { Button } from "@inhuman.tools/harness-ui/primitives/button";
import { Checkbox } from "@inhuman.tools/harness-ui/primitives/checkbox";
import { Radio, RadioGroup } from "@inhuman.tools/harness-ui/primitives/radio-group";
import { Switch } from "@inhuman.tools/harness-ui/primitives/switch";
import { Tab, TabList, TabPanel, Tabs } from "@inhuman.tools/harness-ui/primitives/tabs";
import { TextField } from "@inhuman.tools/harness-ui/primitives/text-field";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Page, Schemes, Section } from "./brand-kit.js";

const meta = {
  title: "Graphic Precision/Components",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <Page
      title="Buttons"
      lede="Commands retain native button behavior, with one primary action and a visible keyboard focus outline."
    >
      <Section
        title="Variants and states"
        note="Tab to focus, then use Enter or Space. Pending actions cannot be activated again."
      >
        <Schemes>
          <ButtonExamples />
        </Schemes>
      </Section>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect((canvas.getAllByRole("button", { name: "Unavailable" })[0] as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(canvas.getAllByRole("button", { name: "Save changes" })[0]!);
    await expect(canvas.getAllByRole("status")[0]?.textContent).toBe("Form submitted");
  },
};

function ButtonExamples() {
  const [status, setStatus] = useState("No action yet");
  return (
    <form
      className="flex flex-col items-start gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setStatus("Form submitted");
      }}
    >
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Save changes</Button>
        <Button variant="secondary" onPress={() => setStatus("Preview opened")}>
          Preview
        </Button>
        <Button variant="ghost" onClick={() => setStatus("Cancelled")}>
          Cancel
        </Button>
        <Button variant="danger" onPress={() => setStatus("Project deleted")}>
          Delete project
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button disabled>Unavailable</Button>
        <Button variant="secondary" disabled>
          Unavailable
        </Button>
        <Button variant="ghost" disabled>
          Unavailable
        </Button>
        <Button variant="danger" disabled>
          Unavailable
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button isBusy>Saving…</Button>
        <Button variant="secondary" isBusy>
          Loading preview…
        </Button>
      </div>
      <p role="status" className="text-sm text-muted">
        {status}
      </p>
    </form>
  );
}

export const LabeledFields: Story = {
  render: () => (
    <Page
      title="Labeled fields"
      lede="Persistent labels, descriptions, and validation messages are associated with their native inputs."
    >
      <Section
        title="Editing and validation"
        note="Placeholders are examples, not substitutes for labels. Errors explain how to recover."
      >
        <Schemes>
          <div className="flex flex-col gap-5">
            <TextField
              label="Project name"
              name="project"
              description="Use a name your team will recognize."
              placeholder="Autumn launch"
              isRequired
            />
            <TextField
              label="Notes"
              name="notes"
              multiline
              rows={3}
              description="Optional context for your team."
              defaultValue="Review the release plan."
            />
            <TextField
              label="Contact email"
              type="email"
              defaultValue="not-an-email"
              validationBehavior="aria"
              isInvalid
              errorMessage="Enter an email address, such as name@example.com."
              description="Used for release notifications."
            />
            <TextField
              label="Workspace"
              defaultValue="Production"
              isReadOnly
              description="Your administrator manages this value."
            />
            <TextField label="Archive path" defaultValue="/projects/archive" isDisabled />
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};

export const SelectionControls: Story = {
  render: () => (
    <Page
      title="Selection controls"
      lede="Checkboxes select options, radios choose one value, and switches turn a setting on or off."
    >
      <Section
        title="Selection and availability"
        note="Use Space for checkboxes and switches; arrow keys move between radio options."
      >
        <Schemes>
          <SelectionExamples />
        </Schemes>
      </Section>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const archived = canvas.getAllByRole("checkbox", { name: "Include archived tasks" })[0] as HTMLInputElement;
    await userEvent.click(archived);
    await expect(archived.checked).toBe(true);
    const jsonRadio = canvas.getAllByRole("radio", { name: "JSON" })[0] as HTMLInputElement;
    await userEvent.click(jsonRadio);
    await expect(jsonRadio.checked).toBe(true);
  },
};

function SelectionExamples() {
  const [notifications, setNotifications] = useState(true);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-1">
        <Checkbox defaultSelected>Include completed tasks</Checkbox>
        <Checkbox>Include archived tasks</Checkbox>
        <Checkbox isIndeterminate>Select all projects</Checkbox>
        <Checkbox isDisabled>Include private projects</Checkbox>
        <Checkbox isDisabled defaultSelected>
          Keep audit history
        </Checkbox>
      </div>
      <RadioGroup
        label="Export format"
        description="Choose one format for the download."
        defaultValue="csv"
        name="format"
      >
        <Radio value="csv">CSV</Radio>
        <Radio value="json">JSON</Radio>
        <Radio value="xml" isDisabled>
          XML (unavailable)
        </Radio>
      </RadioGroup>
      <RadioGroup
        label="Delivery method"
        description="Required before exporting."
        validationBehavior="aria"
        isInvalid
        errorMessage="Choose a delivery method."
      >
        <Radio value="download">Download</Radio>
        <Radio value="email">Email</Radio>
      </RadioGroup>
      <RadioGroup label="Managed region" defaultValue="eu" isDisabled>
        <Radio value="eu">Europe</Radio>
        <Radio value="us">United States</Radio>
      </RadioGroup>
      <div className="flex flex-col items-start gap-1">
        <Switch isSelected={notifications} onChange={setNotifications}>
          Release notifications
        </Switch>
        <p role="status" className="text-xs text-muted">
          Notifications {notifications ? "on" : "off"}
        </p>
        <Switch isDisabled>Automatic publishing</Switch>
        <Switch isDisabled defaultSelected>
          Security notifications
        </Switch>
      </div>
    </div>
  );
}

export const TabNavigation: Story = {
  render: () => (
    <Page
      title="Tabs"
      lede="Each tab names one panel. Selection, keyboard focus, and disabled tabs have distinct states."
    >
      <Section
        title="Horizontal tabs"
        note="Arrow keys change tabs, skipping unavailable panels. Home and End move to the first and last available tab."
      >
        <Schemes>
          <Tabs defaultSelectedKey="overview">
            <TabList aria-label="Project sections">
              <Tab id="overview">Overview</Tab>
              <Tab id="activity">Activity</Tab>
              <Tab id="billing" isDisabled>
                Billing
              </Tab>
            </TabList>
            <TabPanel id="overview">Project details and release status.</TabPanel>
            <TabPanel id="activity">No recent activity.</TabPanel>
            <TabPanel id="billing">Billing details.</TabPanel>
          </Tabs>
        </Schemes>
      </Section>
      <Section title="Vertical tabs">
        <Schemes>
          <Tabs orientation="vertical" defaultSelectedKey="profile">
            <TabList aria-label="Settings sections">
              <Tab id="profile">Profile</Tab>
              <Tab id="preferences">Preferences</Tab>
            </TabList>
            <TabPanel id="profile">Your name and contact details.</TabPanel>
            <TabPanel id="preferences">Your display and notification preferences.</TabPanel>
          </Tabs>
        </Schemes>
      </Section>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const horizontalList = within(canvas.getAllByRole("tablist", { name: "Project sections" })[0]!);
    const overviewTab = horizontalList.getByRole("tab", { name: "Overview" });
    const activityTab = horizontalList.getByRole("tab", { name: "Activity" });
    await expect(overviewTab.getAttribute("aria-selected")).toBe("true");
    await expect(overviewTab.dataset.selected).toBeDefined();
    await userEvent.click(activityTab);
    await expect(activityTab.getAttribute("aria-selected")).toBe("true");
    await expect(activityTab.dataset.selected).toBeDefined();
    await expect(overviewTab.getAttribute("aria-selected")).toBe("false");

    const verticalList = within(canvas.getAllByRole("tablist", { name: "Settings sections" })[0]!);
    const profileTab = verticalList.getByRole("tab", { name: "Profile" });
    const preferencesTab = verticalList.getByRole("tab", { name: "Preferences" });
    await expect(profileTab.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(preferencesTab);
    await expect(preferencesTab.getAttribute("aria-selected")).toBe("true");
    await expect(preferencesTab.dataset.selected).toBeDefined();
    await expect(profileTab.getAttribute("aria-selected")).toBe("false");
  },
};
