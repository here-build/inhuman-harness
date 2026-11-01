// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ShellTerm } from "../shell/shell-term.js";
import type { ToolOutcome } from "../shell/tool-receipt.js";

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
  vi.unstubAllGlobals();
});
async function render(outcome: ToolOutcome = "ok") {
  await act(async () =>
    root.render(
      h(ShellTerm, { body: { kind: "shell", command: "cat MixedCase.ts", output: "Exact output" }, outcome }),
    ),
  );
  return within(container).getByRole("button", { name: /cat MixedCase.ts/ });
}

it("connects keyboard disclosure state and preserves a person's choice through live completion", async () => {
  const trigger = await render("live");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const panel = document.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-controls")}"]`)!;
  expect(panel.getAttribute("aria-labelledby")).toBe(trigger.id);
  await act(async () => {
    trigger.focus();
    await user.keyboard(" ");
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel.getAttribute("hidden")).toBe("until-found");
  await render("ok");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await render("failed");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await act(async () => user.keyboard("{Enter}"));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hasAttribute("hidden")).toBe(false);
});

it("reveals browser find matches through RAC state and keeps unpinned live auto expansion", async () => {
  const trigger = await render();
  const panel = document.querySelector<HTMLElement>(`[id="${trigger.getAttribute("aria-controls")}"]`)!;
  expect(panel.getAttribute("hidden")).toBe("until-found");
  await act(async () => panel.dispatchEvent(new Event("beforematch")));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(panel.getAttribute("aria-hidden")).toBe("false");
  expect(panel.hasAttribute("hidden")).toBe(false);
});

it("updates unpinned visibility when a shell receipt starts and completes", async () => {
  const trigger = await render();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  await render("live");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await render("ok");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
