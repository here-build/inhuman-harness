import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseColor } from "react-aria-components";
import {
  Button,
  Checkbox,
  ColorArea,
  ColorSlider,
  ColorSliderTrack,
  ColorSwatchPicker,
  ColorSwatchPickerItem,
  ColorThumb,
  ColorWheel,
  ColorWheelTrack,
  Dialog,
  DropdownSelect,
  Label,
  Radio,
  RadioGroup,
  Slider,
  SliderThumb,
  SliderTrack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
} from "@inhuman.tools/harness-ui";
import "@fontsource/monaspace-krypton/400.css";
import "@fontsource/monaspace-krypton/700.css";
import { ToolBodyView } from "@inhuman.tools/harness-transcript";

import { agentActivity, agents, agentWorkers, approval, autoUnavailable, conversation } from "../__stories__/scenes.js";
import { sessionStage, StoryApp } from "../__stories__/story-app.js";
import "../styles.css";

function face(node: HTMLElement) {
  const style = getComputedStyle(node);
  return {
    outline: [style.outlineStyle, style.outlineWidth, style.outlineColor],
    background: style.backgroundColor,
    border: [style.borderStyle, style.borderWidth, style.borderColor],
    font: [style.fontFamily, style.fontSize, style.fontVariantCaps],
  };
}

async function present<T extends Element>(selector: string): Promise<T> {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const node = document.querySelector<T>(selector);
    if (node) return node;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Rendered state did not appear: ${selector}`);
}

function focus(node: HTMLElement) {
  node.focus();
  const style = getComputedStyle(node);
  if (
    document.activeElement !== node ||
    !node.matches(":focus-visible") ||
    style.outlineStyle === "none" ||
    Number.parseFloat(style.outlineWidth) < 2
  ) {
    throw new Error(`Invisible keyboard focus: ${node.getAttribute("aria-label") ?? node.textContent}`);
  }
  return face(node);
}

async function cdpClick(node: Element) {
  const rect = node.getBoundingClientRect();
  delete document.documentElement.dataset.cdpClickDone;
  document.documentElement.dataset.cdpClick = JSON.stringify({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (document.documentElement.dataset.cdpClickDone === "1") {
      delete document.documentElement.dataset.cdpClickDone;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`CDP click did not complete on ${node.outerHTML}`);
}

async function approve() {
  const query = new URL(location.href).searchParams;
  const scenario = query.get("scene") ?? "composer";
  const scheme = query.get("scheme") ?? (scenario === "design-system-light" ? "light" : "dark");
  document.documentElement.dataset.scheme = scheme === "light" ? "light" : "dark";
  if (scenario.startsWith("fallback-") || scenario === "native-popover") {
    return approvePopover(scenario, query.get("hold") === "1");
  }
  if (scenario === "design-system" || scenario === "design-system-light") {
    return approveDesignSystem();
  }
  const stage = scenario.startsWith("agent-activity")
    ? () => {
        const { parent, worker } = agentActivity();
        return sessionStage(() => parent, { peeks: () => [worker] })();
      }
    : scenario.startsWith("activity")
      ? sessionStage(autoUnavailable)
      : scenario === "transcript"
        ? sessionStage(agents, { workers: agentWorkers })
        : scenario === "approval"
          ? sessionStage(() => approval("shell"))
          : sessionStage(conversation);
  const root = createRoot(document.querySelector("#app")!);
  root.render(createElement(StoryApp, { stage }));

  if (scenario.startsWith("agent-activity")) {
    const note = await present<HTMLButtonElement>(".agent-note:not(:disabled)");
    note.click();
    const status = await present<HTMLElement>(".agent-peek > .session-status");
    const dialog = status.closest<HTMLDialogElement>("dialog");
    if (dialog == null) throw new Error("The agent status has no dialog");
    for (const detail of status.querySelectorAll("details")) detail.open = true;
    await document.fonts.ready;
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    const tape = dialog.querySelector<HTMLElement>(".agent-peek-tape");
    if (close == null || tape == null) throw new Error("The agent dialog is missing its controls");
    if (!status.textContent?.includes("3 / 15 unsuccessful foreground attempts"))
      throw new Error("The agent dialog is not showing its worker's retry status");
    const box = dialog.getBoundingClientRect();
    if (box.top < 0 || box.bottom > innerHeight || dialog.scrollWidth > dialog.clientWidth)
      throw new Error("The agent dialog overflows the viewport");
    if (status.getBoundingClientRect().bottom > tape.getBoundingClientRect().top + 1)
      throw new Error("The agent status overlaps its transcript");
    return { status: status.textContent, focus: focus(close) };
  }

  if (scenario.startsWith("permissions")) {
    const words = await present<HTMLElement>(".permission-modes");
    const auto = await present<HTMLInputElement>('.permission-word input[value="auto"]');
    auto.click();
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const labels = [...words.querySelectorAll<HTMLElement>(".permission-word")];
    const bounds = labels.map((label) => label.getBoundingClientRect());
    if (new Set(bounds.map((box) => Math.round(box.top))).size !== 1)
      throw new Error("Permission words do not share a row");
    if (bounds.some((box) => box.left < 0 || box.right > innerWidth))
      throw new Error("Permission words overflow the viewport");
    if (!auto.checked) throw new Error("Auto did not become selected");
    auto.focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const autoLabel = auto.closest<HTMLElement>("label")!;
    if (getComputedStyle(autoLabel).outlineStyle === "none") throw new Error("Permission word has no keyboard focus");
    const adjust = await present<HTMLButtonElement>(".permission-adjust");
    const triggerFace = focus(adjust);
    adjust.click();
    const panel = await present<HTMLElement>('.permission-panel [role="dialog"]');
    // Native anchor placement follows the frame that mounts the top-layer panel.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (words.querySelector<HTMLInputElement>("input:checked")?.value !== "auto")
      throw new Error("Opening adjustments changed the permission mode");
    const box = panel.closest<HTMLElement>(".permission-panel")!.getBoundingClientRect();
    if (box.left < 0 || box.right > innerWidth || box.top < 0 || box.bottom > innerHeight)
      throw new Error(
        `Permission panel overflows the viewport: ${JSON.stringify(box.toJSON())} in ${innerWidth} × ${innerHeight}`,
      );
    if (panel.scrollWidth > panel.clientWidth) throw new Error("Permission panel contents overflow horizontally");
    return {
      words: labels.map((label) => ({ text: label.textContent, ...face(label) })),
      trigger: triggerFace,
      panel: face(panel),
      selected: auto.value,
    };
  }

  if (scenario.startsWith("activity")) {
    const status = await present<HTMLElement>(".session-status");
    const draft = await present<HTMLTextAreaElement>('textarea[aria-label="Message draft"]');
    const permission = await present<HTMLElement>(".permission-word[data-problem]");
    await document.fonts.ready;
    if (status.getBoundingClientRect().bottom > draft.getBoundingClientRect().top)
      throw new Error("Activity status overlaps the message draft");
    if (document.documentElement.scrollWidth > innerWidth) throw new Error("Activity status overflows the viewport");
    permission.querySelector<HTMLInputElement>("input")!.focus();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (getComputedStyle(permission).outlineStyle === "none") throw new Error("Auto warning has no keyboard focus");
    return { status: status.textContent, permission: permission.textContent, focus: face(permission) };
  }

  if (scenario === "transcript") {
    const note = await present<HTMLButtonElement>(".agent-note:not(:disabled)");
    const noteFace = focus(note);
    root.render(
      createElement(ToolBodyView, {
        body: {
          kind: "fail-line",
          verb: "write",
          path: "src/locked.ts",
          label: "locked.ts",
          detail: "Permission denied",
        },
      }),
    );
    const failure = await present<HTMLButtonElement>(".fail-info > button");
    return { note: noteFace, failure: focus(failure) };
  }
  if (scenario === "approval") {
    const shortcut = await present<HTMLElement>(".composer kbd");
    return { shortcut: face(shortcut) };
  }

  const draft = await present<HTMLTextAreaElement>('textarea[aria-label="Message draft"]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "Review focus visibility");
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  await present('button[aria-label="Send"]');
  const actions = [...document.querySelectorAll<HTMLButtonElement>(".composer button")].filter(
    (node) => !node.disabled && node.getAttribute("aria-label"),
  );
  if (actions.length === 0) throw new Error("composer has no named enabled actions");
  const focuses = actions.map((node) => ({ name: node.getAttribute("aria-label"), ...focus(node) }));
  draft.focus();
  return {
    actions: focuses,
    editor: { name: draft.getAttribute("aria-label"), focused: document.activeElement === draft, face: face(draft) },
    boundary: face(draft.closest<HTMLElement>(".composer-pill")!),
  };
}

async function approvePopover(scenario: string, hold: boolean) {
  const nativePopover = scenario === "native-popover";
  const manual = scenario === "fallback-popover";
  if (manual) Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  const root = createRoot(document.querySelector("#app")!);
  root.render(
    createElement(Dialog, {
      isOpen: true,
      onOpenChange: () => undefined,
      label: "Settings",
      children: createElement(DropdownSelect, {
        label: "Provider",
        defaultSelectedKey: "one",
        options: [
          { id: "one", label: "First provider" },
          { id: "two", label: "Second provider" },
        ],
      }),
    }),
  );
  const trigger = await present<HTMLButtonElement>(".gp-anchored-trigger");
  trigger.focus();
  if (nativePopover) {
    await cdpClick(trigger);
  } else {
    trigger.click();
  }
  let panel = await present<HTMLElement>(".gp-native-popover");
  await document.fonts.ready;
  await new Promise((resolve) => setTimeout(resolve, 60));
  if (!document.querySelector(".gp-native-popover")) {
    throw new Error("Popover dismissed immediately after pointer click open");
  }
  const box = panel.getBoundingClientRect();
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    box.left < 0 ||
    box.top < 0 ||
    box.right > innerWidth ||
    box.bottom > innerHeight
  ) {
    throw new Error(`Popover panel escapes viewport: ${JSON.stringify(box.toJSON())}`);
  }
  if (panel.closest("dialog[open]") == null) throw new Error("Popover escaped the modal's non-inert subtree");

  let toggledClosedOnSecondClick = false;
  if (nativePopover) {
    await cdpClick(trigger);
    const closedUntil = Date.now() + 2_000;
    while (Date.now() < closedUntil && document.querySelector(".gp-native-popover")) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (document.querySelector(".gp-native-popover")) {
      throw new Error("Second click on trigger did not toggle native popover closed");
    }
    toggledClosedOnSecondClick = true;
    await cdpClick(trigger);
    panel = await present<HTMLElement>(".gp-native-popover");
  }

  const frame = nativePopover
    ? { nativePopover: true, toggledClosedOnSecondClick, insideModal: true, position: getComputedStyle(panel).position }
    : { anchors: false, manual, contained: true, insideModal: true, position: getComputedStyle(panel).position };
  if (!hold) {
    const optionTwo = await present<HTMLElement>('[role="option"][data-key="two"]');
    if (nativePopover) {
      await cdpClick(optionTwo);
    } else {
      optionTwo.click();
    }
    const until = Date.now() + 5_000;
    while (Date.now() < until && (document.activeElement !== trigger || document.querySelector(".gp-native-popover"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!trigger.textContent?.includes("Second provider") || document.querySelector(".gp-native-popover")) {
      throw new Error("Popover provider selection did not close and update the field");
    }
    if (document.activeElement !== trigger)
      throw new Error(`Popover did not restore focus: ${document.activeElement?.outerHTML}`);
  }
  return { ...frame, selected: hold ? "panel held open for review" : "Second provider" };
}

async function approveDesignSystem() {
  const initialColor = parseColor("#267fd9").toFormat("hsl");
  const root = createRoot(document.querySelector("#app")!);
  root.render(
    createElement(
      "div",
      { className: "p-6 bg-canvas text-ink flex flex-col gap-6" },
      createElement(
        "div",
        { className: "flex flex-wrap gap-3" },
        createElement(Button, { type: "button" }, "ALLOW"),
        createElement(Button, { type: "button", disabled: true }, "DISABLED"),
        createElement(Button, { type: "button", variant: "secondary" }, "DENY"),
        createElement(Button, { type: "button", variant: "ghost" }, "BROWSE"),
      ),
      createElement(
        "div",
        { className: "flex flex-col items-start gap-2" },
        createElement(Checkbox, { defaultSelected: true, children: "Include completed tasks" }),
        createElement(Checkbox, { children: "Include archived tasks" }),
      ),
      createElement(RadioGroup, {
        label: "Export format",
        defaultValue: "csv",
        children: [
          createElement(Radio, { key: "csv", value: "csv", children: "CSV" }),
          createElement(Radio, { key: "json", value: "json", children: "JSON" }),
        ],
      }),
      createElement(
        Tabs,
        { defaultSelectedKey: "overview" },
        createElement(
          TabList,
          { "aria-label": "Project sections" },
          createElement(Tab, { id: "overview" }, "Overview"),
          createElement(Tab, { id: "activity" }, "Activity"),
        ),
        createElement(TabPanel, { id: "overview" }, "Overview panel"),
        createElement(TabPanel, { id: "activity" }, "Activity panel"),
      ),
      createElement(
        Tabs,
        { orientation: "vertical", defaultSelectedKey: "profile" },
        createElement(
          TabList,
          { "aria-label": "Settings sections" },
          createElement(Tab, { id: "profile" }, "Profile"),
          createElement(Tab, { id: "preferences" }, "Preferences"),
        ),
        createElement(TabPanel, { id: "profile" }, "Profile panel"),
        createElement(TabPanel, { id: "preferences" }, "Preferences panel"),
      ),
      createElement(
        Slider,
        { defaultValue: 40, minValue: 0, maxValue: 100 },
        createElement(Label, null, "Temperature"),
        createElement(SliderTrack, null, createElement(SliderThumb)),
      ),
      createElement(
        ColorSlider,
        { channel: "hue", colorSpace: "hsl", defaultValue: initialColor },
        createElement(Label, null, "Hue"),
        createElement(ColorSliderTrack, null, createElement(ColorThumb)),
      ),
      createElement(
        ColorArea,
        {
          "aria-label": "Category color",
          colorSpace: "hsl",
          xChannel: "saturation",
          yChannel: "lightness",
          defaultValue: initialColor,
        },
        createElement(ColorThumb),
      ),
      createElement(
        ColorWheel,
        { "aria-label": "Category hue", outerRadius: 80, innerRadius: 56, defaultValue: initialColor },
        createElement(ColorWheelTrack),
        createElement(ColorThumb),
      ),
      createElement(
        ColorSwatchPicker,
        { "aria-label": "Suggested colors", value: initialColor },
        createElement(ColorSwatchPickerItem, { color: "#267fd9" }),
        createElement(ColorSwatchPickerItem, { color: "#9058c8" }),
        createElement(ColorSwatchPickerItem, { color: "#288263" }),
      ),
    ),
  );

  const allowBtn = await present<HTMLButtonElement>('[data-ui="button"]:not(:disabled)');
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const disabledBtn = document.querySelector<HTMLButtonElement>('[data-ui="button"]:disabled');
  if (!disabledBtn) throw new Error("Disabled button missing in design-system scene");
  const allowFace = face(allowBtn);
  const disabledFace = face(disabledBtn);
  if (allowFace.background === disabledFace.background) {
    throw new Error(`Disabled button matches active accent background: ${disabledFace.background}`);
  }

  const indicators = [...document.querySelectorAll<HTMLElement>(".gp-choice-indicator")];
  if (indicators.length < 4) throw new Error(`Expected >= 4 choice indicators, found ${indicators.length}`);
  const indicatorSizes = indicators.map((el) => {
    const rect = el.getBoundingClientRect();
    return `${Math.round(rect.width)}x${Math.round(rect.height)}`;
  });
  if (indicatorSizes.some((size) => size !== "16x16")) {
    throw new Error(`Collapsed or oversized choice indicator detected: ${indicatorSizes.join(", ")}`);
  }

  const hSelectedTab = document.querySelector<HTMLElement>(
    '[data-ui="tabs"]:not([data-orientation="vertical"]) [data-ui="tab"][data-selected]',
  );
  const hUnselectedTab = document.querySelector<HTMLElement>(
    '[data-ui="tabs"]:not([data-orientation="vertical"]) [data-ui="tab"]:not([data-selected])',
  );
  const vSelectedTab = document.querySelector<HTMLElement>(
    '[data-ui="tabs"][data-orientation="vertical"] [data-ui="tab"][data-selected]',
  );
  if (!hSelectedTab || !hUnselectedTab || !vSelectedTab) {
    throw new Error("Missing horizontal or vertical tab elements");
  }
  const hSelStyle = getComputedStyle(hSelectedTab);
  const hUnselStyle = getComputedStyle(hUnselectedTab);
  const vSelStyle = getComputedStyle(vSelectedTab);
  if (Number.parseFloat(hSelStyle.borderBottomWidth) < 2 || hSelStyle.backgroundColor === hUnselStyle.backgroundColor) {
    throw new Error("Horizontal selected tab lacks active highlight");
  }
  if (Number.parseFloat(vSelStyle.borderRightWidth) < 2) {
    throw new Error("Vertical selected tab lacks active right indicator");
  }

  const sliderFill = document.querySelector<HTMLElement>(".gp-slider-fill")?.getBoundingClientRect();
  const colorTrack = document.querySelector<HTMLElement>(".gp-color-slider-track")?.getBoundingClientRect();
  const colorArea = document.querySelector<HTMLElement>(".gp-color-area")?.getBoundingClientRect();
  const colorWheel = document.querySelector<HTMLElement>(".gp-color-wheel")?.getBoundingClientRect();
  const selectedSwatch = document.querySelector<HTMLElement>(".gp-color-swatch-item[data-selected]");
  if (!sliderFill || sliderFill.width <= 0 || sliderFill.height < 4) {
    throw new Error(`Slider fill collapsed: ${JSON.stringify(sliderFill?.toJSON() ?? null)}`);
  }
  if (!colorTrack || colorTrack.height < 20 || colorTrack.width < 120) {
    throw new Error(`Color slider track collapsed: ${JSON.stringify(colorTrack?.toJSON() ?? null)}`);
  }
  if (!colorArea || colorArea.width < 150 || colorArea.height < 120) {
    throw new Error(`Color area collapsed: ${JSON.stringify(colorArea?.toJSON() ?? null)}`);
  }
  if (!colorWheel || colorWheel.width < 150 || colorWheel.height < 150) {
    throw new Error(`Color wheel collapsed: ${JSON.stringify(colorWheel?.toJSON() ?? null)}`);
  }
  if (!selectedSwatch) throw new Error("Initial #267fd9 color swatch is not selected");

  return {
    allow: allowFace,
    disabled: disabledFace,
    indicatorSizes,
    horizontalSelectedTab: face(hSelectedTab),
    horizontalUnselectedTab: face(hUnselectedTab),
    verticalSelectedTab: face(vSelectedTab),
    selectedSwatchMatched: true,
    colorControlsReady: true,
  };
}

async function publishApproval() {
  try {
    const frame = await approve();
    await document.fonts.ready;
    const geometry = new URL(location.href).searchParams.has("audit")
      ? {
          viewport: { width: innerWidth, height: innerHeight },
          documentWidth: document.documentElement.scrollWidth,
          panels: [".user-text", ".composer-pill", ".composer-draft", ".gp-native-popover"].map((selector) => ({
            selector,
            box: document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null,
          })),
        }
      : undefined;
    document.querySelector("#result")!.textContent = JSON.stringify({ frame, ...(geometry ? { geometry } : {}) });
  } catch (error) {
    document.querySelector("#result")!.textContent = JSON.stringify({ error: String(error) });
  }
}
void publishApproval();
