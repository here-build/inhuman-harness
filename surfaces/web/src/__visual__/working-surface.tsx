import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/monaspace-krypton/400.css";
import "@fontsource/monaspace-krypton/700.css";
import { ToolBodyView } from "@inhuman.tools/harness-transcript";

import { agentActivity, agents, agentWorkers, approval, autoUnavailable, conversation } from "../__stories__/scenes.js";
import { sessionStage, StoryApp } from "../__stories__/story-app.js";
import { Dialog, DropdownSelect } from "../components/ui/anchored.js";
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

async function approve() {
  const query = new URL(location.href).searchParams;
  const scenario = query.get("scene") ?? "composer";
  const scheme = query.get("scheme");
  document.documentElement.dataset.scheme = scheme === "light" ? "light" : "dark";
  if (scenario.startsWith("fallback-")) return approveFallback(scenario, query.get("hold") === "1");
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

async function approveFallback(scenario: string, hold: boolean) {
  const manual = scenario === "fallback-popover";
  if (manual) Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  else {
    // Current Chromium no longer honors the removed CSSAnchorPositioning runtime
    // flag. Emulate only capability detection; layout and interaction remain real.
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: Parameters<typeof CSS.supports>) =>
      args[0].startsWith("position-anchor") || args[0].startsWith("position-area")
        ? false
        : supports(...args)) as typeof CSS.supports;
  }
  const anchors = CSS.supports("position-anchor: --gp-anchor");
  if (!manual && anchors) throw new Error("Anchor fallback check requires anchor capability emulated unavailable");
  const root = createRoot(document.querySelector("#app")!);
  root.render(
    createElement(Dialog, {
      isOpen: true,
      onOpenChange: () => undefined,
      label: "Settings",
      children: createElement(DropdownSelect, {
        label: "Provider",
        defaultValue: "one",
        options: [
          { id: "one", label: "First provider" },
          { id: "two", label: "Second provider" },
        ],
      }),
    }),
  );
  const trigger = await present<HTMLButtonElement>(".gp-anchored-trigger");
  trigger.focus();
  trigger.click();
  const panel = await present<HTMLElement>(".gp-native-popover");
  await document.fonts.ready;
  const box = panel.getBoundingClientRect();
  if (
    box.width <= 0 ||
    box.height <= 0 ||
    box.left < 0 ||
    box.top < 0 ||
    box.right > innerWidth ||
    box.bottom > innerHeight
  ) {
    throw new Error(`Fallback panel escapes viewport: ${JSON.stringify(box.toJSON())}`);
  }
  if (panel.closest("dialog[open]") == null) throw new Error("Fallback escaped the modal's non-inert subtree");
  const frame = { anchors, manual, contained: true, insideModal: true, position: getComputedStyle(panel).position };
  if (!hold) {
    (await present<HTMLElement>('[role="option"][data-key="two"]')).click();
    const until = Date.now() + 5_000;
    while (Date.now() < until && (document.activeElement !== trigger || document.querySelector(".gp-native-popover"))) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!trigger.textContent?.includes("Second provider") || document.querySelector(".gp-native-popover")) {
      throw new Error("Fallback provider selection did not close and update the field");
    }
    if (document.activeElement !== trigger)
      throw new Error(`Fallback did not restore focus: ${document.activeElement?.outerHTML}`);
  }
  return { ...frame, selected: hold ? "panel held open for review" : "Second provider" };
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
