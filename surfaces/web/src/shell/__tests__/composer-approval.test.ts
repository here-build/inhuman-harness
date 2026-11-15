// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionDocument, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { makeObservable, observable, runInAction } from "mobx";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../composer.js";

const request = vi.hoisted(() =>
  vi.fn<(method: string, params: unknown) => Promise<unknown>>(async () => ({ ok: true })),
);
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => undefined) }),
}));

class ApprovalDial {
  attaching = false;
  link = null;
  readonly look = vi.fn();
  project = null;
  requestedTarget = { kind: "kernel" } as const;
  kernel = {
    root: {
      approvalAskThrottleMs: 1000,
      connections: {},
      drivers: {},
      bots: {},
      kvs: {},
      defaultPermissionMode: "manual",
    },
  };
  sessionRpc = { request };
  session: SessionDocument;

  constructor(session: SessionDocument) {
    this.session = session;
    makeObservable(this, {
      attaching: observable,
      link: observable.ref,
      sessionRpc: observable.ref,
      session: observable.ref,
    });
  }
}

const state: { dial: ApprovalDial | null } = vi.hoisted(() => ({ dial: null }));
vi.mock("../../client/context.js", () => ({
  useDial: () => {
    if (state.dial == null) throw new Error("dial missing");
    return state.dial;
  },
}));

function makeAskedJob(id: string, path: string): SystemToolJob {
  const leaf = new SystemToolJob({
    toolCallId: id,
    name: "write_file",
    argsJson: JSON.stringify({ path, content: "next" }),
  });
  leaf.stampPolicy("ask", null, null, {
    classesJson: '["workspace-write"]',
    votesJson: JSON.stringify([
      { disposition: "ask", class: "workspace-write", ruleId: "w", path: { cluster: "write", path } },
    ]),
  });
  return leaf;
}

let container: HTMLDivElement;
let root: Root;
let doc: SessionDocument;
let firstLeaf: SystemToolJob;
let secondLeaf: SystemToolJob;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(Composer));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  request.mockReset();
  doc = SessionDocument.create("s-approval", "/work");
  firstLeaf = makeAskedJob("call-1", "src/a.ts");
  secondLeaf = makeAskedJob("call-2", "src/b.ts");
  runInAction(() => {
    doc.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`update files`,
      queue: [firstLeaf, secondLeaf],
    });
  });
  state.dial = new ApprovalDial(doc);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  doc.destroy();
});

describe("composer approval cover", () => {
  it("shows Sending decision…, keeps comment on failure without re-throttling, and dismisses cleanly on { ok: true }", async () => {
    const firstPending = Promise.withResolvers<unknown>();
    request.mockImplementationOnce(() => firstPending.promise);

    await render();
    const user = userEvent.setup({ document });

    const commentBox = within(container).getByPlaceholderText<HTMLTextAreaElement>("Optional comment");
    await act(async () => {
      await user.type(commentBox, "looks safe");
    });
    expect(commentBox.value).toBe("looks safe");

    const allowBtn = within(container).getByRole<HTMLButtonElement>("button", { name: "Allow" });
    const denyBtn = within(container).getByRole<HTMLButtonElement>("button", { name: "Deny" });
    expect(allowBtn.disabled).toBe(false);

    // 1. In-flight RPC shows Sending decision… and disables controls without reverting to throttle copy.
    await act(async () => {
      allowBtn.click();
    });
    expect(container.textContent).toContain("Sending decision…");
    expect(container.textContent).not.toContain("Decisions unlock after a short pause.");
    expect(allowBtn.disabled).toBe(true);
    expect(denyBtn.disabled).toBe(true);
    expect(commentBox.disabled).toBe(true);

    // 2. Daemon rejection / { ok: false } preserves comment and immediately re-arms Allow / Deny.
    await act(async () => {
      firstPending.resolve({ ok: false });
      await firstPending.promise;
    });
    expect(container.textContent).toContain("Decision was not accepted.");
    expect(container.textContent).not.toContain("Decisions unlock after a short pause.");
    expect(commentBox.value).toBe("looks safe");
    expect(allowBtn.disabled).toBe(false);
    expect(denyBtn.disabled).toBe(false);

    // 3. Thrown RPC error also keeps comment intact and re-enables Allow / Deny.
    const secondPending = Promise.withResolvers<unknown>();
    request.mockImplementationOnce(() => secondPending.promise);
    await act(async () => {
      allowBtn.click();
    });
    expect(container.textContent).toContain("Sending decision…");
    await act(async () => {
      secondPending.reject(new Error("socket closed"));
      await secondPending.promise.catch(() => undefined);
    });
    expect(container.textContent).toContain("socket closed");
    expect(commentBox.value).toBe("looks safe");
    expect(allowBtn.disabled).toBe(false);
    expect(denyBtn.disabled).toBe(false);

    // 4. { ok: true } immediately dismisses the cover even before replica humanApprove updates.
    const thirdPending = Promise.withResolvers<unknown>();
    request.mockImplementationOnce(() => thirdPending.promise);
    await act(async () => {
      allowBtn.click();
    });
    await act(async () => {
      thirdPending.resolve({ ok: true });
      await thirdPending.promise;
    });
    expect(within(container).queryByRole("button", { name: "Allow" })).toBeNull();
    expect(container.textContent).not.toContain("Sending decision…");

    // 5. When the first leaf settles and the second queued ask becomes approvalHead, its cover renders and arms.
    await act(async () => {
      runInAction(() => {
        firstLeaf.humanApprove = true;
      });
    });
    expect(doc.root.findRunningTurn()?.approvalHead?.uuid).toBe(secondLeaf.uuid);
    const nextAllow = within(container).getByRole<HTMLButtonElement>("button", { name: "Allow" });
    expect(nextAllow.disabled).toBe(false);
    expect(container.textContent).toContain("src/b.ts");
  });
});
