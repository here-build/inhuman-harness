// @vitest-environment happy-dom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Label, Text, FieldError } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

import { CheckboxField, CheckboxButton, RadioField, RadioButton, SwitchField, SwitchButton } from "../choice-fields.js";
import { RadioGroup } from "../radio-group.js";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
function describedText(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

describe("composable choice fields", () => {
  it("associates checkbox description and changes value with Space", async () => {
    const onChange = vi.fn();
    await render(
      h(
        CheckboxField,
        { onChange },
        h(CheckboxButton, null, h(Label, null, "Keep drafts")),
        h(Text, { slot: "description" }, "Saved on this device."),
      ),
    );
    const checkbox = within(container).getByRole("checkbox", { name: "Keep drafts" });
    expect(describedText(checkbox)).toContain("Saved on this device.");
    const user = userEvent.setup({ document });
    await act(async () => {
      await user.tab();
      await user.keyboard(" ");
    });
    expect(onChange).toHaveBeenCalledWith(true);
    expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
  it("exposes switch descriptions and disabled state", async () => {
    const onChange = vi.fn();
    await render(
      h(
        SwitchField,
        { isDisabled: true, onChange },
        h(SwitchButton, null, h(Label, null, "Workspace sync")),
        h(Text, { slot: "description" }, "Connect a workspace first."),
      ),
    );
    const control = within(container).getByRole("switch", { name: "Workspace sync" });
    expect((control as HTMLInputElement).disabled).toBe(true);
    expect(describedText(control)).toContain("Connect a workspace first.");
    await act(async () => control.click());
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves radio-group arrow-key selection and description", async () => {
    const onChange = vi.fn();
    await render(
      h(
        RadioGroup,
        { label: "Save location", defaultValue: "device", onChange, children: null },
        h(
          RadioField,
          { value: "device" },
          h(RadioButton, null, h(Label, null, "This device")),
          h(Text, { slot: "description" }, "Available offline."),
        ),
        h(RadioField, { value: "team" }, h(RadioButton, null, h(Label, null, "Team workspace"))),
      ),
    );
    const user = userEvent.setup({ document });
    await act(async () => {
      await user.tab();
      await user.keyboard("{ArrowDown}");
    });
    expect(onChange).toHaveBeenCalledWith("team");
    expect((within(container).getByRole("radio", { name: "Team workspace" }) as HTMLInputElement).checked).toBe(true);
    expect(describedText(within(container).getByRole("radio", { name: "This device" }))).toContain(
      "Available offline.",
    );
  });
  it("associates invalid checkbox errors without color", async () => {
    await render(
      h(
        CheckboxField,
        { isInvalid: true, validationBehavior: "aria" },
        h(CheckboxButton, null, h(Label, null, "Confirm deletion")),
        h(FieldError, null, "Confirm deletion to continue."),
      ),
    );
    const control = within(container).getByRole("checkbox", { name: "Confirm deletion" });
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(control)).toContain("Confirm deletion to continue.");
  });
});
