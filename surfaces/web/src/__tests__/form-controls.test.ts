// @vitest-environment happy-dom

import { act, createElement as h, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseColor } from "react-aria-components";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "../components/ui/checkbox.js";
import {
  CheckboxGroup,
  ColorArea,
  ColorField,
  ColorSlider,
  ColorSliderTrack,
  ColorSwatch,
  ColorSwatchPicker,
  ColorSwatchPickerItem,
  ColorThumb,
  ColorWheel,
  ColorWheelTrack,
  Description,
  FieldButton,
  FieldError,
  FieldInput,
  Form,
  Group,
  Label,
  Meter,
  NumberField,
  ProgressBar,
  SearchField,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  ToggleButton,
  ToggleButtonGroup,
} from "../components/ui/form-controls.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

function get<T extends Element = HTMLElement>(selector: string): T {
  const element = host.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element!;
}

async function key(element: HTMLElement, value: string) {
  await act(async () => {
    element.focus();
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        code: value === " " ? "Space" : value,
        bubbles: true,
        cancelable: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: value,
        code: value === " " ? "Space" : value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function change(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function describedText(input: Element) {
  return input
    .getAttribute("aria-describedby")
    ?.split(" ")
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent)
    .join(" ");
}

describe("Graphic Precision form controls", () => {
  it("connects a natural field label, description, and server error without losing the value or refs", async () => {
    const ref = createRef<HTMLInputElement>();
    await render(
      h(
        Form,
        { validationErrors: { query: "Use at least three characters." } },
        h(
          SearchField,
          { name: "query", defaultValue: "ab" },
          h(Label, null, "Search documents"),
          h(FieldInput, { ref }),
          h(Description, null, "Search by title."),
          h(FieldError),
        ),
      ),
    );

    const input = get<HTMLInputElement>("input");
    expect(ref.current).toBe(input);
    expect(input.value).toBe("ab");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(get<HTMLLabelElement>("label").htmlFor).toBe(input.id);
    expect(describedText(input)).toContain("Search by title.");
    expect(describedText(input)).toContain("Use at least three characters.");
    expect(get("label").className).not.toMatch(/\blabel\b/);
  });

  it("clears controlled search through Escape and the clear command", async () => {
    const changed = vi.fn();
    function Search() {
      const [value, setValue] = useState("release");
      return h(
        SearchField,
        {
          value,
          onChange: (next) => {
            changed(next);
            setValue(next);
          },
        },
        h(Label, null, "Search"),
        h(Group, null, h(FieldInput), h(FieldButton, null, "Clear")),
      );
    }
    await render(h(Search));
    const input = get<HTMLInputElement>("input");
    await key(input, "Escape");
    expect(input.value).toBe("");
    expect(changed).toHaveBeenLastCalledWith("");
    await change(input, "notes");
    expect(input.value).toBe("notes");
    await act(async () => get<HTMLButtonElement>("button").click());
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("adjusts a number with arrows and step buttons and respects limits", async () => {
    const changed = vi.fn();
    await render(
      h(
        NumberField,
        { defaultValue: 2, minValue: 1, maxValue: 3, onChange: changed },
        h(Label, null, "Copies"),
        h(
          Group,
          null,
          h(FieldButton, { slot: "decrement" }, "Decrease"),
          h(FieldInput),
          h(FieldButton, { slot: "increment" }, "Increase"),
        ),
      ),
    );
    const input = get<HTMLInputElement>("input");
    await key(input, "ArrowUp");
    expect(input.value).toBe("3");
    expect(changed).toHaveBeenLastCalledWith(3);
    expect(get<HTMLButtonElement>('button[slot="increment"]').disabled).toBe(true);
    await key(input, "ArrowUp");
    expect(input.value).toBe("3");
    await act(async () => get<HTMLButtonElement>('button[slot="decrement"]').click());
    expect(input.value).toBe("2");
    await key(input, "ArrowDown");
    expect(input.value).toBe("1");
    expect(get<HTMLButtonElement>('button[slot="decrement"]').disabled).toBe(true);
  });

  it("keeps number inputs and commands unavailable while disabled", async () => {
    const changed = vi.fn();
    await render(
      h(
        NumberField,
        { isDisabled: true, defaultValue: 4, onChange: changed },
        h(Label, null, "Copies"),
        h(FieldInput),
        h(FieldButton, { slot: "increment" }, "Increase"),
      ),
    );
    expect(get<HTMLInputElement>("input").disabled).toBe(true);
    const button = get<HTMLButtonElement>("button");
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(changed).not.toHaveBeenCalled();
    expect(get("[data-disabled]")).toBeTruthy();
  });

  it("exposes named range thumbs and updates output with keyboard steps and endpoints", async () => {
    const changed = vi.fn();
    await render(
      h(
        Slider,
        { defaultValue: 20, minValue: 0, maxValue: 100, step: 5, onChange: changed },
        h(Label, null, "Completion"),
        h(SliderOutput),
        h(SliderTrack, null, h(SliderThumb)),
      ),
    );
    const input = get<HTMLInputElement>('input[type="range"]');
    await key(input, "ArrowRight");
    expect(changed).toHaveBeenLastCalledWith(25);
    expect(get("output").textContent).toBe("25");
    await key(input, "End");
    expect(input.value).toBe("100");
    await key(input, "Home");
    expect(input.value).toBe("0");
    expect(input.getAttribute("aria-labelledby")).toContain(get("label").id);
  });

  it("propagates disabled state to every range thumb", async () => {
    await render(
      h(
        Slider,
        { isDisabled: true, defaultValue: [20, 80], "aria-label": "Review window" },
        h(
          SliderTrack,
          null,
          h(SliderThumb, { index: 0, "aria-label": "Start" }),
          h(SliderThumb, { index: 1, "aria-label": "End" }),
        ),
      ),
    );
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="range"]');
    expect(inputs).toHaveLength(2);
    expect([...inputs].every((input) => input.disabled)).toBe(true);
  });

  it("renders semantic meter and determinate/indeterminate progress values", async () => {
    await render(
      h(
        "div",
        null,
        h(Meter, { value: 30, minValue: 10, maxValue: 50 }, h(Label, null, "Storage used")),
        h(ProgressBar, { value: 60 }, h(Label, null, "Export progress")),
        h(ProgressBar, { isIndeterminate: true }, h(Label, null, "Preparing files")),
      ),
    );
    const meter = get('[role="meter"]');
    expect(meter.getAttribute("aria-valuenow")).toBe("30");
    expect(meter.querySelector<HTMLElement>('[aria-hidden="true"] > div')?.style.width).toBe("50%");
    const progress = host.querySelectorAll('[role="progressbar"]');
    expect(progress[0]!.getAttribute("aria-valuenow")).toBe("60");
    expect(progress[1]!.hasAttribute("aria-valuenow")).toBe(false);
    expect(progress[1]!.textContent).toContain("Preparing files");
  });

  it("preserves checkbox group values, descriptions, and disabled items", async () => {
    const changed = vi.fn();
    await render(
      h(
        CheckboxGroup,
        { defaultValue: ["email"], onChange: changed, isInvalid: true, validationBehavior: "aria" },
        h(Label, null, "Delivery channels"),
        h(Checkbox, { value: "email", children: "Email" }),
        h(Checkbox, { value: "inbox", children: "Inbox" }),
        h(Checkbox, { value: "sms", isDisabled: true, children: "Text message" }),
        h(Description, null, "Select a channel."),
        h(FieldError, null, "Choose a connected channel."),
      ),
    );
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(inputs[0]!.checked).toBe(true);
    await act(async () => inputs[1]!.click());
    expect(changed).toHaveBeenLastCalledWith(["email", "inbox"]);
    expect(inputs[2]!.disabled).toBe(true);
    expect(describedText(get('[role="group"]'))).toContain("Choose a connected channel.");
  });

  it("supports keyboard toggle selection and group roving focus without enabling disabled commands", async () => {
    const changed = vi.fn();
    await render(
      h(
        ToggleButtonGroup,
        {
          "aria-label": "Document view",
          selectionMode: "single",
          defaultSelectedKeys: ["list"],
          onSelectionChange: changed,
        },
        h(ToggleButton, { id: "list" }, "List"),
        h(ToggleButton, { id: "grid" }, "Grid"),
        h(ToggleButton, { id: "timeline", isDisabled: true }, "Timeline"),
      ),
    );
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons[0]!.getAttribute("aria-checked")).toBe("true");
    await key(buttons[0]!, "ArrowRight");
    expect(document.activeElement).toBe(buttons[1]);
    await key(buttons[1]!, " ");
    expect(buttons[1]!.getAttribute("aria-checked")).toBe("true");
    expect([...changed.mock.lastCall![0]]).toEqual(["grid"]);
    expect(buttons[2]!.disabled).toBe(true);
    expect(buttons[1]!.className).toContain("label");
    expect(buttons[1]!.className).toContain("var(--focus)");
  });

  it("edits a color channel with the keyboard and exposes disabled color inputs", async () => {
    const changed = vi.fn();
    await render(
      h(
        "div",
        null,
        h(
          ColorSlider,
          { channel: "hue", colorSpace: "hsl", defaultValue: "hsl(210, 70%, 50%)", onChange: changed },
          h(Label, null, "Hue"),
          h(SliderOutput),
          h(ColorSliderTrack, null, h(ColorThumb)),
        ),
        h(
          ColorArea,
          {
            "aria-label": "Category color",
            isDisabled: true,
            defaultValue: "hsl(210, 70%, 50%)",
            colorSpace: "hsl",
            xChannel: "saturation",
            yChannel: "lightness",
          },
          h(ColorThumb),
        ),
        h(
          ColorWheel,
          {
            "aria-label": "Category hue",
            isDisabled: true,
            outerRadius: 96,
            innerRadius: 72,
            defaultValue: "hsl(210, 70%, 50%)",
          },
          h(ColorWheelTrack),
          h(ColorThumb),
        ),
      ),
    );
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="range"]');
    await key(inputs[0]!, "ArrowRight");
    expect(changed.mock.lastCall![0].getChannelValue("hue")).toBe(211);
    expect([...inputs].slice(1).every((input) => input.disabled)).toBe(true);
    expect(inputs.length).toBe(4);
  });

  it("keeps a color field and preview in sync and validates invalid fields", async () => {
    function ColorEditor() {
      const [color, setColor] = useState(parseColor("#267fd9"));
      return h(
        "div",
        null,
        h(
          ColorField,
          {
            value: color,
            onChange: (next) => {
              if (next) setColor(next);
            },
          },
          h(Label, null, "Category color"),
          h(FieldInput),
          h(Description, null, "Enter a hexadecimal color."),
        ),
        h(ColorSwatch, { color, id: "preview" }),
        h(
          ColorField,
          { isInvalid: true, validationBehavior: "aria", defaultValue: "#267fd9" },
          h(Label, null, "Duplicate color"),
          h(FieldInput),
          h(FieldError, null, "Choose a distinct category color."),
        ),
      );
    }
    await render(h(ColorEditor));
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    await change(inputs[0]!, "#9058c8");
    await key(inputs[0]!, "Enter");
    expect(get("#preview").getAttribute("aria-label")).toBe(parseColor("#9058c8").getColorName("en-US"));
    expect(inputs[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(inputs[1]!)).toContain("Choose a distinct category color.");
  });

  it("selects swatch items with the keyboard and skips disabled colors", async () => {
    const changed = vi.fn();
    await render(
      h(
        ColorSwatchPicker,
        { "aria-label": "Suggested colors", defaultValue: "#267fd9", onChange: changed },
        h(ColorSwatchPickerItem, { color: "#267fd9" }),
        h(ColorSwatchPickerItem, { color: "#9058c8", isDisabled: true }),
        h(ColorSwatchPickerItem, { color: "#288263" }),
      ),
    );
    const options = host.querySelectorAll<HTMLElement>('[role="option"]');
    expect(options).toHaveLength(3);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    await key(options[0]!, "ArrowRight");
    expect(document.activeElement).toBe(options[2]);
    await key(options[2]!, "Enter");
    expect(changed.mock.lastCall![0].toString("hex")).toBe("#288263");
    expect(options[1]!.getAttribute("aria-disabled")).toBe("true");
  });
});
