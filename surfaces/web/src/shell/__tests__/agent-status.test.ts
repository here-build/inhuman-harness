// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompletionJob, FailureOutcome } from "@inhuman.tools/harness-model";
import { Tape } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { userEvent, waitFor, within } from "storybook/test";
import { afterEach, expect, it, vi } from "vitest";

import { agentActivity } from "../../__stories__/scenes.js";
import { agent, session, speech, worldOf } from "../../__stories__/world.js";
import { DialProvider } from "../../client/context.js";
import { FilePreviewProvider } from "../file-sidebar.js";

let view: Root | null = null;
let container: HTMLDivElement | null = null;
let dispose = () => {};

afterEach(async () => {
  await act(async () => view?.unmount());
  container?.remove();
  dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a subagent's phases, retries and failures live in its open dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  const { parent, worker } = agentActivity();
  const dial = worldOf([parent], { peeks: () => [worker] });
  dispose = () => {
    parent.destroy();
    worker.destroy();
    for (const project of dial.projects.values()) project.destroy();
    dial.kernel?.destroy();
  };
  await dial.follow({ kind: "session", sessionId: parent.root.sessionId });
  container = document.createElement("div");
  document.body.append(container);
  view = createRoot(container);
  await act(async () =>
    view?.render(
      createElement(DialProvider, {
        dial: dial.asDial,
        children: createElement(FilePreviewProvider, { resetKey: parent.root.sessionId }, createElement(Tape)),
      }),
    ),
  );
  const user = userEvent.setup({ document });
  const note = await waitFor(() =>
    within(document.body).getByRole("button", { name: /explore.*Inspect the runtime lifecycle/i }),
  );
  await act(async () => user.click(note));
  const dialog = within(document.body).getByRole("dialog");
  const status = within(dialog).getByRole("status", { name: "Session activity" });
  expect(status.textContent).toContain("Waiting to retry");
  expect(status.textContent).toContain("3 / 15 unsuccessful foreground attempts");
  expect(status.textContent).toContain("Auto unavailable");
  expect(status.textContent).not.toContain("Waiting for agents");
  const turn = worker.root.head;
  const job = turn?.doneWork.find((node) => node instanceof CompletionJob);
  if (turn == null || job == null) throw new Error("The worker has no provider round");
  await act(async () =>
    runInAction(() => {
      job.expectation.retryUntilMs = null;
      job.expectation.phase = "thinking";
      delete worker.root.autoModeProblems["grok\ngrok-4.7"];
    }),
  );
  expect(status.textContent).toContain("Thinking");
  expect(status.textContent).not.toContain("Auto unavailable");
  await act(async () =>
    runInAction(() => {
      job.expectation.phase = "responding";
    }),
  );
  expect(status.textContent).toContain("Responding");
  await act(async () =>
    runInAction(() => {
      job.expectation.fail("settled", "The provider is unavailable", "null");
      turn.broke = "Stopped after 15 unsuccessful foreground attempts. Resume to try again.";
      turn.reducerExited = true;
    }),
  );
  expect(status.textContent).toContain("Turn stopped");
  expect(status.textContent).toContain("Stopped after 15 unsuccessful foreground attempts");
  expect(within(document.body).getByRole("dialog")).toBe(dialog);
});

it("collapses long delegated briefs on cancelled subagents and waits for close animations before releasing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
    this.open = true;
  });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
  const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

  const longPrompt = "Exact delegated instruction.\n".repeat(100);
  const worker = session({
    id: "cancelled-worker",
    turns: [
      { prompt: longPrompt, work: [speech("Actual agent activity.")] },
      { prompt: "Follow-up instruction.", work: [speech("Subsequent agent response.")] },
    ],
  });
  const call = agent("MixedCase Reviewer", "Review this change", {
    worker: worker.root.sessionId,
    background: false,
    live: true,
  });
  call.args = {
    spec: "MixedCase Reviewer",
    message: longPrompt,
    description: "Inspect the cancellation boundary. Internal description detail stays out of the note.",
  };
  const open = session({
    id: "cancelled-parent",
    turns: [{ prompt: "Delegate", live: true, work: [call] }],
  });
  const dial = worldOf([open], {
    workers: { [worker.root.sessionId]: { model: "grok-4.7-build-fast" } },
    peeks: () => [worker],
  });
  dispose = () => {
    open.destroy();
    worker.destroy();
    for (const project of dial.projects.values()) project.destroy();
    dial.kernel?.destroy();
  };
  await dial.follow({ kind: "session", sessionId: open.root.sessionId });

  const release = vi.fn();
  const peek = vi.spyOn(dial, "peek").mockResolvedValue({ doc: worker, release });

  container = document.createElement("div");
  document.body.append(container);
  view = createRoot(container);
  await act(async () =>
    view?.render(
      createElement(DialProvider, {
        dial: dial.asDial,
        children: createElement(FilePreviewProvider, { resetKey: open.root.sessionId }, createElement(Tape)),
      }),
    ),
  );

  const user = userEvent.setup({ document });
  await act(async () =>
    runInAction(() => {
      call.outcome = new FailureOutcome({ code: "cancelled", message: "The parent finished." });
      call.cancelled = true;
      call.completed = true;
      if (open.root.head != null) open.root.head.reducerExited = true;
    }),
  );

  const note = await waitFor(() => {
    const btn = within(document.body).getByRole("button", { name: /MixedCase Reviewer/ });
    expect(btn.dataset.state).toBe("cancelled");
    return btn;
  });
  expect(note.textContent).toContain("Inspect the cancellation boundary.");
  expect(note.textContent).not.toContain("Exact delegated instruction.");

  await act(async () => note.focus());
  await act(async () => user.keyboard("{Enter}"));
  const dialog = within(document.body).getByRole("dialog") as HTMLDialogElement;
  expect(dialog.dataset.state).toBe("cancelled");
  expect(peek).toHaveBeenCalledTimes(1);
  expect(within(dialog).getByText("Actual agent activity.")).toBeTruthy();

  const brief = within(dialog).getByRole("button", { name: "Delegated brief" });
  expect(brief.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    brief.focus();
    return user.keyboard("{Enter}");
  });
  expect(brief.getAttribute("aria-expanded")).toBe("true");
  await act(async () => user.click(within(dialog).getByRole("button", { name: "Copy brief" })));
  expect(copied).toHaveBeenCalledWith(longPrompt);
  expect(within(dialog).getByRole("status").textContent).toBe("Brief copied.");

  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  Object.defineProperty(dialog, "getAnimations", { value: () => [{ finished }] });
  await act(async () => dialog.close());
  expect(release).not.toHaveBeenCalled();
  expect(document.body.contains(dialog)).toBe(true);
  await act(async () => finish());
  expect(document.body.contains(dialog)).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
});
