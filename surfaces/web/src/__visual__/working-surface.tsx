import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/monaspace-krypton/400.css";
import "@fontsource/monaspace-krypton/700.css";
import { ToolBodyView } from "@inhuman.tools/harness-transcript";

import { agents, agentWorkers, approval, conversation } from "../__stories__/scenes.js";
import { sessionStage, StoryApp } from "../__stories__/story-app.js";
import { PROJECT, worldOf } from "../__stories__/world.js";
import { Dialog, DropdownSelect } from "../components/ui/anchored.js";
import { stageOf } from "../shell/new-session.js";
import { projectHref } from "../shell/path.js";
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
  const stage =
    scenario === "transcript"
      ? sessionStage(agents, { workers: agentWorkers })
      : scenario === "approval"
        ? sessionStage(() => approval("shell"))
        : scenario === "agent"
          ? () => {
              stageOf(PROJECT).agent = "Code Reviewer";
              return { dial: worldOf([]), at: projectHref(PROJECT) };
            }
          : sessionStage(conversation);
  const root = createRoot(document.querySelector("#app")!);
  root.render(createElement(StoryApp, { stage }));

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
  if (scenario === "agent") {
    const trigger = await present<HTMLButtonElement>(".agent-trigger");
    trigger.focus();
    trigger.click();
    const name = await present<HTMLElement>('[role="menuitemradio"][data-key="Code Reviewer"] span');
    return { name: name.textContent, face: face(name), trigger: focus(trigger) };
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
