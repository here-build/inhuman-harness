// @vitest-environment happy-dom

import { act, createElement as h, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isFileDropItem } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Breadcrumb,
  Breadcrumbs,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  FieldButton,
  Heading,
  Keyboard,
  Link,
  Separator,
  Text,
  Toolbar,
} from "../components/ui/navigation.js";
import {
  Dialog,
  DropZone,
  FileTrigger,
  Toast,
  ToastContent,
  ToastQueue,
  ToastRegion,
} from "../components/ui/feedback.js";

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

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function section(id: string, isDisabled = false) {
  return h(
    Disclosure,
    { id, isDisabled, key: id },
    h(Heading, null, h(FieldButton, { slot: "trigger" }, id)),
    h(DisclosurePanel, null, `${id} content`),
  );
}

describe("navigation links", () => {
  it("preserves anchor semantics, refs, render overrides and state classes", async () => {
    const ref = createRef<HTMLAnchorElement>();
    const onPress = vi.fn();
    await render(
      h(
        Link,
        {
          ref,
          href: "#project",
          target: "_self",
          rel: "noreferrer",
          onPress,
          render: (props) => h("a", { ...props, title: "Project destination" }),
          className: ({ isFocused }) => (isFocused ? "focused-link" : "resting-link"),
        },
        "Project",
      ),
    );
    const link = within(container).getByRole("link", { name: "Project" });
    expect(ref.current).toBe(link);
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#project");
    expect(link.getAttribute("target")).toBe("_self");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(link.title).toBe("Project destination");
    expect(link.className).toContain("resting-link");
    await interact(() => user.tab());
    expect(link.className).toContain("focused-link");
    await interact(() => user.keyboard("{Enter}"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not activate or tab to disabled links", async () => {
    const onPress = vi.fn();
    await render(
      h(
        "div",
        null,
        h(Link, { href: "#disabled", isDisabled: true, onPress }, "Unavailable"),
        h(FieldButton, null, "Next"),
      ),
    );
    const disabled = within(container).getByRole("link", { name: "Unavailable" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    await interact(() => user.click(disabled));
    expect(onPress).not.toHaveBeenCalled();
    await interact(() => user.tab());
    expect(document.activeElement).toBe(within(container).getByRole("button", { name: "Next" }));
  });

  it("retains typed breadcrumb collections and marks only the final page current", async () => {
    type Item = { id: string; label: string; href?: string };
    const items: Item[] = [
      { id: "projects", label: "Projects", href: "#projects" },
      { id: "current", label: "Overview" },
    ];
    const ref = createRef<HTMLOListElement>();
    await render(
      h(Breadcrumbs<Item>, {
        ref,
        "aria-label": "Location",
        items,
        children: (item) => h(Breadcrumb, { id: item.id }, h(Link, { href: item.href }, item.label)),
      }),
    );
    expect(ref.current?.tagName).toBe("OL");
    expect(ref.current?.getAttribute("aria-label")).toBe("Location");
    const current = within(container).getByRole("link", { name: "Overview" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(within(container).getByRole("link", { name: "Projects" }).hasAttribute("aria-current")).toBe(false);
  });
});

describe("disclosures", () => {
  it.each(["{Enter}", " "])("toggles labelled panels from the keyboard with %s", async (key) => {
    const ref = createRef<HTMLDivElement>();
    await render(
      h(
        Disclosure,
        {
          ref,
          className: ({ isExpanded }) => (isExpanded ? "expanded-section" : "collapsed-section"),
        },
        h(Heading, null, h(FieldButton, { slot: "trigger" }, "Details")),
        h(DisclosurePanel, { role: "region", children: "Project details" }),
      ),
    );
    const button = within(container).getByRole("button", { name: "Details" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(within(container).queryByRole("region")).toBeNull();
    await interact(() => user.tab());
    await interact(() => user.keyboard(key));
    const panel = within(container).getByRole("region", { name: "Details" });
    expect(button.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(button.id);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(ref.current?.className).toContain("expanded-section");
    await interact(() => user.keyboard(key));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(within(container).queryByRole("region")).toBeNull();
  });

  it("keeps single expansion, disabled state and controlled group updates", async () => {
    const onExpandedChange = vi.fn();
    function Controlled() {
      const [expandedKeys, setExpandedKeys] = useState(new Set(["Details"]));
      return h(
        DisclosureGroup,
        {
          expandedKeys,
          onExpandedChange: (keys) => {
            onExpandedChange(keys);
            setExpandedKeys(new Set(Array.from(keys, String)));
          },
        },
        section("Details"),
        section("History"),
        section("Restricted", true),
      );
    }
    await render(h(Controlled));
    const details = within(container).getByRole("button", { name: "Details" });
    const history = within(container).getByRole("button", { name: "History" });
    const restricted = within(container).getByRole("button", { name: "Restricted" });
    expect(details.getAttribute("aria-expanded")).toBe("true");
    await interact(() => user.click(history));
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(history.getAttribute("aria-expanded")).toBe("true");
    expect(onExpandedChange).toHaveBeenCalledWith(new Set(["History"]));
    expect((restricted as HTMLButtonElement).disabled).toBe(true);
    await interact(() => user.click(restricted));
    expect(restricted.getAttribute("aria-expanded")).toBe("false");
    expect(onExpandedChange).toHaveBeenCalledTimes(1);
  });

  it("supports multiple expanded sections when requested", async () => {
    await render(h(DisclosureGroup, { allowsMultipleExpanded: true }, section("Details"), section("History")));
    await interact(() => user.click(within(container).getByRole("button", { name: "Details" })));
    await interact(() => user.click(within(container).getByRole("button", { name: "History" })));
    for (const button of within(container).getAllByRole("button")) {
      expect(button.getAttribute("aria-expanded")).toBe("true");
    }
  });
});

describe("layout semantics", () => {
  it("uses toolbar arrow navigation and preserves separator orientation", async () => {
    await render(
      h(
        Toolbar,
        { "aria-label": "Project commands" },
        h(FieldButton, null, "Save"),
        h(FieldButton, { isDisabled: true }, "Publish"),
        h(Separator, { orientation: "vertical" }),
        h(FieldButton, null, "Preview"),
      ),
    );
    expect(within(container).getByRole("toolbar").getAttribute("aria-label")).toBe("Project commands");
    expect(within(container).getByRole("separator").getAttribute("aria-orientation")).toBe("vertical");
    await interact(() => user.tab());
    expect(document.activeElement?.textContent).toBe("Save");
    await interact(() => user.keyboard("{ArrowRight}"));
    expect(document.activeElement?.textContent).toBe("Preview");
  });

  it("keeps heading levels, text elements and literal keyboard notation", async () => {
    const headingRef = createRef<HTMLHeadingElement>();
    const textRef = createRef<HTMLElement>();
    const keyboardRef = createRef<HTMLElement>();
    await render(
      h(
        "div",
        null,
        h(Heading, { ref: headingRef, level: 2 }, "Project details"),
        h(Text, { ref: textRef, elementType: "p" }, "Read the latest revision."),
        h(Keyboard, { ref: keyboardRef }, "⌘K"),
      ),
    );
    expect(within(container).getByRole("heading", { level: 2 })).toBe(headingRef.current);
    expect(textRef.current?.tagName).toBe("P");
    expect(keyboardRef.current?.tagName).toBe("KBD");
    expect(keyboardRef.current?.textContent).toBe("⌘K");
  });
});

function FileFeedback() {
  const [names, setNames] = useState<string[]>([]);
  return h(
    DropZone,
    {
      "aria-label": "Project attachments",
      getDropOperation: (types) => (types.has("Files") ? "copy" : "cancel"),
      onDrop: async (event) => {
        const files = await Promise.all(event.items.filter(isFileDropItem).map((item) => item.getFile()));
        setNames(files.map((file) => file.name));
      },
    },
    h(Text, { slot: "label" }, "Drop files here"),
    h(
      FileTrigger,
      {
        allowsMultiple: true,
        acceptedFileTypes: ["text/plain"],
        onSelect: (files) => setNames(Array.from(files ?? [], (file) => file.name)),
      },
      h(FieldButton, null, "Choose files"),
    ),
    h(Text, { role: "status" }, names.join(", ") || "No files selected"),
  );
}

describe("file feedback", () => {
  it("keeps a keyboard accessible file trigger and announces selected filenames", async () => {
    await render(h(FileFeedback));
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input.accept).toBe("text/plain");
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, "click");
    const trigger = within(container).getByRole("button", { name: "Choose files" });
    await interact(() => trigger.focus());
    await interact(() => user.keyboard("{Enter}"));
    expect(click).toHaveBeenCalledTimes(1);
    await interact(() =>
      user.upload(input, [
        new File(["first"], "notes.txt", { type: "text/plain" }),
        new File(["second"], "review.txt", { type: "text/plain" }),
      ]),
    );
    expect(within(container).getByRole("status").textContent).toBe("notes.txt, review.txt");
  });

  it("accepts dropped files through the real DropZone API and reports their names", async () => {
    await render(h(FileFeedback));
    const zone = container.firstElementChild!;
    const transfer = new DataTransfer();
    transfer.items.add(new File(["review"], "dropped.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      await interact(() => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: transfer });
        zone.dispatchEvent(event);
      });
    }
    expect(within(container).getByRole("status").textContent).toBe("dropped.txt");
  });
});

describe("feedback semantics", () => {
  it("names standalone dialogs via heading slots without creating portals or modal owners", async () => {
    const ref = createRef<HTMLElement>();
    await render(
      h(Dialog, {
        ref,
        render: (props) => h("section", { ...props, title: "Inline feedback" }),
        children: () =>
          h("div", null, h(Heading, { slot: "title" }, "Review complete"), h(Text, null, "Ready for the next step.")),
      }),
    );
    const dialog = within(container).getByRole("dialog", { name: "Review complete" });
    expect(ref.current).toBe(dialog);
    expect(dialog.title).toBe("Inline feedback");
    expect(dialog.getAttribute("aria-modal")).toBeNull();
    expect(container.contains(dialog)).toBe(true);
    expect(document.querySelector("[data-react-aria-top-layer]")).toBeNull();
  });

  it("keeps typed toast content, refs, names, descriptions and dismiss behavior", async () => {
    const queue = new ToastQueue<{ title: string; description: string }>();
    const regionRef = createRef<HTMLDivElement>();
    const toastRef = createRef<HTMLDivElement>();
    await render(
      h(ToastRegion<{ title: string; description: string }>, {
        queue,
        ref: regionRef,
        "aria-label": "Project notifications",
        children: ({ toast }) =>
          h(
            Toast,
            { toast, ref: toastRef, className: ({ isFocused }) => (isFocused ? "focused-toast" : "idle-toast") },
            h(
              ToastContent,
              null,
              h(Text, { slot: "title", elementType: "h3" }, toast.content.title),
              h(Text, { slot: "description" }, toast.content.description),
            ),
            h(FieldButton, { slot: "close", "aria-label": "Dismiss notification" }, "Dismiss"),
          ),
      }),
    );
    await interact(() => queue.add({ title: "Changes saved", description: "The project is up to date." }));
    const notifications = within(document.body);
    expect(regionRef.current).toBe(notifications.getByRole("region", { name: "Project notifications" }));
    const toast = notifications.getByRole("alertdialog", { name: "Changes saved" });
    expect(toastRef.current).toBe(toast);
    expect(toast.className).toContain("idle-toast");
    const descriptionId = toast.getAttribute("aria-describedby");
    expect(descriptionId && document.querySelector(`#${CSS.escape(descriptionId)}`)?.textContent).toBe(
      "The project is up to date.",
    );
    await interact(() => user.click(notifications.getByRole("button", { name: "Dismiss notification" })));
    expect(notifications.queryByRole("alertdialog")).toBeNull();
  });
});
