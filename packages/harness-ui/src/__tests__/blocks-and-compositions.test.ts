// @vitest-environment happy-dom

import { act, createElement as h, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AckBlock,
  ComposerBlock,
  ConversationStage,
  FilePreviewPane,
  FilePreviewProvider,
  InspectorDrawer,
  PermissionModeControl,
  PictureChipsBlock,
  PictureDropSurface,
  ProjectTabsBlock,
  ReasoningEffortControl,
  SessionRailBlock,
  SessionSidebar,
  SettingsModal,
  SwipeRow,
  TerminalBlock,
  VoiceProvider,
  WorkspaceBar,
  WorkspaceShell,
  defineVoiceCatalog,
  enVoiceCatalog,
  pageScheme,
  useFilePreview,
  useScheme,
  type DraftPicture,
} from "../index.js";

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

describe("blocks and compositions", () => {
  it("composes WorkspaceShell layouts, semantic surface slots, InspectorDrawer, and SettingsModal", async () => {
    const onInspectClose = vi.fn();
    const onSettingsDismiss = vi.fn();
    const onSelectSetting = vi.fn();
    const renderShell = (props: {
      layout: "rail-left" | "header-top";
      embed?: boolean;
      picking?: boolean;
      activeSetting?: string;
    }) =>
      h(WorkspaceShell, {
        layout: props.layout,
        embed: props.embed,
        picking: props.picking,
        sidebar: h(
          SessionSidebar,
          { open: true, brand: "Acme" },
          h(SessionRailBlock, {
            mode: "project",
            heading: "repo",
            items: [{ key: "s1", href: "#s1", label: "First", light: "idle", selected: true }],
            onNavigate: () => undefined,
          }),
        ),
        stage: h(
          ConversationStage,
          { composer: h("div", { "data-testid": "composer-slot" }, "Composer") },
          h("p", null, "Transcript stage"),
        ),
        inspector: h(
          InspectorDrawer,
          { title: "notes.md", ariaLabel: "Inspector", closeAriaLabel: "Close inspector", onClose: onInspectClose },
          h("pre", null, "preview"),
        ),
        workspaceBar: h(
          WorkspaceBar,
          { mobileNavToggle: { open: false, onToggle: () => undefined } },
          h("span", null, "Tabs"),
        ),
        overlay: h(
          SettingsModal,
          {
            items: [
              { id: "general", label: "General" },
              { id: "runtime", label: "Runtime" },
            ],
            activeId: props.activeSetting ?? "general",
            onSelect: onSelectSetting,
            onDismiss: onSettingsDismiss,
          },
          h("p", null, "Settings panel"),
        ),
      });

    await render(renderShell({ layout: "rail-left", picking: true }));
    const frame = container.querySelector<HTMLElement>(".frame")!;
    expect({
      layout: frame.dataset.layout ?? null,
      embed: Object.hasOwn(frame.dataset, "embed"),
      hasFrameBody: frame.querySelector(".frame-body") !== null,
      hasBar: frame.querySelector(".project-strip") !== null,
      hasPickerBackdrop: frame.querySelector(".picker-backdrop") !== null,
      sidebarSurface: container.querySelector<HTMLElement>("aside#navigation-rail")?.dataset.surface,
      stageSurface: container.querySelector<HTMLElement>("main.tape")?.dataset.surface,
      hasAnchor: container.querySelector("main.tape > .anchor") !== null,
      inspectorSurface: container.querySelector<HTMLElement>("aside.file-sidebar")?.dataset.surface,
    }).toEqual({
      layout: null,
      embed: false,
      hasFrameBody: true,
      hasBar: true,
      hasPickerBackdrop: true,
      sidebarSurface: "soft",
      stageSurface: "paper",
      hasAnchor: true,
      inspectorSurface: "paper",
    });

    await interact(() => user.click(within(container).getByRole("button", { name: "Close inspector" })));
    await interact(() => user.click(within(container).getByRole("button", { name: "Runtime" })));
    await interact(() => user.click(within(container).getByRole("button", { name: "Close" })));
    expect({
      inspectClosed: onInspectClose.mock.calls.length,
      selectedSetting: onSelectSetting.mock.calls,
      settingsDismissed: onSettingsDismiss.mock.calls.length,
    }).toEqual({
      inspectClosed: 1,
      selectedSetting: [["runtime"]],
      settingsDismissed: 1,
    });

    await render(renderShell({ layout: "header-top", embed: true }));
    expect({
      layout: frame.dataset.layout,
      embed: frame.dataset.embed !== undefined,
      hasFrameBody: frame.querySelector(".frame-body") !== null,
      hasBar: frame.querySelector(".project-strip") !== null,
      hasPickerBackdrop: frame.querySelector(".picker-backdrop") !== null,
    }).toEqual({
      layout: "header-top",
      embed: true,
      hasFrameBody: false,
      hasBar: false,
      hasPickerBackdrop: false,
    });
  });

  it("propagates custom VoiceProvider labels across blocks", async () => {
    const customVoice = defineVoiceCatalog(
      {
        common: { close: "Dismiss" },
        workspace: {
          sessionsLabel: "Workstreams",
          projectsLabel: "Workspaces",
        },
        composer: {
          promptLabel: "Client instruction",
          sendLabel: "Dispatch",
          effortLabel: "Thinking budget",
          permissionModeLabel: "Safety policy",
        },
        settings: { title: "Client Settings" },
      },
      enVoiceCatalog,
    );

    const fieldRef = createRef<HTMLTextAreaElement>();
    const pillRef = createRef<HTMLDivElement>();

    await render(
      h(
        VoiceProvider,
        { catalog: customVoice },
        h("div", null, [
          h(SessionRailBlock, { key: "rail", mode: "project", items: [], onNavigate: () => undefined }),
          h(ProjectTabsBlock, { key: "tabs", activeKey: "a", tabs: [] }),
          h(ComposerBlock, {
            key: "composer",
            notice: "",
            fieldRef,
            pillRef,
            dropEnabled: false,
            onDropFiles: () => undefined,
            pictures: [],
            picturesDisabled: true,
            onRemovePicture: () => undefined,
            onPickPictures: () => undefined,
            slashMenu: null,
            draft: "hello",
            onDraftChange: () => undefined,
            onDraftKeyDown: () => undefined,
            onDraftPaste: () => undefined,
            showSend: true,
            canSend: true,
            onSend: () => undefined,
            lane: h(ReasoningEffortControl, {
              triggerWord: "high",
              selectedKey: "high",
              options: [{ id: "high", label: "High" }],
              onSelect: () => undefined,
            }),
            footer: h(PermissionModeControl, { mode: "auto", onModeChange: () => undefined }),
          }),
          h(SettingsModal, {
            key: "settings",
            items: [{ id: "g", label: "General" }],
            activeId: "g",
            onSelect: () => undefined,
            onDismiss: () => undefined,
          }),
        ]),
      ),
    );

    expect({
      sessionsNav: within(container).queryByRole("navigation", { name: "Workstreams" }) !== null,
      projectsNav: within(container).queryByRole("navigation", { name: "Workspaces" }) !== null,
      prompt: within(container).queryByRole("textbox", { name: "Client instruction" }) !== null,
      send: within(container).queryByRole("button", { name: "Dispatch" }) !== null,
      permissionGroup: within(container).queryByRole("radiogroup", { name: "Safety policy" }) !== null,
      effortBtn: within(container).queryByRole("button", { name: "Thinking budget: high" }) !== null,
      settingsNav: within(container).queryByRole("navigation", { name: "Client Settings" }) !== null,
      closeBtn: within(container).queryByRole("button", { name: "Dismiss" }) !== null,
    }).toEqual({
      sessionsNav: true,
      projectsNav: true,
      prompt: true,
      send: true,
      permissionGroup: true,
      effortBtn: true,
      settingsNav: true,
      closeBtn: true,
    });
  });

  it("pins manual TerminalBlock disclosure choices across outcome updates and reveals unpinned beforematch", async () => {
    const paint = (outcome: "live" | "ok" | "failed") =>
      render(h(TerminalBlock, { command: "cat MixedCase.ts", output: "Exact output", outcome }));

    await paint("live");
    const trigger = within(container).getByRole("button", { name: /cat MixedCase.ts/ });
    const panel = document.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-controls")}"]`)!;
    expect({
      expanded: trigger.getAttribute("aria-expanded"),
      labelledByMatch: panel.getAttribute("aria-labelledby") === trigger.id,
    }).toEqual({ expanded: "true", labelledByMatch: true });

    await interact(() => {
      trigger.focus();
      return user.keyboard(" ");
    });
    expect({
      expanded: trigger.getAttribute("aria-expanded"),
      hidden: panel.getAttribute("hidden"),
    }).toEqual({ expanded: "false", hidden: "until-found" });

    await paint("ok");
    const afterOk = trigger.getAttribute("aria-expanded");
    await paint("failed");
    const afterFailed = trigger.getAttribute("aria-expanded");
    expect({ afterOk, afterFailed }).toEqual({ afterOk: "false", afterFailed: "false" });

    await interact(() => root.render(null));
    await paint("ok");
    const unpinnedTrigger = within(container).getByRole("button", { name: /cat MixedCase.ts/ });
    const unpinnedPanel = document.querySelector<HTMLElement>(
      `[id="${unpinnedTrigger.getAttribute("aria-controls")}"]`,
    )!;
    const initiallyExpanded = unpinnedTrigger.getAttribute("aria-expanded");
    await paint("live");
    const liveExpanded = unpinnedTrigger.getAttribute("aria-expanded");
    await paint("ok");
    const settledExpanded = unpinnedTrigger.getAttribute("aria-expanded");
    await interact(() => unpinnedPanel.dispatchEvent(new Event("beforematch")));
    expect({
      initiallyExpanded,
      liveExpanded,
      settledExpanded,
      beforematchExpanded: unpinnedTrigger.getAttribute("aria-expanded"),
      beforematchAriaHidden: unpinnedPanel.getAttribute("aria-hidden"),
      beforematchHiddenAttr: unpinnedPanel.hasAttribute("hidden"),
    }).toEqual({
      initiallyExpanded: "false",
      liveExpanded: "true",
      settledExpanded: "false",
      beforematchExpanded: "true",
      beforematchAriaHidden: "false",
      beforematchHiddenAttr: false,
    });
  });

  it("handles PictureChipsBlock remote/missing previews, PictureDropSurface drops, and AckBlock round-trip", async () => {
    const picture: DraftPicture = {
      key: "pic-1",
      mime: "image/png",
      bytesBase64: "https://example.com/a.png",
      width: 10,
      height: 10,
      sourcePath: "shot.png",
    };
    const label = "shot.png · image/png · 10×10";
    const onRemove = vi.fn();
    await render(
      h(PictureChipsBlock, {
        pictures: [picture, { ...picture, key: "pic-2", bytesBase64: "" }],
        onRemove,
        onPick: vi.fn(),
      }),
    );
    const previews = within(container).getAllByRole<HTMLButtonElement>("button", { name: label });
    const removes = within(container).getAllByRole<HTMLButtonElement>("button", { name: `Remove ${label}` });
    await interact(() => removes[0]!.click());
    expect({
      disabledPreviews: previews.map((btn) => btn.disabled),
      disabledRemoves: removes.map((btn) => btn.disabled),
      removed: onRemove.mock.calls,
    }).toEqual({
      disabledPreviews: [true, true],
      disabledRemoves: [false, false],
      removed: [["pic-1"]],
    });

    const fieldRef = createRef<HTMLDivElement>();
    const onDrop = vi.fn();
    await render(h(PictureDropSurface, { fieldRef, enabled: true, onDrop, children: h("span", null, "Draft") }));
    const data = new DataTransfer();
    const droppedFile = new File(["a"], "one.png", { type: "image/png" });
    data.items.add(droppedFile);
    const drag = async (type: string) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: data });
      await interact(() => fieldRef.current?.dispatchEvent(event));
    };
    await drag("dragenter");
    const hotDrop = fieldRef.current?.dataset.drop;
    await drag("drop");
    const afterDrop = fieldRef.current?.dataset.drop ?? null;
    await drag("dragenter");
    await render(h(PictureDropSurface, { fieldRef, enabled: false, onDrop, children: h("span", null, "Draft") }));
    await drag("drop");
    expect({
      hotDrop,
      afterDrop,
      disabledDrop: fieldRef.current?.dataset.drop ?? null,
      dropCalls: onDrop.mock.calls.length,
    }).toEqual({
      hotDrop: "hot",
      afterDrop: null,
      disabledDrop: null,
      dropCalls: 1,
    });

    function AckHarness() {
      const [remember, setRemember] = useState("stale");
      return h(AckBlock, {
        flags: [{ label: "Shell", why: "Runs a command" }],
        choices: [{ key: "0:session", text: "Shell · this session" }],
        remember,
        disabled: false,
        onRemember: setRemember,
      });
    }
    await render(h(AckHarness));
    const select = within(container).getByRole("button", { name: "Just this once Remember" });
    const cleanText = (node: HTMLElement) => node.textContent.replace("▾", "").trim();
    const initialText = cleanText(select);
    await interact(() => user.click(select));
    await interact(() => user.click(within(container).getByRole("option", { name: "Shell · this session" })));
    const selectedText = cleanText(select);
    await interact(() => user.click(select));
    await interact(() => user.click(within(container).getByRole("option", { name: "Just this once" })));
    expect({
      initialText,
      selectedText,
      resetText: cleanText(select),
    }).toEqual({
      initialText: "Just this once",
      selectedText: "Shell · this session",
      resetText: "Just this once",
    });
  });

  it("handles SwipeRow keyboard reveal, pointer direction capture, and busy focus recovery", async () => {
    const onToggle = vi.fn();
    const onPress = vi.fn();
    const renderRow = (disabled = false) =>
      render(
        h(SwipeRow, {
          label: "Enable integration",
          title: "Integration",
          detail: "Ready",
          checked: true,
          disabled,
          trailing: { label: "Delete", name: "Delete integration", tone: "destructive", onPress },
          onToggle,
        }),
      );

    await renderRow(false);
    const main = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const action = container.querySelector<HTMLButtonElement>('button[aria-label="Delete integration"]')!;
    const initiallyHidden = action.getAttribute("aria-hidden");
    await interact(() =>
      main.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })),
    );
    const revealedTabIndex = action.tabIndex;
    const revealedAriaHidden = action.hasAttribute("aria-hidden");
    await interact(() => action.focus());
    await interact(() => action.click());
    expect({
      initiallyHidden,
      revealedTabIndex,
      revealedAriaHidden,
      onPressCalls: onPress.mock.calls.length,
      onToggleCalls: onToggle.mock.calls.length,
      restoredTabIndex: action.tabIndex,
      focusOnMain: document.activeElement === main,
    }).toEqual({
      initiallyHidden: "true",
      revealedTabIndex: 0,
      revealedAriaHidden: false,
      onPressCalls: 1,
      onToggleCalls: 0,
      restoredTabIndex: -1,
      focusOnMain: true,
    });

    const capture = vi.fn();
    Object.defineProperty(main, "setPointerCapture", { configurable: true, value: capture });
    const ptr = async (type: string, x: number, y: number) => {
      await interact(() =>
        main.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "touch",
            button: 0,
            clientX: x,
            clientY: y,
          }),
        ),
      );
    };
    await ptr("pointerdown", 100, 100);
    await ptr("pointermove", 95, 150);
    const verticalCaptured = capture.mock.calls.length;
    await ptr("pointerup", 95, 150);
    await ptr("pointerdown", 100, 100);
    await ptr("pointermove", 50, 102);
    const horizontalCaptured = capture.mock.calls.length;
    const draggingDuringMove = container.querySelector<HTMLElement>(".swipe-clip")!.dataset.dragging;
    await ptr("pointerup", 50, 102);
    await interact(() => main.click());
    expect({
      verticalCaptured,
      horizontalCaptured,
      draggingDuringMove,
      postDragToggleCalls: onToggle.mock.calls.length,
    }).toEqual({
      verticalCaptured: 0,
      horizontalCaptured: 1,
      draggingDuringMove: "true",
      postDragToggleCalls: 0,
    });

    await interact(() =>
      main.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })),
    );
    await interact(() => action.focus());
    await renderRow(true);
    const busyFocus = document.activeElement === container.querySelector(".swipe-clip");
    await renderRow(false);
    const recoveredFocus = document.activeElement === main;
    await renderRow(true);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await renderRow(false);
    const outsidePreserved = document.activeElement === outside;
    outside.remove();
    expect({ busyFocus, recoveredFocus, outsidePreserved }).toEqual({
      busyFocus: true,
      recoveredFocus: true,
      outsidePreserved: true,
    });
  });

  it("delegates FilePreviewProvider.open to host onOpen without opening built-in drawer and tracks data-theme scheme", async () => {
    const onOpen = vi.fn();
    function Probe() {
      const preview = useFilePreview();
      const scheme = useScheme();
      return h(
        "button",
        {
          type: "button",
          "data-scheme-probe": scheme,
          onClick: () => preview.open({ path: "notes/summary.md", label: "summary.md" }),
        },
        "Open doc",
      );
    }

    document.documentElement.dataset.theme = "dark";
    try {
      await render(
        h(FilePreviewProvider, { resetKey: "s1", onOpen }, h(Probe), h(FilePreviewPane, { projectPath: "/workspace" })),
      );
      const btn = container.querySelector<HTMLButtonElement>("[data-scheme-probe]")!;
      expect(btn.dataset.schemeProbe).toBe("dark");
      expect(pageScheme()).toBe("dark");

      await interact(() => btn.click());
      expect(onOpen).toHaveBeenCalledWith({ path: "notes/summary.md", label: "summary.md" });
      expect(container.querySelector(".file-sidebar")).toBeNull();

      await interact(() => {
        document.documentElement.dataset.theme = "light";
      });
      await waitForScheme(btn, "light");
      expect(pageScheme()).toBe("light");
    } finally {
      await interact(() => {
        delete document.documentElement.dataset.theme;
      });
    }
  });
});

async function waitForScheme(node: HTMLElement, expected: string): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  for (let i = 0; i < 10 && node.dataset.schemeProbe !== expected; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(node.dataset.schemeProbe).toBe(expected);
}
