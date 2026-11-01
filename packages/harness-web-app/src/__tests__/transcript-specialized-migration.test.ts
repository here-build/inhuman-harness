// @vitest-environment happy-dom

import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FailureOutcome } from "@inhuman.tools/harness-model";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tape } from "../../../harness-transcript/src/tape.js";
import { sessionStage } from "../__stories__/story-app.js";
import { agent, read, session, speech, tool, write, type StoryDial } from "../__stories__/world.js";
import { DialProvider } from "../client/context.js";
import { FilePreviewProvider, useFilePreview } from "../shell/file-sidebar.js";
import { readTarget } from "../shell/path.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
let dial: StoryDial;
let openPopovers: WeakSet<Element>;
let hovered: WeakSet<Element>;
let destroyWorker: (() => void) | undefined;
const popoverDescriptors = ["showPopover", "hidePopover"].map(
  (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const,
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
  openPopovers = new WeakSet();
  hovered = new WeakSet();
  // happy-dom lacks top-layer placement. Model only native open state and
  // pointer ownership; the real Tape still owns the delay and focus checks.
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector) {
    if (selector === ":popover-open") return openPopovers.has(this);
    if (selector === ":hover") return hovered.has(this);
    return matches.call(this, selector);
  });
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value(this: HTMLElement) {
      openPopovers.add(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    value(this: HTMLElement) {
      openPopovers.delete(this);
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  dial?.session?.destroy();
  for (const project of dial?.projects.values() ?? []) project.destroy();
  dial?.kernel?.destroy();
  destroyWorker?.();
  destroyWorker = undefined;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [name, descriptor] of popoverDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  vi.unstubAllGlobals();
});

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

function PreviewReceipt() {
  const { file } = useFilePreview();
  return h("output", { "aria-label": "Opened file" }, file == null ? "" : JSON.stringify(file));
}

async function fixture(withAgent = false, cancelled = false) {
  const worker = session({
    id: "specialized-worker",
    turns: cancelled
      ? [
          { prompt: "Exact delegated instruction.\n".repeat(100), work: [speech("Actual agent activity.")] },
          { prompt: "Follow-up instruction.", work: [speech("Subsequent agent response.")] },
        ]
      : [{ prompt: "Worker Message", work: [] }],
  });
  const call = agent("MixedCase Reviewer", "Review this change", { worker: worker.root.sessionId });
  if (cancelled) call.outcome = new FailureOutcome({ code: "cancelled", message: "The parent finished." });
  destroyWorker = () => worker.destroy();
  const open = session({
    id: "specialized-controls",
    turns: [
      {
        prompt: "Inspect the files",
        work: withAgent
          ? [call]
          : [
              read("src/MixedCase.ts", "export const Result = 1;"),
              read("archive.zip", "binary"),
              tool("list_dir", { path: "PendingDirectory" }, { live: true }),
              read("Missing.ts", "Permission denied while reading.", { failed: true }),
              write("Locked.ts", "replacement", { failed: "The file is read-only." }),
              speech("Finished inspecting.", { model: "grok-4.7-build-fast", thought: "Reasoning remains readable." }),
            ],
      },
    ],
  });
  const staged = sessionStage(() => open, {
    workers: { [worker.root.sessionId]: { model: "grok-4.7-build-fast" } },
    peeks: () => [worker],
  })();
  dial = staged.dial;
  await dial.follow(readTarget(staged.at));
  await interact(() =>
    root.render(
      h(DialProvider, {
        dial: dial.asDial,
        children: h(FilePreviewProvider, { resetKey: open.root.sessionId }, h(Tape), h(PreviewReceipt)),
      }),
    ),
  );
  return { worker };
}

function button(name: string | RegExp) {
  return within(container).getByRole("button", { name }) as HTMLButtonElement;
}
function explanation(trigger: HTMLElement) {
  return document.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-describedby")}"]`)!;
}
async function pointer(node: Element, entering: boolean) {
  if (entering) hovered.add(node);
  else hovered.delete(node);
  await interact(() =>
    node.dispatchEvent(new PointerEvent(entering ? "pointerover" : "pointerout", { bubbles: true })),
  );
}

// These exercise the real TapeView, reducer receipts, preview owner and worker
// room. No private transcript control is exported just for the tests.
describe("specialized transcript controls", () => {
  it.each(["click", "{Enter}", " "])("opens an exact-case read target once with %s", async (activation) => {
    await fixture();
    const target = button("src/MixedCase.ts");
    expect(target.tagName).toBe("BUTTON");
    expect(target.classList.contains("read-path")).toBe(true);
    expect(target.title).toBe("src/MixedCase.ts");
    if (activation === "click") await interact(() => user.click(target));
    else {
      await interact(() => target.focus());
      await interact(() => user.keyboard(activation));
    }
    expect(JSON.parse(within(container).getByLabelText("Opened file").textContent!)).toEqual({
      path: "src/MixedCase.ts",
      label: "src/MixedCase.ts",
      text: "export const Result = 1;",
    });
    expect(dial.calls).toEqual([]);
    expect(within(container).getByText("Grok 4.7 Build Fast").classList.contains("mono")).toBe(false);
  });

  it("keeps binary and not-yet-available listing targets disabled", async () => {
    await fixture();
    const binary = button("archive.zip");
    const missing = button("PendingDirectory/");
    expect(binary.disabled).toBe(true);
    expect(binary.title).toBe("archive.zip (binary)");
    expect(missing.disabled).toBe(true);
    await interact(() => user.click(binary));
    await interact(() => user.click(missing));
    expect(within(container).getByLabelText("Opened file").textContent).toBe("");
    expect(within(container).queryByRole("button", { name: "Missing.ts" })).toBeNull();
  });

  it("associates distinct failed reads and writes with their own explanation and allows failed-write file opening", async () => {
    await fixture();
    const readFailure = button("Why this failed: Missing.ts");
    const writeFailure = button("Why this failed: write Locked.ts");
    expect(readFailure.getAttribute("aria-describedby")).not.toBe(writeFailure.getAttribute("aria-describedby"));
    expect(explanation(readFailure).textContent).toBe("Permission denied while reading.");
    expect(explanation(writeFailure).textContent).toBe("The file is read-only.");
    expect(explanation(readFailure).getAttribute("popover")).toBe("manual");
    expect(explanation(readFailure).getAttribute("role")).toBe("tooltip");
    expect(explanation(readFailure).parentElement!.style.getPropertyValue("--fail-anchor")).toMatch(/^--fail-/);
    const target = button("Locked.ts");
    expect(target.classList.contains("read-path")).toBe(true);
    await interact(() => user.click(target));
    expect(JSON.parse(within(container).getByLabelText("Opened file").textContent!)).toEqual({
      path: "Locked.ts",
      label: "Locked.ts",
    });
  });

  it("keeps hover ownership while crossing to the native tip, then hides after its original delay", async () => {
    await fixture();
    vi.useFakeTimers();
    const trigger = button("Why this failed: Missing.ts");
    const tip = explanation(trigger);
    await pointer(trigger, true);
    expect(openPopovers.has(tip)).toBe(true);
    await pointer(trigger, false);
    await interact(() => vi.advanceTimersByTime(119));
    expect(openPopovers.has(tip)).toBe(true);
    await pointer(tip, true);
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(tip)).toBe(true);
    await pointer(tip, false);
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(tip)).toBe(false);
  });

  it("keeps focus ownership across the tip and dismisses immediately on Escape without moving focus", async () => {
    await fixture();
    const trigger = button("Why this failed: Missing.ts");
    const tip = explanation(trigger);
    await interact(() => trigger.focus());
    expect(openPopovers.has(tip)).toBe(true);
    await interact(() => user.keyboard("{Escape}"));
    expect(openPopovers.has(tip)).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await interact(() => user.keyboard("{Enter}"));
    expect(openPopovers.has(tip)).toBe(true);
    vi.useFakeTimers();
    // Long explanations can contain a focused descendant without the trigger
    // reclaiming ownership. Focus departure from that descendant must also hide.
    const link = document.createElement("a");
    link.href = "#error-help";
    link.textContent = "Error help";
    tip.append(link);
    await interact(() => link.focus());
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(tip)).toBe(true);
    await interact(() => button("src/MixedCase.ts").focus());
    await interact(() => vi.advanceTimersByTime(120));
    expect(openPopovers.has(tip)).toBe(false);
  });

  it("opens an explanation on a touch press without requiring hover or focus", async () => {
    await fixture();
    const trigger = button("Why this failed: Missing.ts");
    await interact(() => user.pointer([{ keys: "[TouchA>]", target: trigger }, { keys: "[/TouchA]" }]));
    expect(openPopovers.has(explanation(trigger))).toBe(true);
  });

  it("keeps wide reasoning accessible and remembers the narrow disclosure choice across resize", async () => {
    const observations: { target: Element; resize: (entries: ResizeObserverEntry[]) => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(readonly resize: (entries: ResizeObserverEntry[]) => void) {}
        observe(target: Element) {
          observations.push({ target, resize: this.resize });
        }
        unobserve() {}
        disconnect() {}
      },
    );
    container.classList.add("tape");
    await fixture();
    const reasoning = button("Reasoning");
    const panel = document.querySelector<HTMLElement>(`[id="${reasoning.getAttribute("aria-controls")}"]`)!;
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    const observer = observations.find((entry) => entry.target === container)!;
    const resize = async (width: number) => {
      await interact(() => observer.resize([{ contentRect: { width } } as ResizeObserverEntry]));
    };
    await resize(600);
    expect(reasoning.getAttribute("aria-expanded")).toBe("false");
    await interact(() => {
      reasoning.focus();
      return user.keyboard("{Enter}");
    });
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    await resize(1200);
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    await resize(600);
    expect(reasoning.getAttribute("aria-expanded")).toBe("true");
    await interact(() => user.keyboard(" "));
    await resize(1200);
    expect(panel.getAttribute("aria-hidden")).toBe("false");
    await resize(600);
    expect(reasoning.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows cancellation and actual activity before a long brief, preserving exact copy and later messages", async () => {
    await fixture(true, true);
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.open = true;
    });
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await interact(() => user.click(button(/MixedCase Reviewer/)));
    const dialog = within(document.body).getByRole("dialog");
    expect(dialog.dataset.state).toBe("cancelled");
    expect(within(dialog).getByText("Cancelled: The parent finished.")).toBeTruthy();
    expect(within(dialog).getByText("Actual agent activity.")).toBeTruthy();
    expect(within(dialog).getByText("Follow-up instruction.")).toBeTruthy();
    expect(within(dialog).getByText("Subsequent agent response.")).toBeTruthy();
    const brief = within(dialog).getByRole("button", { name: "Delegated brief" });
    expect(brief.getAttribute("aria-expanded")).toBe("false");
    const panel = document.querySelector<HTMLElement>(`[id="${brief.getAttribute("aria-controls")}"]`)!;
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    await interact(() => {
      brief.focus();
      return user.keyboard("{Enter}");
    });
    expect(brief.getAttribute("aria-expanded")).toBe("true");
    const original = "Exact delegated instruction.\n".repeat(100);
    expect(within(dialog).getByRole("region", { name: "Delegated brief" }).dataset.copy).toBe(original);
    await interact(() => user.click(within(dialog).getByRole("button", { name: "Copy brief" })));
    expect(copied).toHaveBeenCalledWith(original);
    expect(within(dialog).getByRole("status").textContent).toBe("Brief copied.");
    expect(container.querySelector(".agent-brief")).toBeNull();
  });

  it("opens an agent through keyboard semantics and releases only after native close animation settles", async () => {
    const { worker } = await fixture(true);
    const release = vi.fn();
    const peek = vi.spyOn(dial, "peek").mockResolvedValue({ plexus: worker, release });
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.open = true;
    });
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    });
    const note = button(/MixedCase Reviewer/);
    expect(note.classList.contains("agent-note")).toBe(true);
    expect(note.querySelector(".agent-name")!.classList.contains("label")).toBe(false);
    expect(note.querySelector(".mono")).toBeNull();
    await interact(() => note.focus());
    await interact(() => user.keyboard("{Enter}"));
    const dialog = within(document.body).getByRole("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(within(dialog).getByRole("region", { name: "Agent result" }).textContent).toContain("done");
    expect(within(dialog).getByText("Completed")).toBeTruthy();
    expect(dialog.querySelector(".agent-peek-who .label, .agent-peek-who .mono")).toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector(".agent-peek-tape"));
    expect(peek).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(dialog, "getAnimations", { value: () => [{ finished }] });
    const close = within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement;
    expect(close.type).toBe("submit");
    expect(close.form!.getAttribute("method")).toBe("dialog");
    // A browser's method=dialog submission/native Escape emits close. The DOM
    // shim intentionally does not replace the component's lifecycle with RAC.
    await interact(() => dialog.close());
    expect(release).not.toHaveBeenCalled();
    expect(document.body.contains(dialog)).toBe(true);
    await interact(finish);
    expect(document.body.contains(dialog)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
