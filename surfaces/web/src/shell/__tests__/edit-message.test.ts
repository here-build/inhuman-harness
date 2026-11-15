// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  SessionDocument,
  SessionSystemPrompt,
  SessionTurn,
  TurnPromptChunk,
  type UserVisualIdentity,
} from "@inhuman.tools/harness-model";
import { Tape } from "@inhuman.tools/harness-transcript";
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bindDraft, type DraftPicture, type DraftPocket, fillDraft } from "../draft-slot.js";
import {
  canEditMessages,
  editCut,
  editMessage,
  restoreMessages,
  restoreTarget,
  type EditClient,
} from "../edit-message.js";
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
    session: null as { root: SessionDocument["root"] } | null,
    sessionRpc: { request } as { request: typeof request } | null,
    follow: () => undefined,
    requestedTarget: { kind: "kernel" as const },
  },
}));

vi.mock("../../client/context.js", () => ({
  useDial: () => state.dial,
}));

vi.mock("@inhuman.tools/harness-transcript/context", () => ({
  useTranscriptHost: () => ({
    ...state.dial,
    canEditMessages: () => canEditMessages(state.dial as never),
    editMessage: (turn: SessionTurn) => editMessage(state.dial as never, turn),
  }),
}));

function pin(tail: SessionTurn | SessionSystemPrompt, text: string, live = false): SessionTurn {
  return new SessionTurn({
    turnTail: tail,
    prompt: prompt.user`${text}`,
    queue: live ? [new TurnPromptChunk()] : [],
    doneWork: [],
    reducerExited: !live,
  });
}

function seat(live = false): { doc: SessionDocument; first: SessionTurn; second: SessionTurn } {
  const doc = SessionDocument.create("edit", "/work/project");
  const first = pin(new SessionSystemPrompt(), "first");
  const second = pin(first, "second", live);
  doc.root.head = second;
  doc.root.tip = second;
  return { doc, first, second };
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

function client(root: SessionDocument["root"], rpc = request): EditClient {
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
    Reflect.deleteProperty(window, "ReactNativeWebView");
    window.history.replaceState(null, "", "/");
  });

  function hold(sessionId: string): void {
    release = bindDraft(sessionId, {
      state: pocket,
      refresh: () => undefined,
      focus: () => undefined,
    });
  }

  it("cuts to the previous pin and keeps the selected prompt", () => {
    const { doc, first, second } = seat();
    expect(editCut(second)).toEqual({ kind: "rewind", turnId: first.uuid, prompt: "second", visuals: [] });
    expect(editCut(first)).toEqual({ kind: "prefill", prompt: "first", visuals: [] });
    doc.destroy();
  });

  it("names the retained tip when head has moved off it", () => {
    const { doc, first, second } = seat();
    doc.root.rewindHead(first, second);
    expect(restoreTarget(first, doc.root.tip)).toBe(second.uuid);
    expect(restoreTarget(second, second)).toBeNull();
    doc.destroy();
  });

  it("rewinds before filling the draft, and leaves the draft when rewind is refused", async () => {
    const { doc, first, second } = seat();
    hold(doc.root.uuid);
    await editMessage(client(doc.root), second);
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket).toMatchObject({ draft: "second", status: "" });

    pocket.draft = "";
    request.mockResolvedValueOnce({ ok: false });
    await editMessage(client(doc.root), second);
    expect(pocket).toMatchObject({ draft: "", status: "That message could not be edited." });
    doc.destroy();
  });

  it("fills the first message without a rewind", async () => {
    const { doc, first } = seat();
    hold(doc.root.uuid);
    await editMessage(client(doc.root), first);
    expect(request).not.toHaveBeenCalled();
    expect(pocket.draft).toBe("first");
    doc.destroy();
  });

  it("restores the tip and clears a draft that is still the edited prompt", async () => {
    const { doc, first, second } = seat();
    doc.root.rewindHead(first, second);
    hold(doc.root.uuid);
    fillDraft(doc.root.uuid, "second", [chip]);
    const rpc = vi.fn(async () => {
      doc.root.rewindHead(second, second);
      return { ok: true };
    });
    await restoreMessages(client(doc.root, rpc), first, doc.root.tip);
    expect(rpc).toHaveBeenCalledWith("turn/rewind", { turnId: second.uuid });
    expect(pocket.draft).toBe("");
    expect(pocket.pictures).toEqual([]);
    expect(doc.root.head).toBe(second);
    doc.destroy();
  });

  it("keeps pictures when restore keeps a draft that was typed over", async () => {
    const { doc, first, second } = seat();
    doc.root.rewindHead(first, second);
    hold(doc.root.uuid);
    fillDraft(doc.root.uuid, "second", [chip]);
    pocket.draft = "kept";
    const rpc = vi.fn(async () => {
      doc.root.rewindHead(second, second);
      return { ok: true };
    });
    await restoreMessages(client(doc.root, rpc), first, doc.root.tip);
    expect(pocket.draft).toBe("kept");
    expect(pocket.pictures).toEqual([chip]);
    doc.destroy();
  });

  it("fetches every picture before rewind and refills the chips", async () => {
    const { doc, first, second } = seat();
    runInAction(() => {
      second.visuals = [shot];
    });
    hold(doc.root.uuid);
    request.mockImplementation(async (method) => {
      if (method === "turn/visual") return stored(shot);
      return { ok: true };
    });
    await editMessage(client(doc.root), second);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["turn/visual", "turn/rewind"]);
    expect(request).toHaveBeenCalledWith("turn/visual", { id: "pic-1" });
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket.draft).toBe("second");
    expect(pocket.pictures).toEqual([chip]);
    doc.destroy();
  });

  it("does not rewind or keep a text-only draft when a picture cannot be reopened", async () => {
    const { doc, second } = seat();
    runInAction(() => {
      second.visuals = [shot, { ...shot, id: "pic-2" }];
    });
    hold(doc.root.uuid);
    pocket.draft = "leave this";
    request.mockImplementation(async (method, params) => {
      if (method === "turn/visual" && paramId(params) === "pic-1") return stored(shot);
      if (method === "turn/visual") return { ok: false };
      return { ok: true };
    });
    await editMessage(client(doc.root), second);
    expect(request.mock.calls.map((call) => call[0])).toEqual(["turn/visual", "turn/visual"]);
    expect(pocket).toMatchObject({ draft: "leave this", pictures: [], status: "The picture could not be reopened." });
    doc.destroy();
  });

  it("posts the reopened draft to the native shell inside an embed", async () => {
    const { doc, first, second } = seat();
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
    hold(doc.root.uuid);
    request.mockImplementation(async (method) => (method === "turn/visual" ? stored(shot) : { ok: true }));
    await editMessage(client(doc.root), second);
    expect(request).toHaveBeenCalledWith("turn/rewind", { turnId: first.uuid });
    expect(pocket.draft).toBe("second");
    expect(pocket.pictures).toEqual([chip]);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0] ?? "")).toEqual({
      kind: "inhuman:edit-draft",
      prompt: "second",
      visuals: [stored(shot)],
    });
    doc.destroy();
  });
});

describe("edit control", () => {
  let container: HTMLDivElement;
  let view: Root;
  let open: SessionDocument | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    request.mockReset();
    request.mockResolvedValue({ ok: true });
    Reflect.deleteProperty(window, "ReactNativeWebView");
    window.history.replaceState(null, "", "/");
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
    const { doc, first, second } = seat();
    open = doc;
    const pocket: DraftPocket = { draft: "", pictures: [], revision: 0, status: "" };
    const unbind = bindDraft(doc.root.uuid, {
      state: pocket,
      refresh: () => undefined,
      focus: () => undefined,
    });
    state.dial.session = { root: doc.root };
    request.mockImplementation(async (method, params) => {
      if (method === "turn/rewind" && params != null && typeof params === "object" && "turnId" in params)
        doc.root.rewindHead(first, second);
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
    const { doc } = seat(true);
    open = doc;
    state.dial.session = { root: doc.root };
    await act(async () => {
      view.render(createElement(FilePreviewProvider, { resetKey: "edit" }, createElement(Tape)));
    });
    expect(container.querySelector("button.message-edit")).toBeNull();
    expect(container.textContent).toContain("second");
  });

  it("keeps the message on the tape when rewind is refused or no draft slot is bound", async () => {
    const { doc } = seat();
    open = doc;
    state.dial.session = { root: doc.root };
    await act(async () => {
      view.render(createElement(FilePreviewProvider, { resetKey: "edit" }, createElement(Tape)));
    });

    const editButton = () => [...container.querySelectorAll<HTMLButtonElement>("button.message-edit")].at(1);
    await act(async () => {
      editButton()?.click();
    });
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain("second");

    const pocket: DraftPocket = { draft: "keep", pictures: [], revision: 0, status: "" };
    const unbind = bindDraft(doc.root.uuid, {
      state: pocket,
      refresh: () => undefined,
      focus: () => undefined,
    });
    try {
      request.mockRejectedValueOnce(new Error("Rewind refused."));
      await act(async () => {
        editButton()?.click();
        await Promise.resolve();
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(pocket).toEqual({ draft: "keep", pictures: [], revision: 0, status: "Rewind refused." });
      expect(container.textContent).toContain("second");
    } finally {
      unbind();
    }
  });
});
