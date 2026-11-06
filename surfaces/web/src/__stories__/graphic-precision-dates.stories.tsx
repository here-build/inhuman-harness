import { useState } from "react";
import { CalendarDate, Time } from "@internationalized/date";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, FieldError, Group, Heading, Label, Text } from "react-aria-components";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateField,
  DateInput,
  DatePicker,
  DateRangePicker,
  DateSegment,
  RangeCalendar,
  TimeField,
} from "../components/ui/date-controls.js";

const meta = {
  title: "Graphic Precision/Dates and times",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const date = new CalendarDate(2026, 10, 15);
const navigationClassName =
  "label touch-target rounded-none border border-edge px-2 py-1 text-ink outline-none data-[hovered]:bg-hover data-[focus-visible]:outline-2 data-[focus-visible]:outline-[var(--focus)] data-[disabled]:opacity-50";

function Segments({ slot }: { slot?: "start" | "end" }) {
  return <DateInput slot={slot}>{(segment) => <DateSegment segment={segment} />}</DateInput>;
}

function CalendarContents() {
  return (
    <>
      <header className="mb-2 flex items-center justify-between gap-3">
        <Button slot="previous" aria-label="Previous month" className={navigationClassName}>
          ‹
        </Button>
        <Heading className="font-heading text-base" />
        <Button slot="next" aria-label="Next month" className={navigationClassName}>
          ›
        </Button>
      </header>
      <CalendarGrid weekdayStyle="short">
        <CalendarGridHeader>{(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}</CalendarGridHeader>
        <CalendarGridBody>{(day) => <CalendarCell date={day} />}</CalendarGridBody>
      </CalendarGrid>
      <Text slot="errorMessage" className="text-xs text-danger" />
    </>
  );
}

export const SegmentedFields: Story = {
  render: () => (
    <Page
      historical={false}
      title="Date and time fields"
      lede="Persistent labels and ordinary Source Sans date values. Each segment can be edited without a calendar."
    >
      <Section
        title="Keyboard editing and validation"
        note="Tab into a field, use Left and Right to move between segments, and type or use Up and Down to change a value. Formatting follows your locale."
      >
        <Schemes>
          <FieldExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function FieldExamples() {
  const [value, setValue] = useState<CalendarDate | null>(date);
  return (
    <div className="flex max-w-sm flex-col gap-5">
      <DateField value={value} onChange={setValue}>
        <Label>Review date</Label>
        <Segments />
        <Text slot="description" className="text-xs text-muted">
          Choose when the team should review the release.
        </Text>
      </DateField>
      <p role="status" className="font-sans text-sm tabular-nums">
        Review date: {value?.toString() ?? "Not set"}
      </p>
      <TimeField defaultValue={new Time(9, 30)}>
        <Label>Start time</Label>
        <Segments />
        <Text slot="description" className="text-xs text-muted">
          Local time for the review.
        </Text>
      </TimeField>
      <DateField defaultValue={date} isInvalid validationBehavior="aria">
        <Label>Submission date</Label>
        <Segments />
        <FieldError className="text-xs text-danger">Choose a date after the review.</FieldError>
      </DateField>
      <DateField defaultValue={date} isReadOnly>
        <Label>Published date</Label>
        <Segments />
      </DateField>
      <TimeField defaultValue={new Time(17)} isDisabled>
        <Label>Archive time</Label>
        <Segments />
      </TimeField>
    </div>
  );
}

export const InlineCalendars: Story = {
  render: () => (
    <Page
      historical={false}
      title="Inline calendars"
      lede="Complete date and range selection without any floating layer."
    >
      <Section
        title="Single date and date range"
        note="Arrow keys move by day or week, Page Up and Page Down change months. Enter or Space selects; for a range, select the start and then the end."
      >
        <Schemes>
          <CalendarExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function CalendarExamples() {
  const [value, setValue] = useState<CalendarDate | null>(date);
  const [range, setRange] = useState<{ start: CalendarDate; end: CalendarDate } | null>({
    start: date,
    end: date.add({ days: 3 }),
  });
  return (
    <div className="flex flex-col items-start gap-5">
      <Calendar aria-label="Review date" value={value} onChange={setValue}>
        <CalendarContents />
      </Calendar>
      <p role="status" className="font-sans text-sm tabular-nums">
        Review date: {value?.toString() ?? "Not set"}
      </p>
      <RangeCalendar aria-label="Release window" value={range} onChange={setRange}>
        <CalendarContents />
      </RangeCalendar>
      <p role="status" className="font-sans text-sm tabular-nums">
        Release window: {range ? `${range.start} – ${range.end}` : "Not set"}
      </p>
      <Calendar aria-label="Archived review date" defaultValue={date} isDisabled>
        <CalendarContents />
      </Calendar>
    </div>
  );
}

export const PickerRootBoundary: Story = {
  render: () => (
    <Page
      historical={false}
      title="Picker roots: adapter boundary"
      lede="These are non-positioning React Aria roots and editable input slots, not complete floating pickers."
    >
      <Section
        title="Field contexts only"
        note="No calendar-opening button is offered here. A future native Popover API + CSS anchor adapter must supply the trigger, dialog semantics, dismissal, focus return, and synchronization with the root's open state. React Aria does not own placement. Use the inline calendars for complete selection today."
      >
        <Schemes>
          <div className="flex max-w-lg flex-col gap-5">
            <DatePicker defaultValue={date}>
              <Label>Review date</Label>
              <Group>
                <Segments />
              </Group>
              <Text slot="description" className="text-xs text-muted">
                Edit the date directly with the keyboard.
              </Text>
            </DatePicker>
            <DateRangePicker defaultValue={{ start: date, end: date.add({ days: 3 }) }}>
              <Label>Release window</Label>
              <Group className="flex flex-wrap items-center gap-2">
                <Segments slot="start" />
                <span aria-hidden="true">–</span>
                <Segments slot="end" />
              </Group>
              <Text slot="description" className="text-xs text-muted">
                Edit the start and end dates independently.
              </Text>
            </DateRangePicker>
          </div>
        </Schemes>
      </Section>
    </Page>
  ),
};
