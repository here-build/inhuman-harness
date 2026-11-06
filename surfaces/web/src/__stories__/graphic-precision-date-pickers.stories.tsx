import { useState } from "react";
import { CalendarDate } from "@internationalized/date";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Page, Schemes, Section } from "./brand-kit.js";
import { LabeledDatePicker, LabeledDateRangePicker } from "../components/ui/anchored-dates.js";
import { Button } from "../components/ui/button.js";

const meta = {
  title: "Graphic Precision/Date pickers",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const date = new CalendarDate(2026, 10, 15);
const range = { start: date, end: date.add({ days: 3 }) };

export const DateAndRange: Story = {
  render: () => (
    <Page
      historical={false}
      title="Anchored date pickers"
      lede="Edit date segments directly or choose from a calendar in a native, CSS-anchored popover. React Aria owns date values, keyboard navigation, and form integration."
    >
      <Section
        title="Single date and date range"
        note="Open Calendar with Enter or Space; arrow keys move between days. Enter selects a date; for a range, choose the start and then the end. Escape or a press outside dismisses without committing a new value. Submit to inspect native form values, or reset to restore the defaults."
      >
        <Schemes>
          <PickerForm />
        </Schemes>
      </Section>
    </Page>
  ),
};

function PickerForm() {
  const [submitted, setSubmitted] = useState("No submission yet");
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        setSubmitted(
          `Review: ${values.get("review")}; release: ${values.get("releaseStart")} – ${values.get("releaseEnd")}`,
        );
      }}
      onReset={() => setSubmitted("Defaults restored")}
    >
      <LabeledDatePicker
        label="Review date"
        name="review"
        defaultValue={date}
        description="Choose when the team should review the release."
        isRequired
        errorMessage="Choose a review date."
      />
      <LabeledDateRangePicker
        label="Release window"
        startName="releaseStart"
        endName="releaseEnd"
        defaultValue={range}
        description="Choose the first and last day of the release window."
        isRequired
        errorMessage="Choose both ends of the release window."
      />
      <div className="flex gap-3">
        <Button type="submit">Submit</Button>
        <Button variant="secondary" type="reset">
          Reset
        </Button>
      </div>
      <p role="status" className="text-sm text-muted tabular-nums">
        {submitted}
      </p>
    </form>
  );
}

export const ValidationAndAvailability: Story = {
  render: () => (
    <Page
      historical={false}
      title="Date picker states"
      lede="Persistent labels, associated errors, and disabled controls remain explicit in both themes."
    >
      <Section
        title="Required, invalid, and disabled"
        note="Submit the empty required fields to reveal native validation. Invalid examples use ARIA validation; disabled fields neither open a calendar nor contribute form values."
      >
        <Schemes>
          <form className="flex flex-col gap-5" onSubmit={(event) => event.preventDefault()}>
            <LabeledDatePicker
              label="Required review date"
              name="review"
              isRequired
              description="A review date is required before saving."
              errorMessage="Choose a review date."
            />
            <LabeledDateRangePicker
              label="Required release window"
              startName="releaseStart"
              endName="releaseEnd"
              isRequired
              errorMessage="Choose a complete release window."
            />
            <LabeledDatePicker
              label="Invalid review date"
              defaultValue={date}
              isInvalid
              validationBehavior="aria"
              errorMessage="The review must happen after approval."
            />
            <LabeledDateRangePicker
              label="Invalid release window"
              defaultValue={range}
              isInvalid
              validationBehavior="aria"
              errorMessage="This release window overlaps a freeze."
            />
            <LabeledDatePicker label="Disabled review date" name="disabledReview" defaultValue={date} isDisabled />
            <LabeledDateRangePicker
              label="Disabled release window"
              startName="disabledStart"
              endName="disabledEnd"
              defaultValue={range}
              isDisabled
            />
            <div className="flex gap-3">
              <Button type="submit">Validate</Button>
              <Button variant="secondary" type="reset">
                Reset
              </Button>
            </div>
          </form>
        </Schemes>
      </Section>
    </Page>
  ),
};
