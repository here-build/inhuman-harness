// @vitest-environment happy-dom

import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tape } from "../../../harness-transcript/src/tape.js";
import { sessionStage } from "../__stories__/story-app.js";
import { session, type StoryDial } from "../__stories__/world.js";
import { DialProvider } from "../client/context.js";
import { bindDraft, type DraftPocket } from "../shell/draft-slot.js";
import { FilePreviewProvider } from "../shell/file-sidebar.js";
import { readTarget } from "../shell/path.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;
let dial: StoryDial;
let unbind: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  unbind?.();
  unbind = undefined;
  dial.session?.destroy();
  for (const project of dial.projects.values()) project.destroy();
  dial.kernel?.destroy();
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

async function fixture(options: { live?: boolean; refuse?: boolean; draft?: boolean; picture?: boolean } = {}) {
  const open = session({
    id: "transcript-controls",
    turns: [
      { prompt: "First Message", work: [] },
      { prompt: "Second Message", work: [], live: options.live },
    ],
  });
  const head = open.root.head!;
  const staged = sessionStage(() => open, { refuse: options.refuse })();
  dial = staged.dial;
  await dial.follow(readTarget(staged.at));
  const pocket: DraftPocket = { draft: "", pictures: [], revision: 0, status: "" };
  const focus = vi.fn();
  if (options.draft !== false) {
    unbind = bindDraft(open.root.uuid, { state: pocket, refresh: () => undefined, focus });
  }
  if (options.picture) {
    const visual = {
      id: "picture-1",
      mime: "image/png",
      width: 12,
      height: 8,
      resizedFrom: null,
      sourcePath: "MixedCase.png",
    };
    runInAction(() => {
      head.visuals = [visual];
    });
    const request = dial.sessionRpc!.request.bind(dial.sessionRpc);
    vi.spyOn(dial.sessionRpc!, "request").mockImplementation((method, params) =>
      method === "turn/visual" ? Promise.resolve({ ...visual, bytesBase64: "aGVsbG8=" }) : request(method, params),
    );
  }
  await render(
    h(DialProvider, {
      dial: dial.asDial,
      children: h(FilePreviewProvider, { resetKey: open.root.sessionId }, h(Tape)),
    }),
  );
  return { open, head, pocket, focus };
}

describe("transcript action controls", () => {
  it("keeps Edit a native button and hands a clicked message to the existing draft owner once", async () => {
    const { head, pocket, focus } = await fixture();
    const edit = within(container).getAllByRole("button", { name: "Edit" })[1]!;
    expect(edit.tagName).toBe("BUTTON");
    expect(edit.getAttribute("type")).toBe("button");
    expect(edit.classList.contains("label")).toBe(true);
    expect(edit.classList.contains("message-edit")).toBe(true);

    await interact(() => user.click(edit));

    expect(dial.calls).toEqual([{ method: "turn/rewind", params: { turnId: head.turnTail.uuid } }]);
    expect(pocket).toMatchObject({ draft: "Second Message", revision: 1, status: "" });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Second Message");
    // The tape delegates editing to the composer/native draft. It has no inline
    // textarea, Save or Cancel lifecycle to migrate or synthesize here.
    expect(within(container).queryByRole("textbox")).toBeNull();
    expect(within(container).queryByRole("button", { name: /^(Save|Cancel)$/ })).toBeNull();
  });

  it.each(["{Enter}", " "])("activates Edit once with native keyboard events: %s", async (key) => {
    const { pocket, focus } = await fixture();
    const edit = within(container).getAllByRole("button", { name: "Edit" })[0]!;
    await interact(() => user.tab());
    expect(document.activeElement).toBe(edit);
    await interact(() => user.keyboard(key));
    expect(pocket).toMatchObject({ draft: "First Message", revision: 1 });
    expect(focus).toHaveBeenCalledTimes(1);
    // Editing the first prompt only fills the draft; it does not cut the tape.
    expect(dial.calls).toEqual([]);
    expect(container.textContent).toContain("Second Message");
  });

  it("does not lose the message or steal draft focus when rewind is refused", async () => {
    const { pocket, focus } = await fixture({ refuse: true });
    const edit = within(container).getAllByRole("button", { name: "Edit" })[1]!;
    await interact(() => user.click(edit));
    expect(dial.calls).toHaveLength(1);
    expect(pocket).toMatchObject({ draft: "", revision: 0, status: "That message could not be edited." });
    expect(focus).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Second Message");
  });

  it("does not rewind when no draft owner is mounted", async () => {
    const { pocket, focus } = await fixture({ draft: false });
    await interact(() => user.click(within(container).getAllByRole("button", { name: "Edit" })[1]!));
    expect(dial.calls).toEqual([]);
    expect(pocket.revision).toBe(0);
    expect(focus).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Second Message");
  });

  it("keeps messages read-only while a turn is running", async () => {
    await fixture({ live: true });
    expect(within(container).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(container.textContent).toContain("Second Message");
  });

  it("retains the picture action's name and native dialog close event", async () => {
    // happy-dom does not implement top-layer modality. Leave lifecycle ownership
    // with the native dialog; only stand in for that platform method here.
    vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    await fixture({ picture: true });
    const picture = within(container).getByRole("button", { name: /MixedCase\.png/ });
    expect(picture.classList.contains("user-picture-open")).toBe(true);
    expect(picture.classList.contains("touch-target")).toBe(true);
    await interact(() => user.click(picture));
    const dialog = within(container).getByRole("dialog", { name: /MixedCase\.png/ });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    await interact(() => dialog.dispatchEvent(new Event("close", { bubbles: false })));
    expect(within(container).queryByRole("dialog")).toBeNull();
  });
});
