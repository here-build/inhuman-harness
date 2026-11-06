import type { Meta, StoryObj } from "@storybook/react-vite";
import { FieldError, Label, Text } from "react-aria-components";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  CheckboxField,
  CheckboxButton,
  RadioField,
  RadioButton,
  SwitchField,
  SwitchButton,
} from "../components/ui/choice-fields.js";
import { RadioGroup } from "../components/ui/radio-group.js";

const meta = { title: "Graphic Precision/Choice fields", parameters: { layout: "fullscreen" } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const FieldsAndDescriptions: Story = {
  render: () => (
    <Page
      historical={false}
      title="Choice fields"
      lede="A field owns validation and supporting information; its button owns the click target. Labels are content, not commands."
    >
      <Section
        title="Persistent context"
        note="Use Tab and Space to change a value. Descriptions remain associated with the corresponding field."
      >
        <Schemes>
          <div className="flex flex-col gap-6">
            <CheckboxField defaultSelected>
              <CheckboxButton>
                <Label>Keep local drafts</Label>
              </CheckboxButton>
              <Text slot="description" className="pl-6 text-xs text-muted">
                Drafts stay on this device until you send them.
              </Text>
              <FieldError className="text-xs text-danger" />
            </CheckboxField>
            <SwitchField defaultSelected>
              <SwitchButton>
                <Label>Show completed tasks</Label>
              </SwitchButton>
              <Text slot="description" className="text-xs text-muted">
                Completed tasks remain available in the current view.
              </Text>
            </SwitchField>
            <RadioGroup label="Save location" defaultValue="device">
              <RadioField value="device">
                <RadioButton>
                  <Label>This device</Label>
                </RadioButton>
                <Text slot="description" className="pl-6 text-xs text-muted">
                  Available while you work offline.
                </Text>
              </RadioField>
              <RadioField value="team">
                <RadioButton>
                  <Label>Team workspace</Label>
                </RadioButton>
                <Text slot="description" className="pl-6 text-xs text-muted">
                  Visible to people with workspace access.
                </Text>
              </RadioField>
            </RadioGroup>
            <CheckboxField isInvalid validationBehavior="aria">
              <CheckboxButton>
                <Label>Confirm deletion</Label>
              </CheckboxButton>
              <FieldError className="text-xs text-danger">Confirm that you want to delete this project.</FieldError>
            </CheckboxField>
            <SwitchField isDisabled>
              <SwitchButton>
                <Label>Workspace sync</Label>
              </SwitchButton>
              <Text slot="description" className="text-xs text-muted">
                Connect a workspace to enable sync.
              </Text>
            </SwitchField>
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};
