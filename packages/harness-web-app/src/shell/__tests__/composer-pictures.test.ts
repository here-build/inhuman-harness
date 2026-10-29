// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeObservable, observable } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";
import type { DraftPicture } from "../draft-slot.js";
import { admitStagedSession, peekSession, queueSession, resetNewSessions, stageOf } from "../new-session.js";
import { StageComposer } from "../stage-composer.js";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
);
const navigate = vi.hoisted(() => vi.fn(async (_target: { href: string }) => undefined));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

type Running = { uuid: string; cutOff: boolean; approvalHead: null } | null;

class PictureDial {
  attaching = false;
  link: unknown = null;
  readonly look = vi.fn();
  readonly prepareMint = vi.fn();
  readonly projects = new Map();
  project = null;
  requestedTarget: { kind: "project"; path: string } = { kind: "project", path: "/work/pictures" };
  kernelRpc = null;
  sessionRpc: { request: typeof request } | null = { request };
  kernel = {
    root: {
      approvalAskThrottleMs: 0,
      connections: {},
      drivers: {},
      bots: {},
      kvs: {},
      defaultPermissionMode: "manual",
      sessions: {},
    },
  };
  session: {
    root: {
      uuid: string;
      sessionId: string;
      path: string;
      head: null;
      tip: null;
      kvs: Record<string, string>;
      agent: { spec: null };
      permissionMode: "manual";
      findRunningTurn: () => Running;
    };
  } | null = null;

  constructor() {
    this.session = {
      root: {
        uuid: "root-1",
        sessionId: "s-1",
        path: "/work/pictures",
        head: null,
        tip: null,
        kvs: {},
        agent: { spec: null },
        permissionMode: "manual",
        findRunningTurn: () => null,
      },
    };
    makeObservable(this, {
      attaching: observable,
      link: observable.ref,
      sessionRpc: observable.ref,
      kernel: observable,
      session: observable.ref,
      requestedTarget: observable.ref,
    });
  }
}

const state: { dial: PictureDial | null } = vi.hoisted(() => ({ dial: null }));

vi.mock("../../client/context.js", () => ({
  useDial: () => {
    if (state.dial == null) throw new Error("dial missing");
    return state.dial;
  },
}));

const chip: DraftPicture = {
  key: "chip-1",
  mime: "image/png",
  bytesBase64: "aGVsbG8=",
  width: 2,
  height: 3,
  sourcePath: "shot.png",
};

let container: HTMLDivElement;
let view: Root;

function dial(): PictureDial {
  const current = state.dial;
  if (current == null) throw new Error("dial missing");
  return current;
}

function button(label: string): HTMLButtonElement {
  const node = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(node instanceof HTMLButtonElement)) throw new Error(label);
  return node;
}

async function render(node: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    view.render(node);
  });
}

async function typeDraft(value: string): Promise<void> {
  const field = container.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("draft missing");
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setValue == null) throw new Error("textarea value setter missing");
  await act(async () => {
    setValue.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function addFile(name: string, type: string): Promise<void> {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("file input missing");
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from([1, 2, 3, 4])], name, { type }));
  Object.defineProperty(input, "files", { configurable: true, value: data.files });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  await vi.waitFor(() => {
    if (container.querySelector(`button[aria-label="Remove ${base} · ${type}"]`) == null) {
      throw new Error(`waiting for ${type}`);
    }
  });
}

async function pasteImage(type: string): Promise<void> {
  const field = container.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("draft missing");
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from([9, 8, 7])], "from-clipboard.png", { type }));
  await act(async () => {
    field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data }));
  });
  await vi.waitFor(() => {
    if (container.querySelector(".composer-chip-preview") == null) throw new Error(`waiting for ${type}`);
  });
}

function turnCall(): unknown {
  const call = request.mock.calls.find((entry) => entry[0] === "turn");
  return call?.[1];
}

describe("composer pictures", () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    request.mockReset();
    request.mockResolvedValue({ ok: true });
    navigate.mockReset();
    navigate.mockResolvedValue(undefined);
    resetNewSessions();
    state.dial = new PictureDial();
    container = document.createElement("div");
    document.body.append(container);
    view = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      view.unmount();
    });
    container.remove();
    resetNewSessions();
  });

  it("adds a named chip from a window drop and sends it without a data url", async () => {
    await render(createElement(Composer));
    const input = container.querySelector('input[type="file"]');
    expect(input?.getAttribute("accept")).toBe("image/png,image/jpeg,image/gif,image/webp");
    await addFile("/tmp/shot.png", "image/png");
    expect(container.querySelector('button[aria-label="Remove shot.png · image/png"]')).not.toBeNull();
    await act(async () => {
      button("Send").click();
      await vi.waitFor(() => {
        if (turnCall() == null) throw new Error("turn pending");
      });
    });
    const sent = turnCall();
    expect(sent).toMatchObject({
      prompt: "",
      visuals: [{ mime: "image/png", sourcePath: "shot.png" }],
    });
    if (typeof sent !== "object" || sent == null || !("visuals" in sent) || !Array.isArray(sent.visuals)) {
      throw new Error("visuals missing");
    }
    const visual = sent.visuals[0];
    if (typeof visual !== "object" || visual == null || !("bytesBase64" in visual)) throw new Error("bytes missing");
    expect(typeof visual.bytesBase64).toBe("string");
    expect(String(visual.bytesBase64).startsWith("data:")).toBe(false);
    expect(container.querySelector('button[aria-label="Remove shot.png · image/png"]')).toBeNull();
  });

  it("outlines the field while a file is over the window and heats it over the field", async () => {
    await render(createElement(Composer));
    const pill = container.querySelector(".composer-pill");
    if (!(pill instanceof HTMLElement)) throw new Error("field missing");
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from([1])], "shot.png", { type: "image/png" }));
    await act(async () => {
      const entered = new DragEvent("dragenter", { bubbles: true, cancelable: true });
      Object.defineProperty(entered, "dataTransfer", { value: data });
      document.documentElement.dispatchEvent(entered);
    });
    expect(pill.dataset.drop).toBe("over");
    expect(pill.textContent).toContain("Drop here");
    expect(container.querySelector(".composer-file")?.className).toContain("sr-only");
    await act(async () => {
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(over, "dataTransfer", { value: data });
      pill.dispatchEvent(over);
    });
    expect(pill.dataset.drop).toBe("hot");
    await act(async () => {
      const dropped = new DragEvent("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(dropped, "dataTransfer", { value: data });
      document.documentElement.dispatchEvent(dropped);
    });
    await vi.waitFor(() => {
      if (container.querySelector('button[aria-label="Remove shot.png · image/png"]') == null) {
        throw new Error("waiting for image/png");
      }
    });
    expect(pill.dataset.drop).toBeUndefined();
    const preview = container.querySelector(".composer-chip-preview");
    expect(
      preview instanceof HTMLImageElement && preview.getAttribute("src")?.startsWith("data:image/png;base64,"),
    ).toBe(true);
    await act(async () => {
      button("shot.png · image/png").click();
    });
    const dialog = container.querySelector("dialog.picture-preview");
    expect(dialog instanceof HTMLDialogElement && dialog.open).toBe(true);
    expect(dialog?.querySelector("img")?.getAttribute("alt")).toBe("shot.png · image/png");
  });

  it("removes a chip and pastes an image without a source path", async () => {
    await render(createElement(Composer));
    await addFile("shot.png", "image/png");
    await act(async () => {
      button("Remove shot.png · image/png").click();
    });
    expect(container.querySelector('button[aria-label="Remove shot.png · image/png"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send"]')).toBeNull();
    await pasteImage("image/gif");
    expect(container.querySelector('button[aria-label="Remove image/gif"]')).not.toBeNull();
    await act(async () => {
      button("Send").click();
      await vi.waitFor(() => {
        if (turnCall() == null) throw new Error("turn pending");
      });
    });
    expect(turnCall()).toEqual({
      prompt: "",
      visuals: [{ mime: "image/gif", bytesBase64: "CQgH" }],
    });
  });

  it("keeps the text and the chips when the turn is refused", async () => {
    request.mockResolvedValue({ ok: false });
    await render(createElement(Composer));
    await typeDraft("look");
    await addFile("shot.png", "image/png");
    await act(async () => {
      button("Send").click();
    });
    await vi.waitFor(() => {
      if (!container.textContent.includes("Your draft is saved.")) throw new Error("pending");
    });
    const field = container.querySelector("textarea");
    expect(field instanceof HTMLTextAreaElement && field.value).toBe("look");
    expect(container.querySelector('button[aria-label="Remove shot.png · image/png"]')).not.toBeNull();
    const remove = button("Remove shot.png · image/png");
    expect(remove.querySelector("svg")).not.toBeNull();
    expect(remove.textContent.trim()).toBe("");
  });

  it("does not send a picture while a turn is live", async () => {
    await render(createElement(Composer));
    const session = dial().session;
    if (session == null) throw new Error("session missing");
    session.root.findRunningTurn = () => ({ uuid: "turn-1", cutOff: false, approvalHead: null });
    await addFile("shot.png", "image/png");
    expect(container.textContent).toContain("A picture stays in the draft while a turn is in progress.");
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
    const field = container.querySelector("textarea");
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("draft missing");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(turnCall()).toBeUndefined();
    expect(container.querySelector('button[aria-label="Remove shot.png · image/png"]')).not.toBeNull();
  });

  it("carries staged pictures onto the first turn", async () => {
    queueSession("s-1", { prompt: "", pictures: [chip], model: null, agent: "", permission: null });
    await render(createElement(Composer));
    await act(async () => {
      await vi.waitFor(() => {
        if (turnCall() == null) throw new Error("turn pending");
      });
    });
    expect(turnCall()).toEqual({
      prompt: "",
      visuals: [{ mime: "image/png", bytesBase64: "aGVsbG8=", sourcePath: "shot.png" }],
    });
    expect(peekSession("s-1")).toBeNull();
  });

  it("queues a picture-only stage and admits those bytes", async () => {
    await render(createElement(StageComposer, { path: "/work/pictures" }));
    await addFile("plain.webp", "image/webp");
    expect(button("Send").disabled).toBe(false);
    await act(async () => {
      button("Send").click();
      await vi.waitFor(() => {
        if (navigate.mock.calls.length === 0) throw new Error("navigate pending");
      });
    });
    if (navigate.mock.calls.length === 0) throw new Error("href missing");
    const hrefValue = navigate.mock.calls[0][0].href;
    const id = decodeURIComponent(hrefValue.slice(hrefValue.lastIndexOf("/") + 1));
    const queued = peekSession(id);
    expect(queued?.prompt).toBe("");
    expect(queued?.pictures[0]).toMatchObject({ mime: "image/webp", sourcePath: "plain.webp" });
    const rpc = vi.fn<(method: string, params: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
    if (queued == null) throw new Error("queue missing");
    await admitStagedSession(null, { request: rpc }, queued, []);
    const sent = rpc.mock.calls.find((call) => call[0] === "turn")?.[1];
    expect(sent).toMatchObject({ prompt: "", visuals: [{ mime: "image/webp", sourcePath: "plain.webp" }] });
    expect(stageOf("/work/pictures").pictures).toEqual([]);
    expect(stageOf("/work/pictures").draft).toBe("");
  });
});
