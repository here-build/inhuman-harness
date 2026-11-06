// @vitest-environment happy-dom
import { act, createElement as h, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CalendarDate, CalendarDateTime, toZoned } from "@internationalized/date";
import { I18nProvider } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LabeledDatePicker, LabeledDateRangePicker } from "../anchored-dates.js";

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
  // happy-dom fires selectionchange synchronously inside collapse, unlike a
  // browser. Native-validation focus would recurse through RAC's segment guard.
  // Keep the same local selection shim as the segmented date-field suite.
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
function trigger() {
  return within(container).getByRole("button", { name: /Calendar/ });
}
function describedText(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

// happy-dom exercises NativePopover's local fallback, not native top-layer CSS.
describe("anchored date pickers", () => {
  it("opens by mouse, selects a date, closes and returns focus", async () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLDivElement>();
    await render(
      h(LabeledDatePicker<CalendarDate>, {
        label: "Review date",
        description: "When to review.",
        defaultValue: date,
        onChange,
        ref,
        className: ({ isOpen }) => (isOpen ? "calendar-open" : "calendar-closed"),
      }),
    );
    expect(ref.current?.classList.contains("gp-anchored-field")).toBe(true);
    expect(describedText(within(container).getByRole("spinbutton", { name: /month/ }))).toContain("When to review.");
    await interact(() => user.click(trigger()));
    expect(ref.current?.classList.contains("calendar-open")).toBe(true);
    const dialog = within(container).getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    await interact(() => user.click(within(dialog).getByRole("button", { name: /Thursday, October 22, 2026/ })));
    expect(onChange.mock.calls[0]?.[0].toString()).toBe("2026-10-22");
    expect(within(container).queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it.each(["{Enter}", " "])("opens with %s and supports calendar keyboard selection", async (key) => {
    const onChange = vi.fn();
    await render(h(LabeledDatePicker<CalendarDate>, { label: "Review date", defaultValue: date, onChange }));
    await interact(() => trigger().focus());
    await interact(() => user.keyboard(key));
    expect(within(container).getByRole("dialog")).toBeTruthy();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(container).getByRole("button", { name: /Thursday, October 15, 2026/ }),
      ),
    );
    await interact(() => user.keyboard("{ArrowRight}{Enter}"));
    expect(onChange.mock.calls[0]?.[0].toString()).toBe("2026-10-16");
    expect(within(container).queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it.each(["date", "range"] as const)(
    "dismisses the %s picker with Escape or an outside press without changing the value",
    async (kind) => {
      const onChange = vi.fn();
      await render(
        h(
          "div",
          null,
          kind === "date"
            ? h(LabeledDatePicker<CalendarDate>, { label: "Review date", defaultValue: date, onChange })
            : h(LabeledDateRangePicker<CalendarDate>, {
                label: "Release window",
                defaultValue: { start: date, end: date.add({ days: 3 }) },
                onChange,
              }),
          h("p", null, "Outside calendar"),
        ),
      );
      for (const dismiss of [
        () => user.keyboard("{Escape}"),
        () => user.click(within(container).getByText("Outside calendar")),
      ]) {
        await interact(() => user.click(trigger()));
        expect(within(container).getByRole("dialog")).toBeTruthy();
        await interact(dismiss);
        expect(within(container).queryByRole("dialog")).toBeNull();
        await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
      }
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("chooses both range endpoints before closing", async () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLDivElement>();
    await render(
      h(LabeledDateRangePicker<CalendarDate>, {
        label: "Release window",
        defaultValue: { start: date, end: date.add({ days: 3 }) },
        onChange,
        ref,
        className: ({ isOpen }) => (isOpen ? "range-open" : "range-closed"),
      }),
    );
    expect(ref.current?.classList.contains("gp-anchored-field")).toBe(true);
    expect(ref.current?.classList.contains("range-closed")).toBe(true);
    await interact(() => user.click(trigger()));
    expect(ref.current?.classList.contains("range-open")).toBe(true);
    await interact(() => user.click(within(container).getByRole("button", { name: /Tuesday, October 20, 2026/ })));
    expect(within(container).getByRole("dialog")).toBeTruthy();
    await interact(() => user.click(within(container).getByRole("button", { name: /Friday, October 23, 2026/ })));
    expect(onChange.mock.calls[0]?.[0].start.toString()).toBe("2026-10-20");
    expect(onChange.mock.calls[0]?.[0].end.toString()).toBe("2026-10-23");
    expect(within(container).queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it.each(["{Enter}", " "])("opens a range with %s and selects both endpoints by keyboard", async (key) => {
    const onChange = vi.fn();
    await render(
      h(LabeledDateRangePicker<CalendarDate>, {
        label: "Release window",
        defaultValue: { start: date, end: date.add({ days: 3 }) },
        onChange,
      }),
    );
    await interact(() => trigger().focus());
    await interact(() => user.keyboard(key));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(container).getByRole("button", { name: /Thursday, October 15, 2026/ }),
      ),
    );
    await interact(() => user.keyboard("{ArrowRight}{Enter}"));
    expect(within(container).getByRole("dialog")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    // RAC advances to the following day after anchoring a range.
    expect(document.activeElement?.getAttribute("aria-label")).toMatch(/Saturday, October 17, 2026/);
    await interact(() => user.keyboard("{ArrowRight}{Enter}"));
    expect(onChange.mock.calls[0]?.[0].start.toString()).toBe("2026-10-16");
    expect(onChange.mock.calls[0]?.[0].end.toString()).toBe("2026-10-18");
    expect(within(container).queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger()));
  });

  it("submits changed date/range values and resets to defaults", async () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      return Object.fromEntries(new FormData(event.currentTarget));
    });
    await render(
      h(
        "form",
        { onSubmit },
        h(LabeledDatePicker<CalendarDate>, { label: "Review", name: "review", defaultValue: date }),
        h(LabeledDateRangePicker<CalendarDate>, {
          label: "Release",
          startName: "start",
          endName: "end",
          defaultValue: { start: date, end: date.add({ days: 3 }) },
        }),
        h("button", { type: "submit" }, "Save"),
        h("button", { type: "reset" }, "Reset"),
      ),
    );
    const triggers = within(container).getAllByRole("button", { name: /Calendar/ });
    await interact(() => user.click(triggers[0]!));
    await interact(() => user.click(within(container).getByRole("button", { name: /Thursday, October 22, 2026/ })));
    await interact(() => user.click(triggers[1]!));
    await interact(() => user.click(within(container).getByRole("button", { name: /Tuesday, October 20, 2026/ })));
    await interact(() => user.click(within(container).getByRole("button", { name: /Friday, October 23, 2026/ })));
    await interact(() => user.click(within(container).getByRole("button", { name: "Save" })));
    expect(onSubmit.mock.results[0]?.value).toEqual({ review: "2026-10-22", start: "2026-10-20", end: "2026-10-23" });
    await interact(() => user.click(within(container).getByRole("button", { name: "Reset" })));
    expect(Object.fromEntries(new FormData(container.querySelector("form")!))).toEqual({
      review: "2026-10-15",
      start: "2026-10-15",
      end: "2026-10-18",
    });
    await interact(() => user.click(triggers[0]!));
    expect(
      Object.hasOwn(within(container).getByRole("button", { name: /Thursday, October 15, 2026/ }).dataset, "selected"),
    ).toBe(true);
  });

  it("preserves named date/range values and external form association", async () => {
    await render(
      h(
        "div",
        null,
        h("form", { id: "dates" }),
        h(LabeledDatePicker<CalendarDate>, {
          label: "Review",
          name: "review",
          form: "dates",
          defaultValue: date,
          isRequired: true,
        }),
        h(LabeledDateRangePicker<CalendarDate>, {
          label: "Release",
          startName: "start",
          endName: "end",
          form: "dates",
          defaultValue: { start: date, end: date.add({ days: 3 }) },
          isRequired: true,
        }),
      ),
    );
    const form = container.querySelector("form")!;
    expect(Object.fromEntries(new FormData(form))).toEqual({
      review: "2026-10-15",
      start: "2026-10-15",
      end: "2026-10-18",
    });
  });

  it.each(["date", "range"] as const)(
    "reports native required validation and associates the %s error",
    async (kind) => {
      const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
      await render(
        h(
          "form",
          { onSubmit },
          kind === "date"
            ? h(LabeledDatePicker<CalendarDate>, {
                label: "Required date",
                name: "date",
                isRequired: true,
                errorMessage: "Choose a review date.",
              })
            : h(LabeledDateRangePicker<CalendarDate>, {
                label: "Required range",
                startName: "start",
                endName: "end",
                isRequired: true,
                errorMessage: ({ validationDetails }) =>
                  validationDetails.valueMissing ? "Choose a review date." : "Invalid range.",
              }),
          h("button", { type: "submit" }, "Save"),
        ),
      );
      await interact(() => user.click(within(container).getByRole("button", { name: "Save" })));
      expect(onSubmit).not.toHaveBeenCalled();
      expect(within(container).getByText("Choose a review date.")).toBeTruthy();
      const segment = within(container).getAllByRole("spinbutton", { name: /month/ })[0]!;
      expect(segment.getAttribute("aria-invalid")).toBe("true");
      expect(describedText(segment)).toContain("Choose a review date.");
    },
  );

  it.each(["date", "range"] as const)("does not open or submit populated disabled %s controls", async (kind) => {
    const onChange = vi.fn();
    await render(
      h(
        "form",
        null,
        kind === "date"
          ? h(LabeledDatePicker<CalendarDate>, {
              label: "Unavailable",
              name: "date",
              defaultValue: date,
              isDisabled: true,
              onChange,
            })
          : h(LabeledDateRangePicker<CalendarDate>, {
              label: "Unavailable",
              startName: "start",
              endName: "end",
              defaultValue: { start: date, end: date.add({ days: 3 }) },
              isDisabled: true,
              onChange,
            }),
      ),
    );
    expect((trigger() as HTMLButtonElement).disabled).toBe(true);
    await interact(() => user.click(trigger()));
    await interact(() => user.keyboard("{Enter}"));
    expect(within(container).queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect([...new FormData(container.querySelector("form")!)]).toEqual([]);
  });

  it("keeps generic date-time and zoned values rather than converting to strings", async () => {
    const value = toZoned(new CalendarDateTime(2026, 10, 15, 9, 30), "America/New_York");
    const onChange = vi.fn();
    await render(h(LabeledDatePicker<typeof value>, { label: "Meeting", defaultValue: value, onChange }));
    await interact(() => user.click(trigger()));
    await interact(() => user.click(within(container).getByRole("button", { name: /Friday, October 16, 2026/ })));
    const next = onChange.mock.calls[0]?.[0];
    expect(next.timeZone).toBe("America/New_York");
    expect(next.hour).toBe(9);
    expect(next.minute).toBe(30);
    expect(next.day).toBe(16);
  });
});
