import { forwardRef, type RefAttributes } from "react";
import {
  Calendar as AriaCalendar,
  CalendarCell as AriaCalendarCell,
  CalendarGrid as AriaCalendarGrid,
  CalendarGridBody as AriaCalendarGridBody,
  CalendarGridHeader as AriaCalendarGridHeader,
  CalendarHeaderCell as AriaCalendarHeaderCell,
  DateField as AriaDateField,
  DateInput as AriaDateInput,
  DatePicker as AriaDatePicker,
  DateRangePicker as AriaDateRangePicker,
  DateSegment as AriaDateSegment,
  RangeCalendar as AriaRangeCalendar,
  TimeField as AriaTimeField,
  composeRenderProps,
  type CalendarCellProps,
  type CalendarGridBodyProps,
  type CalendarGridHeaderProps,
  type CalendarGridProps,
  type CalendarHeaderCellProps,
  type CalendarProps,
  type DateFieldProps,
  type DateInputProps,
  type DatePickerProps,
  type DateRangePickerProps,
  type DateSegmentProps,
  type DateValue,
  type RangeCalendarProps,
  type TimeFieldProps,
  type TimeValue,
} from "react-aria-components";

import { cn } from "../lib/cn.js";

// Composable roots: supply a RAC Label, DateInput/DateSegment, and optional
// Text slot="description" / FieldError. Dates are ordinary Source Sans values.
const fieldClassName =
  "flex flex-col gap-1 font-sans text-sm text-ink [font-variant-caps:normal] data-[disabled]:opacity-50";
const calendarClassName =
  "w-fit rounded-[var(--radius-sm)] border border-edge bg-field p-3 font-sans text-sm text-ink [font-variant-caps:normal] data-[disabled]:opacity-50";

export function DateField<T extends DateValue>({
  className,
  ...props
}: DateFieldProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaDateField {...props} className={composeRenderProps(className, (value) => cn(fieldClassName, value))} />;
}

export function TimeField<T extends TimeValue>({
  className,
  ...props
}: TimeFieldProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaTimeField {...props} className={composeRenderProps(className, (value) => cn(fieldClassName, value))} />;
}

export const DateInput = forwardRef<HTMLDivElement, DateInputProps>(function DateInputControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDateInput
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex min-h-9 items-center rounded-[var(--radius-sm)] border border-edge bg-field px-3 py-1 font-sans text-sm text-ink tabular-nums [font-variant-caps:normal] data-[invalid]:border-danger data-[disabled]:cursor-not-allowed data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
});

export const DateSegment = forwardRef<HTMLDivElement, DateSegmentProps>(function DateSegmentControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDateSegment
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "rounded-[var(--radius-xs)] px-0.5 font-sans tabular-nums outline-none [font-variant-caps:normal] data-[type=literal]:px-0 data-[placeholder]:text-subtle data-[focused]:bg-selected data-[focused]:outline-solid data-[focused]:outline-2 data-[focused]:outline-[var(--focus)] data-[invalid]:text-danger",
          value,
        ),
      )}
    />
  );
});

export function Calendar<T extends DateValue>({
  className,
  ...props
}: CalendarProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaCalendar {...props} className={composeRenderProps(className, (value) => cn(calendarClassName, value))} />;
}

export function RangeCalendar<T extends DateValue>({
  className,
  ...props
}: RangeCalendarProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaRangeCalendar {...props} className={composeRenderProps(className, (value) => cn(calendarClassName, value))} />
  );
}

export const CalendarGrid = forwardRef<HTMLTableElement, CalendarGridProps>(function CalendarGridControl(
  { className, ...props },
  ref,
) {
  return <AriaCalendarGrid {...props} ref={ref} className={cn("border-collapse", className)} />;
});

export const CalendarGridHeader = forwardRef<HTMLTableSectionElement, CalendarGridHeaderProps>(
  function CalendarGridHeaderControl({ className, ...props }, ref) {
    return <AriaCalendarGridHeader {...props} ref={ref} className={cn("text-muted", className)} />;
  },
);

export const CalendarGridBody = forwardRef<HTMLTableSectionElement, CalendarGridBodyProps>(
  function CalendarGridBodyControl({ className, ...props }, ref) {
    return <AriaCalendarGridBody {...props} ref={ref} className={cn("text-ink", className)} />;
  },
);

export const CalendarHeaderCell = forwardRef<HTMLTableCellElement, CalendarHeaderCellProps>(
  function CalendarHeaderCellControl({ className, ...props }, ref) {
    return (
      <AriaCalendarHeaderCell {...props} ref={ref} className={cn("h-9 font-sans text-xs font-normal", className)} />
    );
  },
);

export const CalendarCell = forwardRef<HTMLTableCellElement, CalendarCellProps>(function CalendarCellControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaCalendarCell
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex size-9 cursor-pointer items-center justify-center rounded-[var(--radius-xs)] border border-transparent font-sans tabular-nums outline-none [font-variant-caps:normal] data-[hovered]:bg-hover data-[selected]:border-[var(--selection-marker)] data-[selected]:bg-selected data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)] data-[outside-month]:text-subtle data-[disabled]:cursor-not-allowed data-[disabled]:text-subtle data-[unavailable]:line-through data-[invalid]:text-danger",
          value,
        ),
      )}
    />
  );
});

// NON-POSITIONING ROOTS ONLY. These preserve RAC's field/calendar contexts and
// render props for a native Popover API adapter. DateInput
// uses the default slot for DatePicker and slot="start"/"end" for ranges.
// No trigger, dialog, focus-return, dismissal, or floating placement is supplied.
// Use Calendar / RangeCalendar inline for a complete calendar interaction today.
export function DatePicker<T extends DateValue>({
  className,
  ...props
}: DatePickerProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaDatePicker {...props} className={composeRenderProps(className, (value) => cn(fieldClassName, value))} />;
}

export function DateRangePicker<T extends DateValue>({
  className,
  ...props
}: DateRangePickerProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaDateRangePicker {...props} className={composeRenderProps(className, (value) => cn(fieldClassName, value))} />
  );
}
