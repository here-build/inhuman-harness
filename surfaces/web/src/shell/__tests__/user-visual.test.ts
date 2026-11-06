// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, type UserVisualIdentity } from "@inhuman.tools/harness-model";
import { BeatTimeline } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { groupBeats } from "../tape-beats.js";
import { projectTurn, type TapeCell } from "../tape-read.js";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
);

const state = vi.hoisted(() => {
  const dial: { sessionRpc: { request: typeof request } | null } = { sessionRpc: null };
  return { dial };
});

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

const shot: UserVisualIdentity = {
  id: "pic-1",
  mime: "image/png",
  width: 12,
  height: 8,
  resizedFrom: { width: 24, height: 16 },
  sourcePath: "shot.png",
};

function turn(text: string): SessionTurn {
  return new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`${text}`,
    queue: [],
    doneWork: [],
    reducerExited: true,
  });
}

async function renderCells(cells: readonly TapeCell[]): Promise<{ container: HTMLDivElement; view: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const view = createRoot(container);
  await act(async () => {
    view.render(createElement(BeatTimeline, { beats: groupBeats(cells), onOpen: () => undefined }));
  });
  return { container, view };
}

describe("picture cells", () => {
  const opened: SessionPlexus[] = [];

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    request.mockReset();
    request.mockResolvedValue({ ok: true });
    state.dial.sessionRpc = { request };
  });

  afterEach(() => {
    for (const plexus of opened) plexus.destroy();
    opened.length = 0;
  });

  function seat(text: string): SessionTurn {
    const plexus = SessionPlexus.create(`pics-${opened.length}`, "/work/project");
    opened.push(plexus);
    const seated = turn(text);
    plexus.root.head = seated;
    return seated;
  }

  it("keeps a user cell when the caption is empty and the turn has a picture", () => {
    const pictured = seat("");
    runInAction(() => {
      pictured.visuals = [shot];
    });
    expect(projectTurn(pictured, "/work/project").filter((cell) => cell.kind === "user")).toEqual([
      { kind: "user", id: `${pictured.uuid}:user`, text: "", visuals: [shot] },
    ]);
    const spoken = seat("hello");
    expect(projectTurn(spoken, "/work/project").find((cell) => cell.kind === "user")).toMatchObject({
      text: "hello",
      visuals: [],
    });
    expect(projectTurn(seat(""), "/work/project").some((cell) => cell.kind === "user")).toBe(false);
  });

  it("paints the identity line and a data url from turn/visual", async () => {
    request.mockResolvedValue({
      id: shot.id,
      mime: shot.mime,
      bytesBase64: "aGVsbG8=",
      width: shot.width,
      height: shot.height,
      resizedFrom: shot.resizedFrom,
      sourcePath: shot.sourcePath,
    });
    const { container, view } = await renderCells([
      { kind: "user", id: "user", text: "", visuals: [{ ...shot, sourcePath: "https://cdn.example/shot.png" }] },
    ]);
    const open = container.querySelector(
      'button[aria-label="Image 1 · image/png · 12×8 · resized from 24×16 · https://cdn.example/shot.png"]',
    );
    expect(open).not.toBeNull();
    expect(container.textContent).not.toContain("Image 1 ·");
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("data:image/png;base64,aGVsbG8=");
    expect(request).toHaveBeenCalledWith("turn/visual", { id: "pic-1" });
    expect(
      [...container.querySelectorAll("img")].every((node) => node.getAttribute("src")?.startsWith("data:") === true),
    ).toBe(true);
    await act(async () => {
      view.unmount();
    });
    container.remove();
  });

  it("keeps the identity line when the picture cannot be loaded", async () => {
    request.mockResolvedValue({
      id: shot.id,
      mime: "image/png",
      bytesBase64: "https://evil.example/shot.png",
      width: 12,
      height: 8,
      resizedFrom: null,
      sourcePath: null,
    });
    const { container, view } = await renderCells([{ kind: "user", id: "user", text: "see", visuals: [shot] }]);
    expect(container.querySelector(".user-picture")?.getAttribute("title")).toBe(
      "Image 1 · image/png · 12×8 · resized from 24×16 · shot.png",
    );
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {
      view.unmount();
    });
    container.remove();
  });
});
