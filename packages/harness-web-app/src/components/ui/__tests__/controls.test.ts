// @vitest-environment happy-dom

import { act, createElement as h, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../button.js";
import { Checkbox } from "../checkbox.js";
import { Input, Textarea } from "../input.js";
import { Radio, RadioGroup } from "../radio-group.js";
import { Switch } from "../switch.js";
import { Tab, TabList, TabPanel, Tabs } from "../tabs.js";
import { TextField } from "../text-field.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

// React Aria and native default actions can both schedule updates.
async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function describedText(element: HTMLElement) {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .map((id) => document.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
    .join(" ");
}

describe("Button", () => {
  it.each(["{Enter}", " "])("respects caller keyboard cancellation for %s", async (key) => {
    const onClick = vi.fn();
    const onPress = vi.fn();
    await render(h(Button, { onClick, onPress, onKeyDown: (event) => event.preventDefault() }, "Save"));
    await interact(() => user.tab());
    await interact(() => user.keyboard(key));
    expect(onClick).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it("preserves native parent click bubbling", async () => {
    const parentClick = vi.fn();
    const onClick = vi.fn();
    await render(h("div", { onClick: parentClick }, h(Button, { onClick }, "Save")));
    await interact(() => user.click(within(container).getByRole("button", { name: "Save" })));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(parentClick).toHaveBeenCalledTimes(1);
    expect(parentClick.mock.calls[0]?.[0].target).toBe(within(container).getByRole("button"));
  });

  it("preserves modifier keys in keyboard-triggered native clicks", async () => {
    const onClick = vi.fn();
    await render(h(Button, { onClick }, "Save"));
    await interact(() => user.tab());
    await interact(() => user.keyboard("{Shift>} {/Shift}"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0].shiftKey).toBe(true);
  });

  it("calls native onClick and onPress once each for pointer and native clicks", async () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    const onPress = vi.fn();
    const onFocus = vi.fn();
    await render(h(Button, { ref, onClick, onPress, onFocus, "aria-label": "Save", name: "action", value: "save" }));
    const button = within(container).getByRole("button", { name: "Save" });
    expect(ref.current).toBe(button);
    expect(button.getAttribute("name")).toBe("action");
    expect(button.getAttribute("value")).toBe("save");

    await interact(() => user.click(button));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onClick.mock.calls[0]?.[0].nativeEvent).toBeInstanceOf(MouseEvent);
    expect(onClick.mock.calls[0]?.[0].target).toBe(button);
    expect(onPress.mock.calls[0]?.[0].type).toBe("press");
    expect(onFocus).toHaveBeenCalledTimes(1);

    onClick.mockClear();
    onPress.mockClear();
    await interact(() => ref.current?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(["{Enter}", " "])("activates once with keyboard %s", async (key) => {
    const onClick = vi.fn();
    const onPress = vi.fn();
    await render(h(Button, { onClick, onPress }, "Save"));
    await interact(() => user.tab());
    const button = within(container).getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(button);
    expect(Object.hasOwn(button.dataset, "focusVisible")).toBe(true);
    await interact(() => user.keyboard(key));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it.each(["{Enter}", " "])("keeps macOS keyboard activation single for %s", async (key) => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const onClick = vi.fn();
    const onPress = vi.fn();
    await render(h(Button, { onClick, onPress }, "Save"));
    await interact(() => user.tab());
    await interact(() => user.keyboard(key));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("keeps a held Space activation when modifier keys change", async () => {
    const onClick = vi.fn();
    const onPress = vi.fn();
    await render(h(Button, { onClick, onPress }, "Save"));
    await interact(() => user.tab());
    await interact(() => user.keyboard("[Space>]{Shift>}{/Shift}[/Space]"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("preserves an explicit negative tabIndex", async () => {
    await render(h("div", null, h(Button, { tabIndex: -1 }, "Skipped"), h(Button, null, "Next")));
    expect(within(container).getByRole("button", { name: "Skipped" }).tabIndex).toBe(-1);
    await interact(() => user.tab());
    expect(document.activeElement).toBe(within(container).getByRole("button", { name: "Next" }));
  });

  it.each([{ disabled: true }, { isBusy: true }])("blocks native click, press, and submit when %j", async (state) => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    const onPress = vi.fn();
    const onSubmit = vi.fn((event: React.SubmitEvent<HTMLFormElement>) => event.preventDefault());
    await render(h("form", { onSubmit }, h(Button, { ...state, ref, onClick, onPress, type: "submit" }, "Save")));
    expect(ref.current?.disabled).toBe(true);
    expect(ref.current?.hasAttribute("data-disabled")).toBe(true);
    expect(ref.current?.getAttribute("aria-busy")).toBe("isBusy" in state ? "true" : null);
    await interact(() => user.click(ref.current!));
    await interact(() => ref.current?.click());
    // Even a programmatically dispatched click must not reach the native callback.
    await interact(() => ref.current?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    await interact(() => user.keyboard("{Enter} "));
    expect(onClick).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("preserves native form submit, external form attributes, and default type=button", async () => {
    const submitter = createRef<HTMLButtonElement>();
    const onSubmit = vi.fn((event: React.SubmitEvent<HTMLFormElement>) => event.preventDefault());
    await render(
      h(
        "div",
        null,
        h("form", { id: "settings", onSubmit }, h(Button, null, "Preview")),
        h(
          Button,
          { ref: submitter, type: "submit", form: "settings", formNoValidate: true, name: "action", value: "save" },
          "Save",
        ),
      ),
    );
    await interact(() => user.click(within(container).getByRole("button", { name: "Preview" })));
    expect(onSubmit).not.toHaveBeenCalled();
    await interact(() => user.click(within(container).getByRole("button", { name: "Save" })));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0].nativeEvent.submitter).toBe(submitter.current);
    expect(submitter.current?.form?.id).toBe("settings");
    expect(submitter.current?.formNoValidate).toBe(true);
  });

  it("can prevent native submission from onClick", async () => {
    const onSubmit = vi.fn();
    const onPress = vi.fn();
    await render(
      h(
        "form",
        { onSubmit },
        h(
          Button,
          {
            type: "submit",
            onPress,
            onClick: (event) => event.preventDefault(),
          },
          "Save",
        ),
      ),
    );
    await interact(() => user.click(within(container).getByRole("button")));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("native fields", () => {
  it("forwards input/textarea refs, values, native events, attributes, and focus handlers", async () => {
    const input = createRef<HTMLInputElement>();
    const textarea = createRef<HTMLTextAreaElement>();
    const onInputChange = vi.fn();
    const onTextareaChange = vi.fn();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    const onKeyDown = vi.fn();
    await render(
      h(
        "div",
        null,
        h(Input, {
          ref: input,
          "aria-label": "Search",
          name: "search",
          type: "search",
          defaultValue: "a",
          onChange: onInputChange,
          onFocus,
          onBlur,
          onKeyDown,
        }),
        h(Textarea, { ref: textarea, "aria-label": "Notes", name: "notes", rows: 4, onChange: onTextareaChange }),
      ),
    );
    expect(input.current?.type).toBe("search");
    expect(textarea.current?.getAttribute("rows")).toBe("4");
    await interact(() => user.type(input.current!, "b"));
    expect(input.current?.value).toBe("ab");
    expect(onInputChange).toHaveBeenCalledTimes(1);
    expect(onInputChange.mock.calls[0]?.[0].target).toBe(input.current);
    expect(onInputChange.mock.calls[0]?.[0].nativeEvent).toBeInstanceOf(Event);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    await interact(() => user.type(textarea.current!, "x"));
    expect(textarea.current?.value).toBe("x");
    expect(onTextareaChange).toHaveBeenCalledTimes(1);
    expect(onTextareaChange.mock.calls[0]?.[0].target).toBe(textarea.current);
    expect(onBlur).toHaveBeenCalledTimes(1);
    await render(h(Input, { ref: input, "aria-label": "Search", disabled: true }));
    await interact(() => user.type(input.current!, "blocked"));
    expect(input.current?.value).toBe("");
    expect(input.current?.hasAttribute("data-disabled")).toBe(true);
  });
});

describe("TextField", () => {
  it.each([false, true])("wires labels, descriptions, errors, values, and refs (multiline=%s)", async (multiline) => {
    const ref = createRef<HTMLInputElement | HTMLTextAreaElement>();
    const onChange = vi.fn();
    const onFocus = vi.fn();
    await render(
      h(TextField, {
        ref,
        multiline,
        label: "Project name",
        description: "Shown to your team.",
        errorMessage: "Enter a project name.",
        validationBehavior: "aria",
        isInvalid: true,
        isRequired: true,
        name: "project",
        onChange,
        onFocus,
        rows: 5,
      }),
    );
    const input = within(container).getByRole("textbox", { name: "Project name" });
    expect(ref.current).toBe(input);
    expect(input.tagName).toBe(multiline ? "TEXTAREA" : "INPUT");
    expect(within(container).getByLabelText("Project name")).toBe(input);
    expect(input.getAttribute("name")).toBe("project");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(describedText(input)).toContain("Shown to your team.");
    expect(describedText(input)).toContain("Enter a project name.");
    await interact(() => user.type(input, "A"));
    expect(ref.current?.value).toBe("A");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("A");
    expect(onFocus).toHaveBeenCalledTimes(1);
    if (ref.current instanceof HTMLTextAreaElement) expect(ref.current.getAttribute("rows")).toBe("5");
  });

  it("keeps disabled and read-only values unchanged and hides valid field errors", async () => {
    const onChange = vi.fn();
    await render(
      h(
        "div",
        null,
        h(TextField, { label: "Managed", defaultValue: "Production", isReadOnly: true, onChange }),
        h(TextField, { label: "Unavailable", defaultValue: "Archive", isDisabled: true, onChange }),
        h(TextField, { label: "Valid", errorMessage: "Not shown" }),
      ),
    );
    const managed = within(container).getByRole("textbox", { name: "Managed" });
    const unavailable = within(container).getByRole("textbox", { name: "Unavailable" });
    await interact(() => user.type(managed, "x"));
    await interact(() => user.type(unavailable, "x"));
    expect(managed.hasAttribute("readonly")).toBe(true);
    expect(unavailable.hasAttribute("disabled")).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Not shown");
  });
});

describe("selection controls", () => {
  it.each([
    [
      "checkbox",
      (props: React.ComponentProps<typeof Checkbox> & React.ComponentProps<typeof Switch>) => h(Checkbox, props),
    ],
    [
      "switch",
      (props: React.ComponentProps<typeof Checkbox> & React.ComponentProps<typeof Switch>) => h(Switch, props),
    ],
  ] as const)(
    "labels and toggles %s with Space, forwards its label ref, and blocks disabled/read-only",
    async (role, Component) => {
      const ref = createRef<HTMLLabelElement>();
      const onChange = vi.fn();
      await render(h(Component, { ref, onChange, name: "notifications", children: "Release notifications" }));
      const control = within(container).getByRole(role, { name: "Release notifications" });
      expect(ref.current?.tagName).toBe("LABEL");
      expect(ref.current?.contains(control)).toBe(true);
      expect(control.getAttribute("name")).toBe("notifications");
      await interact(() => user.tab());
      expect(document.activeElement).toBe(control);
      await interact(() => user.keyboard(" "));
      expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
      expect((control as HTMLInputElement).checked).toBe(true);
      expect(ref.current?.hasAttribute("data-selected")).toBe(true);
      await interact(() => user.keyboard(" "));
      expect(onChange).toHaveBeenLastCalledWith(false);
      expect(onChange).toHaveBeenCalledTimes(2);

      for (const state of [{ isDisabled: true }, { isReadOnly: true }]) {
        onChange.mockClear();
        await render(h(Component, { ...state, ref, onChange, children: "Release notifications" }));
        await interact(() => user.click(within(container).getByText("Release notifications")));
        await interact(() => user.keyboard(" "));
        expect(onChange).not.toHaveBeenCalled();
      }
    },
  );

  it("exposes the checkbox indeterminate state", async () => {
    await render(h(Checkbox, { isIndeterminate: true, children: "Select all" }));
    const checkbox = within(container).getByRole("checkbox", { name: "Select all" });
    expect((checkbox as HTMLInputElement).indeterminate).toBe(true);
    expect(checkbox.closest("label")?.hasAttribute("data-indeterminate")).toBe(true);
  });

  it("labels and describes a validated radio group; arrows skip disabled options", async () => {
    const ref = createRef<HTMLDivElement>();
    const radioRef = createRef<HTMLLabelElement>();
    const onChange = vi.fn();
    await render(
      h(RadioGroup, {
        ref,
        label: "Format",
        description: "Choose a download format.",
        name: "format",
        defaultValue: "csv",
        onChange,
        isInvalid: true,
        validationBehavior: "aria",
        errorMessage: "Choose an available format.",
        children: [
          h(Radio, { key: "csv", value: "csv", ref: radioRef, children: "CSV" }),
          h(Radio, { key: "xml", value: "xml", isDisabled: true, children: "XML" }),
          h(Radio, { key: "json", value: "json", children: "JSON" }),
        ],
      }),
    );
    const group = within(container).getByRole("radiogroup", { name: "Format" });
    expect(ref.current).toBe(group);
    expect(describedText(group)).toContain("Choose a download format.");
    expect(describedText(group)).toContain("Choose an available format.");
    expect(group.getAttribute("aria-invalid")).toBe("true");
    const csv = within(group).getByRole("radio", { name: "CSV" });
    const json = within(group).getByRole("radio", { name: "JSON" });
    expect(radioRef.current?.contains(csv)).toBe(true);
    expect(csv.getAttribute("name")).toBe("format");
    await interact(() => user.tab());
    expect(document.activeElement).toBe(csv);
    await interact(() => user.keyboard("{ArrowDown}"));
    expect(document.activeElement).toBe(json);
    expect((json as HTMLInputElement).checked).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("json");
    await interact(() => user.click(within(group).getByText("XML")));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("Tabs", () => {
  it("links tabs and panels, skips disabled tabs, and navigates by keyboard", async () => {
    const ref = createRef<HTMLDivElement>();
    const onSelectionChange = vi.fn();
    await render(
      h(
        Tabs,
        { ref, defaultSelectedKey: "overview", onSelectionChange },
        h(
          TabList,
          { "aria-label": "Project sections" },
          h(Tab, { id: "overview" }, "Overview"),
          h(Tab, { id: "billing", isDisabled: true }, "Billing"),
          h(Tab, { id: "activity" }, "Activity"),
        ),
        h(TabPanel, { id: "overview" }, "Project details"),
        h(TabPanel, { id: "billing" }, "Billing details"),
        h(TabPanel, { id: "activity" }, "Recent activity"),
      ),
    );
    const overview = within(container).getByRole("tab", { name: "Overview" });
    const activity = within(container).getByRole("tab", { name: "Activity" });
    expect(ref.current?.contains(overview)).toBe(true);
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(within(container).getByRole("tab", { name: "Billing" }).getAttribute("aria-disabled")).toBe("true");
    let panel = within(container).getByRole("tabpanel", { name: "Overview" });
    expect(overview.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(overview.id);
    await interact(() => user.tab());
    expect(document.activeElement).toBe(overview);
    await interact(() => user.keyboard("{ArrowRight}"));
    expect(document.activeElement).toBe(activity);
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith("activity");
    panel = within(container).getByRole("tabpanel", { name: "Activity" });
    expect(panel.textContent).toBe("Recent activity");
    await interact(() => user.keyboard("{Home}"));
    expect(document.activeElement).toBe(overview);
    await interact(() => user.keyboard("{End}"));
    expect(document.activeElement).toBe(activity);
  });
});
