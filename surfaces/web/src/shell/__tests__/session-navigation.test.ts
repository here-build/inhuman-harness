// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  KernelDocument,
  KernelRoot,
  ProjectDocument,
  SessionDocument,
  SessionOverview,
} from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileSidebar } from "../file-sidebar.js";
import { sessionHref } from "../path.js";
import { SessionRail } from "../rail-sessions.js";

const state = vi.hoisted(() => ({ dial: null as unknown }));
vi.mock("../../client/context.js", () => ({ useDial: () => state.dial }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function railWorld() {
  const sessions = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `s${index}`,
      { title: index === 0 ? "Autumn campaign launch" : `Session ${index}`, status: "", lastMessageAt: index },
    ]),
  );
  const project = { root: { path: "/work", sessions, botsRoster: {} } };
  state.dial = {
    kernel: { root: { projects: { "/work": {} }, sessions, botsRoster: {} } },
    projects: new Map([["/work", project]]),
    project,
    session: null,
    link: null,
  };
}

async function renderRail(kind: "overview" | "project", go = vi.fn(), onMint = vi.fn()) {
  await act(async () => {
    root.render(
      createElement(SessionRail, {
        pane: kind === "overview" ? { kind } : { kind, path: "/work" },
        selectedSessionId: "s0",
        go,
        onMint,
      }),
    );
  });
}

describe("session navigation migration", () => {
  it.each([
    ["overview", false],
    ["project", false],
    ["overview", true],
    ["project", true],
  ] as const)("updates the selected %s row title without remounting (attached: %s)", async (kind, attached) => {
    const overview = new SessionOverview({ title: "Original title", lastMessageAt: Date.now() });
    const kernel = KernelDocument.create(new KernelRoot({ projects: { "/work": "" }, sessions: { s0: overview } }));
    const project = ProjectDocument.create("/work");
    const session = attached ? SessionDocument.create("s0", "/work") : null;
    runInAction(() => {
      project.root.sessions.s0 = "";
      if (session != null) session.root.manualTitle = "Original title";
    });
    state.dial = { kernel, projects: new Map([["/work", project]]), project, session, link: null };
    try {
      await renderRail(kind);
      expect(container.querySelector("a")?.textContent).toContain("Original title");
      await act(async () => {
        runInAction(() => {
          if (session != null) session.root.manualTitle = "Updated title";
          else overview.title = "Updated title";
        });
      });
      expect(container.querySelector("a")?.textContent).toContain("Updated title");
    } finally {
      await act(async () => root.unmount());
      kernel.destroy();
      project.destroy();
      session?.destroy();
    }
  });

  it.each(["overview", "project"] as const)(
    "adds and removes %s sessions live before metadata arrives",
    async (kind) => {
      const kernel = KernelDocument.create(new KernelRoot({ projects: { "/work": "" } }));
      const project = ProjectDocument.create("/work");
      const overview = new SessionOverview();
      state.dial = { kernel, projects: new Map([["/work", project]]), project, session: null, link: null };
      try {
        await renderRail(kind);
        expect(container.querySelectorAll("a")).toHaveLength(0);
        await act(async () => {
          runInAction(() => {
            project.root.sessions.new = "";
            kernel.root.sessions.new = overview;
          });
        });
        expect(container.querySelectorAll("a")).toHaveLength(0);
        await act(async () => {
          runInAction(() => {
            overview.lastPrompt = "First message";
          });
        });
        expect(container.querySelector("a")?.textContent).toContain("First message");
        await act(async () => {
          runInAction(() => {
            delete project.root.sessions.new;
          });
        });
        expect(container.querySelectorAll("a")).toHaveLength(0);
      } finally {
        await act(async () => root.unmount());
        kernel.destroy();
        project.destroy();
      }
    },
  );

  it.each(["overview", "project"] as const)(
    "labels the %s search and supports filtering and clearing",
    async (kind) => {
      railWorld();
      await renderRail(kind);
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      const label = container.querySelector("label")!;
      expect(label.textContent).toBe("Filter sessions");
      expect(label.htmlFor).toBe(input.id);
      expect(container.querySelectorAll("a")).toHaveLength(9);
      await type(input, "Autumn");
      expect(container.querySelectorAll("a")).toHaveLength(1);
      expect(container.querySelector("a")?.textContent).toContain("Autumn campaign launch");
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(input.value).toBe("");
      expect(container.querySelectorAll("a")).toHaveLength(9);
    },
  );

  it("retains real links, modified-click browser behavior, selection and independent creation", async () => {
    railWorld();
    const go = vi.fn();
    const onMint = vi.fn();
    await renderRail("project", go, onMint);
    const row = container.querySelector<HTMLAnchorElement>('a[aria-current="page"]')!;
    expect(row.getAttribute("href")).toBe(sessionHref("/work", "s0"));
    expect(row.className).toContain("aria-[current=page]:border-selection-marker");
    expect(row.className).toContain("aria-[current=page]:bg-selected");
    expect(row.className).toContain("focus-visible:outline-focus");
    expect(row.classList.contains("label")).toBe(false);
    await act(async () => row.focus());
    expect(document.activeElement).toBe(row);
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, [modifier]: true });
      await act(async () => {
        row.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
    }
    expect(go).not.toHaveBeenCalled();
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => {
      row.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(go).toHaveBeenCalledExactlyOnceWith(sessionHref("/work", "s0"));
    const create = container.querySelector<HTMLButtonElement>('button[aria-label="New session in work"]')!;
    await act(async () => create.focus());
    expect(document.activeElement).toBe(create);
    await act(async () => create.click());
    expect(onMint).toHaveBeenCalledExactlyOnceWith("/work");
    expect(go).toHaveBeenCalledTimes(1);
  });
});

describe("file preview recovery", () => {
  it("announces quiet loading and lets a failed request be retried without losing close", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(new TextEncoder().encode("Recovered notes"), { headers: { "x-harness-file": "1" } }),
      );
    vi.stubGlobal("fetch", fetch);
    const close = vi.fn();
    await act(async () => {
      root.render(
        createElement(FileSidebar, {
          file: { path: "notes.txt", label: "notes.txt" },
          projectPath: "/work",
          onClose: close,
        }),
      );
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Opening…");
    expect(container.querySelector(".file-sidebar-body")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    await act(async () => finish(new Response("", { status: 404 })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("File not found.");
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector("pre")?.textContent).toBe("Recovered notes");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector(".file-sidebar-body")?.getAttribute("aria-busy")).toBe("false");
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close file"]')!.click());
    expect(close).toHaveBeenCalledOnce();
  });
});
