import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Page, Schemes, Section } from "./brand-kit.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { Switch } from "../components/ui/switch.js";
import { Tab, TabList, TabPanel, Tabs } from "../components/ui/tabs.js";
import { TextField } from "../components/ui/text-field.js";

const meta = {
  title: "Graphic Precision/Components",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <Page
      historical={false}
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
      historical={false}
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
      historical={false}
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
      historical={false}
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
};
