// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, type UserVisualIdentity } from "@inhuman.tools/harness-model";
import { Tape } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindDraft, type DraftPicture, type DraftPocket, fillDraft } from "../draft-slot.js";
import { editCut, editMessage, restoreMessages, restoreTarget, type EditClient } from "../edit-message.js";
import { FilePreviewProvider } from "../file-sidebar.js";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
);

const state = vi.hoisted(() => ({
  dial: {
    link: null as unknown,
    attaching: false,
    kernel: { root: { connections: {} as Record<string, unknown>, sessions: {} } },
    project: null,
    session: null as { root: SessionPlexus["root"] } | null,
    sessionRpc: { request } as { request: typeof request } | null,
    follow: () => undefined,
    requestedTarget: { kind: "kernel" as const },
  },
}));

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

function pin(tail: SessionTurn | SessionSystemPrompt, text: string, live = false): SessionTurn {
  return new SessionTurn({
    turnTail: tail,
    prompt: prompt.user`${text}`,
    queue: [],
    doneWork: [],
    reducerExited: !live,
  });
}

function seat(live = false): { plexus: SessionPlexus; first: SessionTurn; second: SessionTurn } {
  const plexus = SessionPlexus.create("edit", "/work/project");
  const first = pin(new SessionSystemPrompt(), "first");
  const second = pin(first, "second", live);
  plexus.root.head = second;
  plexus.root.tip = second;
  return { plexus, first, second };
}

const shot: UserVisualIdentity = {
  id: "pic-1",
  mime: "image/png",
  width: 12,
  height: 8,
  resizedFrom: { width: 24, height: 16 },
  sourcePath: "shot.png",
};

const chip: DraftPicture = {
  key: "pic-1",
  mime: "image/png",
  bytesBase64: "aGVsbG8=",
  width: 12,
  height: 8,
  sourcePath: "shot.png",
};

function stored(visual: UserVisualIdentity, bytesBase64 = "aGVsbG8=") {
  return {
    id: visual.id,
    mime: visual.mime,
    bytesBase64,
    width: visual.width,
    height: visual.height,
    resizedFrom: visual.resizedFrom,
    sourcePath: visual.sourcePath,
  };
}

function paramId(params: unknown): string | null {
  if (typeof params !== "object" || params == null || !("id" in params)) return null;
  return typeof params.id === "string" ? params.id : null;
}

function client(root: SessionPlexus["root"], rpc = request): EditClient {
  return {
    attaching: false,
    link: null,
    session: { root },
    sessionRpc: { request: rpc },
  };
}

describe("edit cut", () => {
  let pocket: DraftPocket;
  let release: (() => void) | null = null;

  beforeEach(() => {
    request.mockReset();
    request.mockResolvedValue({ ok: true });
    pocket = { draft: "", pictures: [], revision: 0, status: "" };
    Reflect.deleteProperty(window, "ReactNativeWebView");
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    release?.();
    release = null;
  });

  function hold(sessionId: string): void {
    release = bindDraft(sessionId, {
      state: pocket,
      refresh: () => undefined,
      focus: () => undefined,
    });
  }

  it("cuts to the previous pin and keeps the selected prompt", () => {
    const { plexus, first, second } = seat();
    expect(editCut(second)).toEqual({ kind: "rewind", turnId: first.uuid, prompt: "second", visuals: [] });
    expect(editCut(first)).toEqual({ kind: "prefill", prompt: "first", visuals: [] });
    plexus.destroy();
  });

  it("names the retained tip when head has moved off it", () => {
    const { plexus, first, second } = seat();
    plexus.root.rewindHead(first, second);
    expect(restoreTarget(first, plexus.root.tip)).toBe(second.uuid);
    expect(restoreTarget(second, second)).toBeNull();
    plexus.destroy();
  });

  it("rewinds before filling the draft, and leaves the draft when rewind is refused", async () => {
    const { plexus, first, second } = seat();
    hold(plexus.root.uuid);
    await editMessage(client(plexus.root), second);
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket).toMatchObject({ draft: "second", status: "" });

    pocket.draft = "";
    request.mockResolvedValueOnce({ ok: false });
    await editMessage(client(plexus.root), second);
    expect(pocket).toMatchObject({ draft: "", status: "That message could not be edited." });
    plexus.destroy();
  });

  it("fills the first message without a rewind", async () => {
    const { plexus, first } = seat();
    hold(plexus.root.uuid);
    await editMessage(client(plexus.root), first);
    expect(request).not.toHaveBeenCalled();
    expect(pocket.draft).toBe("first");
    plexus.destroy();
  });

  it("restores the tip and clears a draft that is still the edited prompt", async () => {
    const { plexus, first, second } = seat();
    plexus.root.rewindHead(first, second);
    hold(plexus.root.uuid);
    fillDraft(plexus.root.uuid, "second", [chip]);
    const rpc = vi.fn(async () => {
      plexus.root.rewindHead(second, second);
      return { ok: true };
    });
    await restoreMessages(client(plexus.root, rpc), first, plexus.root.tip);
    expect(rpc).toHaveBeenCalledWith("turn/rewind", { turnId: second.uuid });
    expect(pocket.draft).toBe("");
    expect(pocket.pictures).toEqual([]);
    expect(plexus.root.head).toBe(second);
    plexus.destroy();
  });

  it("keeps pictures when restore keeps a draft that was typed over", async () => {
    const { plexus, first, second } = seat();
    plexus.root.rewindHead(first, second);
    hold(plexus.root.uuid);
    fillDraft(plexus.root.uuid, "second", [chip]);
    pocket.draft = "kept";
    const rpc = vi.fn(async () => {
      plexus.root.rewindHead(second, second);
      return { ok: true };
    });
    await restoreMessages(client(plexus.root, rpc), first, plexus.root.tip);
    expect(pocket.draft).toBe("kept");
    expect(pocket.pictures).toEqual([chip]);
    plexus.destroy();
  });

  it("fetches every picture before rewind and refills the chips", async () => {
    const { plexus, first, second } = seat();
    runInAction(() => {
      second.visuals = [shot];
    });
    hold(plexus.root.uuid);
    request.mockImplementation(async (method) => {
      if (method === "turn/visual") return stored(shot);
      return { ok: true };
    });
    await editMessage(client(plexus.root), second);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["turn/visual", "turn/rewind"]);
    expect(request).toHaveBeenCalledWith("turn/visual", { id: "pic-1" });
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket.draft).toBe("second");
    expect(pocket.pictures).toEqual([chip]);
    plexus.destroy();
  });

  it("does not rewind or keep a text-only draft when a picture cannot be reopened", async () => {
    const { plexus, second } = seat();
    runInAction(() => {
      second.visuals = [shot, { ...shot, id: "pic-2" }];
    });
    hold(plexus.root.uuid);
    pocket.draft = "leave this";
    request.mockImplementation(async (method, params) => {
      if (method === "turn/visual" && paramId(params) === "pic-1") return stored(shot);
      if (method === "turn/visual") return { ok: false };
      return { ok: true };
    });
    await editMessage(client(plexus.root), second);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["turn/visual", "turn/visual"]);
    expect(pocket).toMatchObject({ draft: "leave this", pictures: [], status: "The picture could not be reopened." });
    plexus.destroy();
  });

  it("posts the reopened draft to the native shell inside an embed", async () => {
    const { plexus, first, second } = seat();
    runInAction(() => {
      second.visuals = [shot];
    });
    window.history.replaceState(null, "", "/?embed=1");
    const messages: string[] = [];
    Object.defineProperty(window, "ReactNativeWebView", {
      configurable: true,
      value: {
        postMessage(body: string) {
          messages.push(body);
        },
      },
    });
    hold(plexus.root.uuid);
    request.mockImplementation(async (method) => (method === "turn/visual" ? stored(shot) : { ok: true }));
    await editMessage(client(plexus.root), second);
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket.draft).toBe("second");
    expect(pocket.pictures).toEqual([chip]);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0] ?? "")).toEqual({
      kind: "inhuman:edit-draft",
      prompt: "second",
      visuals: [stored(shot)],
    });
    plexus.destroy();
  });
});

describe("edit control", () => {
  let container: HTMLDivElement;
  let view: Root;
  let open: SessionPlexus | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    request.mockReset();
    request.mockResolvedValue({ ok: true });
    state.dial.attaching = false;
    state.dial.link = null;
    state.dial.sessionRpc = { request };
    state.dial.session = null;
    container = document.createElement("div");
    document.body.append(container);
    view = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      view.unmount();
    });
    container.remove();
    open?.destroy();
    open = null;
  });

  it("edits the later message from the tape", async () => {
    const { plexus, first, second } = seat();
    open = plexus;
    const pocket: DraftPocket = { draft: "", pictures: [], revision: 0, status: "" };
    const unbind = bindDraft(plexus.root.uuid, {
      state: pocket,
      refresh: () => undefined,
      focus: () => undefined,
    });
    state.dial.session = { root: plexus.root };
    request.mockImplementation(async (method, params) => {
      if (method === "turn/rewind" && params != null && typeof params === "object" && "turnId" in params)
        plexus.root.rewindHead(first, second);
      return { ok: true };
    });

    await act(async () => {
      view.render(createElement(FilePreviewProvider, { resetKey: "edit" }, createElement(Tape)));
    });
    const buttons = [...container.querySelectorAll("button.message-edit")];
    expect(buttons).toHaveLength(2);

    await act(async () => {
      (buttons[1] as HTMLButtonElement).click();
      await request.mock.results.at(-1)?.value;
    });

    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket.draft).toBe("second");
    expect(container.textContent).not.toContain("second");
    unbind();
  });

  it("hides edit while a turn is running", async () => {
    const { plexus } = seat(true);
    open = plexus;
    state.dial.session = { root: plexus.root };
    await act(async () => {
      view.render(createElement(FilePreviewProvider, { resetKey: "edit" }, createElement(Tape)));
    });
    expect(container.querySelector("button.message-edit")).toBeNull();
    expect(container.textContent).toContain("second");
  });
});
