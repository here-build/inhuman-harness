import { useEffect, useRef, type ReactNode, type RefAttributes } from "react";
import {
  Dialog,
  Heading,
  Text,
  composeRenderProps,
  type DatePickerProps,
  type DateRangePickerProps,
  type DateValue,
  type ValidationResult,
} from "react-aria-components";

import { NativePopover } from "./anchored.js";
import {
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker,
  DateRangePicker,
  DateSegment,
  RangeCalendar,
} from "./date-controls.js";
import { Description, FieldButton, FieldError, Group, Label } from "./form-controls.js";
import { cn } from "../../lib/cn.js";

interface FieldContent {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode | ((validation: ValidationResult) => ReactNode);
}

export interface LabeledDatePickerProps<T extends DateValue>
  extends Omit<DatePickerProps<T>, "children">, FieldContent {}

export interface LabeledDateRangePickerProps<T extends DateValue>
  extends Omit<DateRangePickerProps<T>, "children">, FieldContent {}

function Segments({ slot }: { slot?: "start" | "end" }) {
  return <DateInput slot={slot}>{(segment) => <DateSegment segment={segment} />}</DateInput>;
}

function CalendarDialog({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Run after Dialog's own mount autofocus, which can otherwise take focus
    // from the calendar in a native popover. RAC chooses the tabbable date.
    ref.current
      ?.querySelector<HTMLElement>('[role="grid"] [role="button"][tabindex="0"]')
      ?.focus({ preventScroll: true });
  }, []);
  return (
    <Dialog ref={ref} className="font-sans text-sm text-ink outline-none [font-variant-caps:normal]">
      {children}
    </Dialog>
  );
}

function CalendarContents() {
  return (
    <>
      <header className="mb-2 flex items-center justify-between gap-3">
        <FieldButton slot="previous" aria-label="Previous month">
          ‹
        </FieldButton>
        <Heading className="font-heading text-base" />
        <FieldButton slot="next" aria-label="Next month">
          ›
        </FieldButton>
      </header>
      <CalendarGrid weekdayStyle="short">
        <CalendarGridHeader>{(day) => <CalendarHeaderCell>{day}</CalendarHeaderCell>}</CalendarGridHeader>
        <CalendarGridBody>{(day) => <CalendarCell date={day} />}</CalendarGridBody>
      </CalendarGrid>
      <Text slot="errorMessage" className="text-xs text-danger" />
    </>
  );
}

// The roots retain RAC's generic date values, validation and field contexts.
// NativePopover consumes their popover/overlay state, not a second trigger.
export function LabeledDatePicker<T extends DateValue>({
  label,
  description,
  errorMessage,
  className,
  ...props
}: LabeledDatePickerProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <DatePicker {...props} className={composeRenderProps(className, (value) => cn("gp-anchored-field", value))}>
      <Label>{label}</Label>
      <Group>
        <Segments />
        <FieldButton>Calendar</FieldButton>
      </Group>
      {description != null && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
      <NativePopover>
        <CalendarDialog>
          <Calendar autoFocus>
            <CalendarContents />
          </Calendar>
        </CalendarDialog>
      </NativePopover>
    </DatePicker>
  );
}

export function LabeledDateRangePicker<T extends DateValue>({
  label,
  description,
  errorMessage,
  className,
  ...props
}: LabeledDateRangePickerProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <DateRangePicker {...props} className={composeRenderProps(className, (value) => cn("gp-anchored-field", value))}>
      <Label>{label}</Label>
      <Group>
        <Segments slot="start" />
        <span aria-hidden="true">–</span>
        <Segments slot="end" />
        <FieldButton>Calendar</FieldButton>
      </Group>
      {description != null && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
      <NativePopover>
        <CalendarDialog>
          <RangeCalendar autoFocus>
            <CalendarContents />
          </RangeCalendar>
        </CalendarDialog>
      </NativePopover>
    </DateRangePicker>
  );
}
