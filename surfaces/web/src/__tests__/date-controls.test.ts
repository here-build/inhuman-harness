// @vitest-environment happy-dom

import { act, createElement as h, createRef, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarDate, Time } from "@internationalized/date";
import { Button, FieldError, Group, Heading, I18nProvider, Label, Text } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
const date = new CalendarDate(2026, 10, 15);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
  // happy-dom dispatches selectionchange synchronously on collapse, unlike the
  // browser. RAC's segment selection guard would recursively collapse forever.
  vi.spyOn(window.getSelection()!, "collapse").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(h(I18nProvider, { locale: "en-US", children: node })));
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function segments(slot?: "start" | "end") {
  return h(DateInput, { slot, children: (segment) => h(DateSegment, { segment }) });
}

function calendarContents() {
  return h(
    Fragment,
    null,
    h(
      "header",
      null,
      h(Button, { slot: "previous", "aria-label": "Previous month" }, "Previous month"),
      h(Heading),
      h(Button, { slot: "next", "aria-label": "Next month" }, "Next month"),
    ),
    h(
      CalendarGrid,
      { weekdayStyle: "short" },
      h(CalendarGridHeader, { children: (day) => h(CalendarHeaderCell, null, day) }),
      h(CalendarGridBody, { children: (day) => h(CalendarCell, { date: day }) }),
    ),
  );
}

function describedText(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

describe("segmented date and time fields", () => {
  it("associates natural labels, help, and validation errors with the date input", async () => {
    await render(
      h(
        DateField,
        { defaultValue: date, isInvalid: true, validationBehavior: "aria" },
        h(Label, null, "Review date"),
        segments(),
        h(Text, { slot: "description" }, "Choose a date after the review."),
        h(FieldError, null, "This date is too early."),
      ),
    );
    const group = within(container).getByRole("group", { name: "Review date" });
    expect(describedText(group)).toContain("Choose a date after the review.");
    expect(describedText(group)).toContain("This date is too early.");
    const day = within(container).getByRole("spinbutton", { name: /day/i });
    expect(day.getAttribute("aria-invalid")).toBe("true");
    expect(day.className).toContain("font-sans");
    expect(day.className).not.toContain("font-mono");
  });

  it("moves between segments and increments date parts with the keyboard", async () => {
    const onChange = vi.fn();
    await render(
      h(DateField<CalendarDate>, { defaultValue: date, onChange }, h(Label, null, "Review date"), segments()),
    );
    const month = within(container).getByRole("spinbutton", { name: /month/i });
    await interact(() => month.focus());
    await interact(() => user.keyboard("{ArrowUp}{ArrowRight}{ArrowUp}"));
    expect(document.activeElement).toBe(within(container).getByRole("spinbutton", { name: /day/i }));
    expect(onChange.mock.lastCall?.[0].toString()).toBe("2026-11-16");
  });

  it("accepts numeric segment editing and serializes an ordinary date in a form", async () => {
    const onChange = vi.fn();
    await render(
      h(
        "form",
        null,
        h(
          DateField<CalendarDate>,
          { name: "review", defaultValue: date, onChange },
          h(Label, null, "Review date"),
          segments(),
        ),
      ),
    );
    const day = within(container).getByRole("spinbutton", { name: /day/i });
    await interact(() => day.focus());
    // user-event does not synthesize beforeinput for happy-dom contenteditables.
    // RAC consumes the browser's native beforeinput event for numeric entry.
    for (const digit of ["2", "1"]) {
      await interact(() =>
        day.dispatchEvent(
          new InputEvent("beforeinput", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: digit,
          }),
        ),
      );
    }
    expect(onChange.mock.lastCall?.[0].toString()).toBe("2026-10-21");
    expect(new FormData(container.querySelector("form")!).get("review")).toBe("2026-10-21");
  });

  it("edits hours and minutes independently", async () => {
    const onChange = vi.fn();
    await render(
      h(
        TimeField<Time>,
        { defaultValue: new Time(9, 30), hourCycle: 24, onChange },
        h(Label, null, "Start time"),
        segments(),
      ),
    );
    const hour = within(container).getByRole("spinbutton", { name: /hour/i });
    await interact(() => hour.focus());
    await interact(() => user.keyboard("{ArrowUp}{ArrowRight}{ArrowDown}"));
    expect(onChange.mock.lastCall?.[0].toString()).toBe("10:29:00");
    expect(document.activeElement).toBe(within(container).getByRole("spinbutton", { name: /minute/i }));
  });

  it("keeps read-only date values unchanged during keyboard editing", async () => {
    const onChange = vi.fn();
    await render(
      h(
        DateField<CalendarDate>,
        { defaultValue: date, isReadOnly: true, onChange },
        h(Label, null, "Published date"),
        segments(),
      ),
    );
    const day = within(container).getByRole("spinbutton", { name: /day/i });
    expect(day.getAttribute("aria-readonly")).toBe("true");
    await interact(() => day.focus());
    await interact(() => user.keyboard("{ArrowUp}21"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips disabled date and time segments in the tab order", async () => {
    const onChange = vi.fn();
    await render(
      h(
        Fragment,
        null,
        h(
          DateField<CalendarDate>,
          { defaultValue: date, isDisabled: true, onChange },
          h(Label, null, "Archived date"),
          segments(),
        ),
        h(
          TimeField<Time>,
          { defaultValue: new Time(9), isDisabled: true, onChange },
          h(Label, null, "Archived time"),
          segments(),
        ),
        h("button", null, "Continue"),
      ),
    );
    for (const segment of within(container).getAllByRole("spinbutton")) {
      expect(segment.getAttribute("aria-disabled")).toBe("true");
      expect(segment.tabIndex).toBe(-1);
    }
    await interact(() => user.tab());
    expect(document.activeElement).toBe(within(container).getByRole("button", { name: "Continue" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("preserves typed values, root refs, and caller render-prop classes", async () => {
    const ref = createRef<HTMLDivElement>();
    await render(
      h(
        DateField<CalendarDate>,
        {
          ref,
          defaultValue: date,
          isReadOnly: true,
          className: ({ isReadOnly }) => (isReadOnly ? "caller-readonly" : ""),
        },
        h(Label, null, "Published date"),
        segments(),
      ),
    );
    expect(ref.current?.className).toContain("caller-readonly");
    expect(ref.current?.className).toContain("font-sans");
    expect(ref.current?.dataset.readonly).toBeDefined();
  });
});

describe("inline calendars", () => {
  it("selects a date using arrow keys and Enter", async () => {
    const onChange = vi.fn();
    await render(
      h(Calendar<CalendarDate>, { "aria-label": "Review date", defaultValue: date, onChange }, calendarContents()),
    );
    const selected = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]')!;
    expect(selected).not.toBeNull();
    await interact(() => selected.focus());
    await interact(() => user.keyboard("{ArrowRight}{Enter}"));
    expect(onChange.mock.lastCall?.[0].toString()).toBe("2026-10-16");
    expect(within(container).getByRole("grid")).toBeTruthy();
    // RAC hides duplicate weekday headings; full weekday names are on cells.
    expect(within(container).getAllByRole("columnheader", { hidden: true })).toHaveLength(7);
  });

  it("navigates months with the previous and next slots", async () => {
    await render(h(Calendar, { "aria-label": "Review date", defaultValue: date }, calendarContents()));
    await interact(() => user.click(within(container).getByRole("button", { name: "Next month" })));
    expect(within(container).getByRole("heading").textContent).toContain("November 2026");
    await interact(() => user.click(within(container).getByRole("button", { name: "Previous month" })));
    expect(within(container).getByRole("heading").textContent).toContain("October 2026");
  });

  it("selects both endpoints of a range with the keyboard", async () => {
    const onChange = vi.fn();
    await render(
      h(
        RangeCalendar<CalendarDate>,
        { "aria-label": "Release window", defaultFocusedValue: date, onChange },
        calendarContents(),
      ),
    );
    const focused = container.querySelector<HTMLElement>('[role="button"][tabindex="0"]')!;
    await interact(() => focused.focus());
    await interact(() => user.keyboard("{Enter}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}"));
    const range = onChange.mock.lastCall?.[0];
    expect(range.start.toString()).toBe("2026-10-15");
    expect(range.end.toString()).toBe("2026-10-18");
    expect(container.querySelectorAll("[data-selected]")).toHaveLength(4);
  });

  it("does not select unavailable or disabled dates", async () => {
    const onChange = vi.fn();
    await render(
      h(
        Calendar<CalendarDate>,
        {
          "aria-label": "Review date",
          defaultValue: date,
          onChange,
          isDateUnavailable: (value) => value.day === 16,
        },
        calendarContents(),
      ),
    );
    const unavailable = container.querySelector<HTMLElement>("[data-unavailable]")!;
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    await interact(() => user.click(unavailable));
    expect(onChange).not.toHaveBeenCalled();
    await render(
      h(
        Calendar<CalendarDate>,
        { "aria-label": "Review date", defaultValue: date, isDisabled: true, onChange },
        calendarContents(),
      ),
    );
    expect(container.querySelector('[role="button"][tabindex="0"]')).toBeNull();
    expect(within(container).getByRole("button", { name: "Next month" }).hasAttribute("disabled")).toBe(true);
    const cell = container.querySelector<HTMLElement>("[data-disabled][data-selected]")!;
    await interact(() => user.click(cell));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("non-positioning picker roots", () => {
  it("provides the default date input context without rendering a floating picker", async () => {
    const onChange = vi.fn();
    await render(
      h(
        DatePicker<CalendarDate>,
        { defaultValue: date, onChange },
        h(Label, null, "Review date"),
        h(Group, null, segments()),
        h(Text, { slot: "description" }, "Edit the review date."),
      ),
    );
    const day = within(container).getByRole("spinbutton", { name: /day/i });
    await interact(() => day.focus());
    await interact(() => user.keyboard("{ArrowUp}"));
    expect(onChange.mock.lastCall?.[0].toString()).toBe("2026-10-16");
    expect(within(container).getByRole("group", { name: "Review date" })).toBeTruthy();
    expect(container.querySelector('[popover], [role="dialog"], [role="grid"]')).toBeNull();
  });

  it("provides independently editable start/end slots and preserves range values", async () => {
    const onChange = vi.fn();
    await render(
      h(
        DateRangePicker<CalendarDate>,
        { defaultValue: { start: date, end: date.add({ days: 3 }) }, onChange },
        h(Label, null, "Release window"),
        h(Group, null, segments("start"), h("span", { "aria-hidden": true }, "–"), segments("end")),
      ),
    );
    const days = within(container).getAllByRole("spinbutton", { name: /day/i });
    expect(days).toHaveLength(2);
    await interact(() => days[1]!.focus());
    await interact(() => user.keyboard("{ArrowUp}"));
    expect(onChange.mock.lastCall?.[0].start.toString()).toBe("2026-10-15");
    expect(onChange.mock.lastCall?.[0].end.toString()).toBe("2026-10-19");
    await interact(() => days[0]!.focus());
    await interact(() => user.keyboard("{ArrowUp}"));
    expect(onChange.mock.lastCall?.[0].start.toString()).toBe("2026-10-16");
    expect(onChange.mock.lastCall?.[0].end.toString()).toBe("2026-10-19");
    expect(within(container).getByRole("group", { name: "Release window" })).toBeTruthy();
    expect(container.querySelector('[popover], [role="dialog"], [role="grid"]')).toBeNull();
  });
});
