// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { makeObservable, observable, runInAction } from "mobx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppRouter } from "../app.js";
import type { Dial } from "../client/dial.js";
import { resetNewSessions } from "../shell/new-session.js";
import { looseSessionHref, projectHref, sessionHref, type RouteTarget } from "../shell/path.js";

// Keep the actual router, context, layout, Composer, Tape, and title handling.
// Only model traversal is replaced: these fixtures are plain observable Dial
// snapshots rather than Plexus/Y.Doc sessions, and never open a websocket.
vi.mock("../shell/tape-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shell/tape-read.js")>();
  return {
    ...actual,
    tapeCells: (root: { sessionId: string }) => [
      { kind: "user", id: `${root.sessionId}:prompt`, text: `Transcript for ${root.sessionId}` },
    ],
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

const projectPath = "/work/navigation";
const sessionTarget = (sessionId: string, path = projectPath): RouteTarget => ({
  kind: "project-session",
  path,
  sessionId,
});

function sessionSnapshot(sessionId: string) {
  return {
    root: {
      uuid: `root:${sessionId}`,
      sessionId,
      path: projectPath,
      title: `Session ${sessionId}`,
      findRunningTurn: () => null,
      agent: { spec: { name: "", adoptNamedRecipe: vi.fn() } },
    },
  };
}

/** Mirror Dial's atomic commit: a pending/failed target never replaces the
 * visible resources, but immediately revokes the old session's action port. */
class NavigationDial {
  readonly kernel = {
    root: {
      projects: { [projectPath]: "" },
      sessions: {
        alpha: { title: "Session alpha", status: "reading", lastPrompt: "" },
        beta: { title: "Session beta", status: "reading", lastPrompt: "" },
      },
      botsRoster: {},
      approvalAskThrottleMs: 0,
      // Something is connected, so the frame is the workspace and not the first-run splash.
      connections: { chatgpt: { id: "chatgpt", driver: { name: "chatgpt", abilityClaim: ["completion"] } } },
    },
  };
  readonly projectSnapshot = {
    root: { path: projectPath, sessions: { alpha: "", beta: "" }, botsRoster: {} },
  };
  readonly projects = new Map([[projectPath, this.projectSnapshot]]);
  project: typeof this.projectSnapshot | null = null;
  session: ReturnType<typeof sessionSnapshot> | null = null;
  sessionRpc: { request: ReturnType<typeof vi.fn> } | null = null;
  target: RouteTarget = { kind: "kernel" };
  requestedTarget: RouteTarget = { kind: "kernel" };
  attaching = true;
  link: { kind: string } | null = null;
  readonly request = vi.fn(async () => ({ ok: true }));
  readonly prepareMint = vi.fn();
  readonly look = vi.fn();
  readonly gates = new Map<string, ReturnType<typeof deferred>>();
  private generation = 0;

  constructor() {
    makeObservable(this, {
      projects: observable,
      project: observable.ref,
      session: observable.ref,
      sessionRpc: observable.ref,
      target: observable.ref,
      requestedTarget: observable.ref,
      attaching: observable,
      link: observable.ref,
    });
  }

  readonly follow = vi.fn(async (target: RouteTarget): Promise<void> => {
    const generation = ++this.generation;
    runInAction(() => {
      this.requestedTarget = target;
      this.attaching = true;
      this.link = null;
      this.sessionRpc = null;
    });
    try {
      const sessionId = "sessionId" in target ? target.sessionId : null;
      if (sessionId != null) {
        const gate = this.gates.get(sessionId);
        this.gates.delete(sessionId);
        await gate?.promise;
      }
      if (generation !== this.generation) return;
      runInAction(() => {
        this.target = target;
        // Preserve the exact directory resource across sibling sessions.
        this.project = "path" in target ? this.projectSnapshot : null;
        this.session = sessionId == null ? null : sessionSnapshot(sessionId);
        this.sessionRpc = sessionId == null ? null : { request: this.request };
        this.attaching = false;
      });
    } catch {
      if (generation !== this.generation) return;
      runInAction(() => {
        this.link = { kind: "unreachable" };
        this.attaching = false;
      });
    }
  });

  hold(sessionId: string) {
    const gate = deferred();
    this.gates.set(sessionId, gate);
    return gate;
  }
}

let container: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createAppRouter>;

async function mount(dial: NavigationDial, href = sessionHref(projectPath, "alpha")) {
  router = createAppRouter(dial as unknown as Dial);
  router.update({
    history: createMemoryHistory({ initialEntries: [href] }),
    context: { dial: dial as unknown as Dial },
  });
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
    await router.load();
  });
  await settled();
}

async function settled() {
  await act(async () => {
    await vi.waitFor(() => expect(router.state.status).toBe("idle"));
  });
}

function element<T extends Element>(selector: string): T {
  const node = container.querySelector<T>(selector);
  expect(node, selector).not.toBeNull();
  return node!;
}

function button(label: string): HTMLButtonElement {
  const node = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  expect(node, `button: ${label}`).toBeDefined();
  return node!;
}

/** Rail rows are links, so they open in a new tab like any other link. */
function link(label: string): HTMLAnchorElement {
  const node = [...container.querySelectorAll("a[href]")].find((candidate) => candidate.textContent.trim() === label);
  expect(node, `link: ${label}`).toBeDefined();
  return node as HTMLAnchorElement;
}

const draft = () => element<HTMLTextAreaElement>('textarea[aria-label="Message draft"]');
const transcript = () => element<HTMLElement>(".transcript");

async function typeDraft(value: string) {
  await act(async () => {
    // Bypass React's value tracker, just as a browser edit would.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft(), value);
    draft().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function open(label: string) {
  await act(async () => link(label).click());
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetNewSessions();
  if (!("hidePopover" in HTMLElement.prototype)) {
    Object.defineProperty(HTMLElement.prototype, "hidePopover", { value: () => undefined });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("live application navigation", () => {
  it("places the Inhuman heading in the sidebar without a title bar and keeps navigation collapsible", async () => {
    await mount(new NavigationDial());
    element<HTMLElement>("aside");
    expect(element<HTMLElement>("aside h1").textContent).toBe("Inhuman");
    expect(button("Settings").classList).toContain("project-corner");
    expect(container.querySelector(":scope > div > header")).toBeNull();
    expect(container.querySelectorAll("h1")).toHaveLength(1);

    const toggle = button("Browse");
    const navigation = element<HTMLElement>("#navigation-rail");
    expect(toggle.getAttribute("aria-controls")).toBe(navigation.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(navigation.classList).toContain("hidden");
    await click("Browse");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(navigation.classList).not.toContain("hidden");
    await open("Session beta");
    await settled();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(navigation.classList).toContain("hidden");
  });

  it("keeps the project parent and shell DOM stable during a deferred sibling attachment and its commit", async () => {
    const dial = new NavigationDial();
    await mount(dial);
    const projectMatch = router.state.matches.find((match) => match.routeId === "/p/$path");
    expect(projectMatch).toBeDefined();
    expect(router.routesById["/p/$path/s/$sessionId"].parentRoute).toBe(router.routesById["/p/$path"]);
    const sidebar = element<HTMLElement>("aside");
    const navigation = element<HTMLElement>('nav[aria-label="All projects"]');
    const list = link("Session beta").closest("ul");
    const row = link("Session beta");
    const port = element<HTMLElement>('main[aria-label="Conversation"]');
    const textarea = draft();
    const directory = dial.project;
    await typeDraft("a draft must not be sent during attachment");
    expect(button("Send").disabled).toBe(false);
    port.scrollTop = 81;
    const gate = dial.hold("beta");

    await open("Session beta");
    // Cross the real router's pending threshold too: retaining nodes only in
    // the first synchronous frame would miss pendingComponent remounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(dial.requestedTarget).toEqual(sessionTarget("beta"));
    expect(dial.target).toEqual(sessionTarget("alpha"));
    expect(dial.attaching).toBe(true);
    expect(navigation.textContent).not.toContain("Opening the session");
    expect(transcript().textContent).toContain("Session alpha");
    expect(element("aside")).toBe(sidebar);
    expect(element('nav[aria-label="All projects"]')).toBe(navigation);
    expect(link("Session beta")).toBe(row);
    expect(row.closest("ul")).toBe(list);
    expect(element("main")).toBe(port);
    expect(port.scrollTop).toBe(81);
    expect(draft()).toBe(textarea);
    // Draft editing is local and remains available; only remote actions lock.
    expect(textarea.disabled).toBe(false);
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(dial.sessionRpc).toBeNull();

    await act(async () => gate.resolve());
    await settled();
    expect(router.state.matches.find((match) => match.routeId === "/p/$path")?.id).toBe(projectMatch?.id);
    expect(dial.project).toBe(directory);
    expect(dial.target).toEqual(sessionTarget("beta"));
    expect(transcript().textContent).toContain("Session beta");
    expect(transcript().textContent).not.toContain("Session alpha");
    expect(element("aside")).toBe(sidebar);
    expect(element('nav[aria-label="All projects"]')).toBe(navigation);
    expect(link("Session beta")).toBe(row);
    expect(row.closest("ul")).toBe(list);
    expect(element("main")).toBe(port);
    expect(draft()).toBe(textarea);
    expect(textarea.disabled).toBe(false);
  });

  it("retains independent drafts across session switches and reloads a revisited inactive binding", async () => {
    const dial = new NavigationDial();
    await mount(dial);
    const textarea = draft();
    await typeDraft("alpha draft stays here");
    expect(button("Send").disabled).toBe(false);
    await open("Session beta");
    await settled();
    expect(draft()).toBe(textarea);
    expect(draft().value).toBe("");
    await typeDraft("beta's separate draft");
    const oldBeta = dial.session;
    await open("Session alpha");
    await settled();
    expect(draft()).toBe(textarea);
    expect(draft().value).toBe("alpha draft stays here");
    expect(
      dial.follow.mock.calls.filter(([target]) => "sessionId" in target && target.sessionId === "alpha"),
    ).toHaveLength(2);

    const callsBeforeBack = dial.follow.mock.calls.length;
    await act(async () => router.history.back());
    await settled();
    expect(dial.follow).toHaveBeenCalledTimes(callsBeforeBack + 1);
    expect(dial.follow).toHaveBeenLastCalledWith(sessionTarget("beta"), expect.any(AbortSignal));
    expect(dial.session).not.toBe(oldBeta);
    expect(dial.target).toEqual(sessionTarget("beta"));
    expect(draft()).toBe(textarea);
    expect(draft().value).toBe("beta's separate draft");
    expect(dial.request).not.toHaveBeenCalled();
  });

  it("keeps the old transcript and draft on failure, with unavailable actions until retry commits", async () => {
    const dial = new NavigationDial();
    await mount(dial);
    await typeDraft("do not send to the wrong session");
    const textarea = draft();
    const oldSession = dial.session;
    const oldTitle = transcript().textContent;
    const gate = dial.hold("beta");
    await open("Session beta");
    expect(draft().disabled).toBe(false);
    expect(button("Send").disabled).toBe(true);
    await act(async () => gate.reject(new Error("offline")));
    await settled();

    expect(dial.attaching).toBe(false);
    expect(dial.target).toEqual(sessionTarget("alpha"));
    expect(dial.requestedTarget).toEqual(sessionTarget("beta"));
    expect(dial.session).toBe(oldSession);
    expect(transcript().textContent).toContain(oldTitle);
    expect(transcript().textContent).toContain("Session alpha");
    // The kernel is up, so the notice sits by the composer, not over the kept transcript.
    expect(container.querySelector(".composer-column .link-notice")?.textContent).toContain(
      "Can’t reach the harness daemon",
    );
    expect(transcript().textContent).not.toContain("Session beta");
    expect(draft()).toBe(textarea);
    expect(draft().value).toBe("do not send to the wrong session");
    expect(draft().disabled).toBe(false);
    expect(button("Send").disabled).toBe(true);
    expect(container.querySelector('button[aria-label="Stop"]')).toBeNull();
    await click("Send");
    await act(async () => draft().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dial.request).not.toHaveBeenCalled();

    await click("Retry");
    expect(dial.follow).toHaveBeenLastCalledWith(sessionTarget("beta"));
    expect(dial.target).toEqual(sessionTarget("beta"));
    expect(transcript().textContent).toContain("Session beta");
    expect(container.querySelector(".link-notice")).toBeNull();
    expect(draft()).toBe(textarea);
    expect(draft().disabled).toBe(false);
    expect(draft().value).toBe("");
  });

  it("routes encoded project and session segments without splitting or double decoding", async () => {
    const dial = new NavigationDial();
    const path = "/work/a b/#notes?x=1/%2F/日本語";
    const id = "session/with space?and#percent%2F";
    await mount(dial, projectHref(path));
    expect(dial.follow).toHaveBeenLastCalledWith({ kind: "project", path }, expect.any(AbortSignal));
    await act(async () => {
      await router.navigate({ href: sessionHref(path, id) });
    });
    await settled();
    expect(dial.follow).toHaveBeenLastCalledWith(sessionTarget(id, path), expect.any(AbortSignal));
    expect(transcript().textContent).toContain(`Session ${id}`);
    expect(router.state.matches.find((match) => match.routeId === "/p/$path")?.params.path).toBe(path);
    await act(async () => {
      await router.navigate({ href: looseSessionHref(id) });
    });
    await settled();
    expect(dial.follow).toHaveBeenLastCalledWith({ kind: "session", sessionId: id }, expect.any(AbortSignal));
    expect(transcript().textContent).toContain(`Session ${id}`);
    await act(async () => {
      await router.navigate({ href: "/" });
    });
    await settled();
    expect(dial.follow).toHaveBeenLastCalledWith({ kind: "kernel" }, expect.any(AbortSignal));
    expect(container.querySelector('textarea[aria-label="Message draft"]')).toBeNull();
  });

  it("names the project from the route when the room has not committed", async () => {
    const dial = new NavigationDial();
    await mount(dial, projectHref(projectPath));
    await settled();
    await act(async () => {
      runInAction(() => {
        dial.project = null;
        dial.session = null;
        dial.target = { kind: "kernel" };
        dial.link = { kind: "unanswered" };
      });
    });
    expect(dial.requestedTarget).toEqual({ kind: "project", path: projectPath });
    expect(transcript().textContent).toContain("navigation");
    expect(transcript().textContent).toContain("Open a session, or write a first message below to start another.");
    expect(transcript().textContent).not.toContain("Your workspace");
  });

  it("keeps a new session on the project until the first message is sent", async () => {
    const dial = new NavigationDial();
    Object.assign(dial.kernel.root, {
      kvs: { connection: "chatgpt", model: "gpt-6.1-sol" },
      bots: {
        explore: { name: "explore", description: "", instructions: "Look.", recipeScope: "session", error: null },
        "broken-bot": { name: "broken-bot", description: "", instructions: "", error: "unreadable" },
      },
    });
    Object.assign(dial.kernel.root.connections, {
      chatgpt: {
        id: "chatgpt",
        driver: { name: "chatgpt", abilityClaim: ["completion"] },
        live: { models: ["gpt-6.1-sol", "grok-4.7"] },
      },
    });
    await mount(dial);
    expect(dial.prepareMint).not.toHaveBeenCalled();

    await click("New session in navigation");
    await settled();
    expect(dial.prepareMint).not.toHaveBeenCalled();
    expect(dial.requestedTarget).toEqual({ kind: "project", path: projectPath });
    expect(document.activeElement).toBe(draft());
    expect(element<HTMLButtonElement>(".model-trigger").getAttribute("aria-label")).toBe("Model: Gpt 6.1 Sol");

    await pickListed("grok-4.7", "Grok 4.7");
    expect(element<HTMLButtonElement>(".model-trigger").getAttribute("aria-label")).toBe("Model: Grok 4.7");
    expect(dial.request).not.toHaveBeenCalled();
    await click("always approve");
    expect(element<HTMLButtonElement>(".permission-trigger").getAttribute("aria-label")).toBe(
      "Permission mode: always approve",
    );
    expect(container.textContent).not.toContain("broken-bot");
    await click("explore");
    expect(element<HTMLButtonElement>(".agent-trigger").getAttribute("aria-label")).toBe("Agent: explore");
    expect(dial.request).not.toHaveBeenCalled();
    await typeDraft("hello stage");

    await open("Session beta");
    await settled();
    expect(dial.prepareMint).not.toHaveBeenCalled();
    expect(dial.request).not.toHaveBeenCalled();
    expect(transcript().textContent).toContain("Session beta");

    await click("New session in navigation");
    await settled();
    expect(draft().value).toBe("hello stage");
    expect(element<HTMLButtonElement>(".model-trigger").getAttribute("aria-label")).toBe("Model: Grok 4.7");
    await click("Send");
    await settled();
    expect(dial.prepareMint).toHaveBeenCalledTimes(1);
    const id = dial.prepareMint.mock.calls[0]?.[0];
    expect(id).toEqual(expect.any(String));
    expect(dial.follow).toHaveBeenCalledWith(
      { kind: "project-session", path: projectPath, sessionId: id },
      expect.any(AbortSignal),
    );
    await act(async () => {
      await vi.waitFor(() => expect(dial.request).toHaveBeenCalledWith("turn", { prompt: "hello stage" }));
    });
    expect(dial.request.mock.calls).toEqual([
      ["kv/set", { key: "connection", value: "chatgpt", remember: true }],
      ["kv/set", { key: "model", value: "grok-4.7", remember: true }],
      ["policy/set", { policy: "yolo" }],
      ["turn", { prompt: "hello stage" }],
    ]);
    expect(dial.session?.root.agent.spec.adoptNamedRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ name: "explore", recipeScope: "session", keepAlive: false }),
    );
    expect(dial.prepareMint).toHaveBeenCalledTimes(1);
  });
});

/** Search reaches every provider, the same way the model menu is used. */
async function pickListed(model: string, label: string) {
  const field = element<HTMLInputElement>('input[aria-label="Search models"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, model);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const option = [...container.querySelectorAll('[role="option"]')].find((node) => node.textContent.includes(label));
  expect(option, label).toBeDefined();
  await act(async () => {
    if (!(option instanceof HTMLElement)) throw new Error(`no option ${label}`);
    option.click();
  });
}
