// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CompletionJob } from "@inhuman.tools/harness-model";
import { Tape } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { userEvent, waitFor, within } from "storybook/test";
import { afterEach, expect, it, vi } from "vitest";

import { agentActivity } from "../../__stories__/scenes.js";
import { worldOf } from "../../__stories__/world.js";
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
