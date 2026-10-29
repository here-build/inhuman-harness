import { isObservableProp, reaction } from "mobx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";

import { Dial } from "../dial.js";

const peer = vi.hoisted(() => ({
  waitForSync: vi.fn<() => Promise<void>>(),
  destroyProvider: vi.fn(),
  sessionRoot: vi.fn(() => ({
    path: "/workspace",
    agent: { spec: { recipeScope: "project" } },
  })),
  providers: [] as FakeProvider[],
  /** The kernel's glance rows. By default it lists every session a test opens. */
  kernelSessions: new Proxy({}, { get: () => ({}) }) as Record<string, unknown>,
  publish: vi.fn(),
  bindJsonRpc: vi.fn(() => ({
    request: vi.fn(async () => undefined),
    rejectAll: vi.fn(),
    whenLost: vi.fn(() => new Promise<void>(() => undefined)),
    lost: false,
  })),
}));

vi.mock("@inhuman.tools/harness-peer", () => ({
  KERNEL_DOC_GUID: "harness:kernel",
  KernelPlexus: { connect: vi.fn(() => ({ awareness: {}, root: { projects: {}, sessions: peer.kernelSessions } })) },
  ProjectPlexus: {
    connect: vi.fn(() => {
      const opened = [...peer.providers].reverse().find((provider) => provider.roomName === "project");
      return { root: { path: opened?.params.path ?? "" } };
    }),
  },
  SessionPlexus: {
    connect: vi.fn(() => ({ awareness: {}, root: peer.sessionRoot() })),
  },
  bindJsonRpc: peer.bindJsonRpc,
  publishRevalidationDemand: peer.publish,
  bindProviderAwareness: vi.fn(() => vi.fn()),
  detachProtocolAwareness: vi.fn(),
  destroyProvider: peer.destroyProvider,
  waitForSync: peer.waitForSync,
}));

type FakeProvider = {
  readonly roomName: string;
  readonly doc: Y.Doc;
  readonly params: Record<string, string>;
  shouldConnect: boolean;
  wsconnected: boolean;
  emit(event: string): void;
};

// Keep real Y.Doc and MobX behavior, but never open a socket or wait on timers.
vi.mock("y-websocket", () => ({
  WebsocketProvider: class {
    disconnectBc = () => undefined;
    readonly params: Record<string, string>;
    shouldConnect = true;
    wsconnected = true;
    readonly #listeners = new Map<string, (() => void)[]>();
    constructor(
      _origin: string,
      readonly roomName: string,
      readonly doc: Y.Doc,
      options: { params: Record<string, string> },
    ) {
      this.params = options.params;
      peer.providers.push(this);
    }
    on(event: string, listener: () => void): void {
      this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    }
    emit(event: string): void {
      for (const listener of this.#listeners.get(event) ?? []) listener();
    }
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

function holdNextSync() {
  const sync = deferred();
  const started = deferred();
  peer.waitForSync.mockImplementationOnce(() => {
    started.resolve();
    return sync.promise;
  });
  return { ...sync, started: started.promise };
}

const target = (sessionId: string, path = "/workspace") => ({
  kind: "project-session" as const,
  path,
  sessionId,
});

async function attachedDial() {
  const dial = new Dial("ws://localhost");
  await dial.follow(target("old"));
  expect(dial.project).not.toBeNull();
  expect(dial.session).not.toBeNull();
  expect(dial.sessionRpc).not.toBeNull();
  expect(dial.attaching).toBe(false);
  return dial;
}

function published(dial: Dial) {
  return { project: dial.project, session: dial.session, target: dial.target };
}

function expectRetained(dial: Dial, old: ReturnType<typeof published>) {
  expect(dial.project).toBe(old.project);
  expect(dial.session).toBe(old.session);
  expect(dial.target).toBe(old.target);
  expect(dial.sessionRpc).toBeNull();
}

function projectRoot(path: string) {
  return { path, agent: { spec: { recipeScope: "project" } } };
}

function latestProvider() {
  return peer.providers[peer.providers.length - 1]!;
}

function expectAlive(providers: typeof peer.providers) {
  for (const provider of providers) {
    expect(peer.destroyProvider).not.toHaveBeenCalledWith(provider);
    expect(provider.doc.isDestroyed).toBe(false);
  }
}

describe("Dial kernel port and demand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peer.providers.length = 0;
    peer.waitForSync.mockReset().mockResolvedValue(undefined);
    peer.kernelSessions = new Proxy({}, { get: () => ({}) });
  });

  it("opens a JSON-RPC port on the kernel room, with or without a session", async () => {
    const dial = new Dial("ws://localhost");
    expect(dial.kernelRpc).toBeNull();
    await dial.follow({ kind: "kernel" });
    const kernelProvider = peer.providers.find((provider) => provider.roomName === "kernel");
    expect(kernelProvider).toBeDefined();
    expect(peer.bindJsonRpc).toHaveBeenCalledTimes(1);
    expect(peer.bindJsonRpc).toHaveBeenCalledWith(kernelProvider);
    const port = dial.kernelRpc;
    expect(port).toBe(peer.bindJsonRpc.mock.results[0]?.value);
    expect(dial.sessionRpc).toBeNull();

    // A session route keeps the same kernel port beside its own.
    await dial.follow(target("s1"));
    expect(dial.kernelRpc).toBe(port);
    expect(dial.sessionRpc).not.toBe(port);
    expect(dial.sessionRpc).not.toBeNull();
  });

  it("keeps the kernel port through a failed route and drops it with the room", async () => {
    const dial = new Dial("ws://localhost");
    await dial.follow({ kind: "kernel" });
    const port = dial.kernelRpc;
    peer.waitForSync.mockRejectedValueOnce(new Error("project: sync timeout"));
    await dial.follow({ kind: "project", path: "/workspace" });
    expect(dial.link).toEqual({ kind: "unanswered" });
    expect(dial.kernelRpc).toBe(port);
  });

  it("publishes driver and connection refs in one demand, and clears both", async () => {
    const dial = new Dial("ws://localhost");
    dial.look(["a"], ["openai-compat"]);
    expect(peer.publish).not.toHaveBeenCalled();
    await dial.follow({ kind: "kernel" });
    dial.look(["a", "b"], ["openai-compat", "nous"]);
    dial.look([], []);
    expect(peer.publish.mock.calls.map(([, refs]) => refs)).toEqual([
      [
        { kind: "connection", id: "a" },
        { kind: "connection", id: "b" },
        { kind: "driver", name: "openai-compat" },
        { kind: "driver", name: "nous" },
      ],
      [],
    ]);
    dial.look(["a"]);
    expect(peer.publish.mock.lastCall?.[1]).toEqual([{ kind: "connection", id: "a" }]);
  });
});

describe("Dial attachment safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    peer.providers.length = 0;
    peer.waitForSync.mockReset().mockResolvedValue(undefined);
    peer.sessionRoot.mockReset().mockImplementation(() => projectRoot("/workspace"));
    peer.kernelSessions = new Proxy({}, { get: () => ({}) });
  });

  it("exposes observable progress and requested/committed targets", async () => {
    const dial = new Dial("ws://localhost");
    for (const key of ["attaching", "target", "requestedTarget"]) {
      expect(isObservableProp(dial, key)).toBe(true);
    }
    expect(dial.target).toEqual({ kind: "kernel" });
    expect(dial.requestedTarget).toEqual({ kind: "kernel" });
    expect(dial.attaching).toBe(true);
    const changes: boolean[] = [];
    const stop = reaction(
      () => dial.attaching,
      (value) => changes.push(value),
    );
    try {
      await dial.follow({ kind: "kernel" });
      const sync = holdNextSync();
      const next = target("new");
      const following = dial.follow(next);
      expect(dial.attaching).toBe(true);
      expect(dial.requestedTarget).toBe(next);
      expect(dial.target).toEqual({ kind: "kernel" });
      await sync.started;
      sync.resolve();
      await following;
      expect(dial.target).toBe(next);
      expect(changes).toEqual([false, true, false]);
    } finally {
      stop();
    }
  });

  it("retains the actual project and session but detaches RPC synchronously", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldRpc = dial.sessionRpc!;
    const projectProvider = peer.providers.find((provider) => provider.roomName === "project")!;
    const sync = holdNextSync();

    const following = dial.follow(target("new"));
    expectRetained(dial, old);
    expect(dial.attaching).toBe(true);
    expect(dial.link).toBeNull();
    await sync.started;
    expectRetained(dial, old);
    await dial.sessionRpc?.request("session.send", { text: "not for the old session" });
    expect(oldRpc.request).not.toHaveBeenCalled();
    expectAlive(peer.providers);

    sync.resolve();
    await following;
    expect(dial.attaching).toBe(false);
    expect(dial.session).not.toBe(old.session);
    expect(dial.sessionRpc).not.toBe(oldRpc);
    expect(dial.sessionRpc).not.toBeNull();
    expect(dial.project).toBe(old.project);
    expectAlive([projectProvider]);
    expect(peer.providers.filter((provider) => provider.roomName === "project")).toHaveLength(1);
    expect(dial.link).toBeNull();
  });

  it("retains content after rejection and retries the requested target", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldRpc = dial.sessionRpc!;
    const sync = holdNextSync();
    const next = target("unavailable");
    const following = dial.follow(next);
    await sync.started;
    const failed = latestProvider();
    sync.reject(new Error("socket refused"));

    await expect(following).resolves.toBeUndefined();
    expectRetained(dial, old);
    expect(dial.requestedTarget).toBe(next);
    expect(dial.attaching).toBe(false);
    expect(dial.link).toEqual({ kind: "unanswered" });
    expect(oldRpc.request).not.toHaveBeenCalled();
    expect(peer.destroyProvider).toHaveBeenCalledExactlyOnceWith(failed);
    expect(failed.doc.isDestroyed).toBe(true);

    const retrySync = holdNextSync();
    const retry = dial.follow(dial.requestedTarget);
    expect(dial.link).toBeNull();
    expect(dial.attaching).toBe(true);
    expectRetained(dial, old);
    await retrySync.started;
    retrySync.resolve();
    await retry;
    expect(dial.target).toBe(next);
    expect(dial.sessionRpc).not.toBeNull();
    expect(dial.attaching).toBe(false);
  });

  it("does not publish a loose project session until its project attaches, and cleans both on failure", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldProviders = [...peer.providers];
    peer.sessionRoot.mockReturnValueOnce(projectRoot("/other"));
    peer.waitForSync.mockResolvedValueOnce(undefined);
    const projectSync = holdNextSync();
    const following = dial.follow({ kind: "session", sessionId: "other" });
    await projectSync.started;
    const failedProject = latestProvider();
    const stagedSession = peer.providers.find((provider) => provider.params.sessionId === "other")!;
    expect(failedProject.params).toEqual({ path: "/other" });
    expectRetained(dial, old);
    expect(dial.attaching).toBe(true);
    expectAlive(oldProviders);
    projectSync.reject(new Error("project unavailable"));
    await following;
    expectRetained(dial, old);
    expect(dial.attaching).toBe(false);
    expect(dial.link).not.toBeNull();
    expectAlive(oldProviders);
    for (const provider of [failedProject, stagedSession]) {
      expect(peer.destroyProvider).toHaveBeenCalledWith(provider);
      expect(provider.doc.isDestroyed).toBe(true);
    }
  });

  it.each(["global", "empty path"])("commits a loose %s session with no unrelated project", async (scope) => {
    const dial = await attachedDial();
    peer.sessionRoot.mockReturnValueOnce({
      path: scope === "global" ? "/workspace" : "",
      agent: { spec: { recipeScope: scope === "global" ? "global" : "project" } },
    });
    const next = { kind: "session" as const, sessionId: "loose" };
    await dial.follow(next);
    expect(dial.target).toBe(next);
    expect(dial.project).toBeNull();
    expect(dial.session).not.toBeNull();
    expect(dial.sessionRpc).not.toBeNull();
  });

  it.each(["resolve", "reject"] as const)(
    "does not let an older attachment %s clear a newer attachment's progress",
    async (outcome) => {
      const dial = await attachedDial();
      const old = published(dial);
      const olderSync = holdNextSync();
      const older = dial.follow(target("older"));
      await olderSync.started;
      const olderProvider = latestProvider();
      const newerSync = holdNextSync();
      const newer = dial.follow(target("newer"));
      await newerSync.started;

      if (outcome === "resolve") olderSync.resolve();
      else olderSync.reject(new Error("old socket failed"));
      await older;
      expect(dial.attaching).toBe(true);
      expectRetained(dial, old);
      expect(dial.link).toBeNull();
      expect(olderProvider.doc.isDestroyed).toBe(true);

      newerSync.resolve();
      await newer;
      expect(dial.attaching).toBe(false);
      expect(dial.sessionRpc).not.toBeNull();
      expect(dial.target).toEqual(target("newer"));
      expect(dial.link).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "a stale staged project %s cannot publish or drop the newer committed rooms",
    async (outcome) => {
      const dial = await attachedDial();
      peer.sessionRoot.mockReturnValueOnce(projectRoot("/other"));
      peer.waitForSync.mockResolvedValueOnce(undefined);
      const olderSync = holdNextSync();
      const older = dial.follow(target("older", "/other"));
      await olderSync.started;
      const stagedProviders = peer.providers.slice(-2);
      await dial.follow(target("newer"));
      const current = published(dial);
      const rpc = dial.sessionRpc;
      const currentProviders = peer.providers.filter(
        (provider) => provider.params.sessionId === "newer" || provider.params.path === "/workspace",
      );
      if (outcome === "resolve") olderSync.resolve();
      else olderSync.reject(new Error("stale project failed"));
      await older;
      expect(published(dial)).toEqual(current);
      expect(dial.sessionRpc).toBe(rpc);
      expect(dial.attaching).toBe(false);
      expect(dial.link).toBeNull();
      expectAlive(currentProviders);
      for (const provider of stagedProviders) expect(provider.doc.isDestroyed).toBe(true);
    },
  );

  it("publishes target, project, session, RPC and completion in one reaction", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    peer.sessionRoot.mockReturnValueOnce(projectRoot("/other"));
    peer.waitForSync.mockResolvedValueOnce(undefined);
    const sync = holdNextSync();
    const snapshots: unknown[] = [];
    const stop = reaction(
      () => ({ ...published(dial), rpc: dial.sessionRpc, link: dial.link, attaching: dial.attaching }),
      (snapshot) => snapshots.push(snapshot),
    );
    try {
      const next = { kind: "session" as const, sessionId: "other" };
      const following = dial.follow(next);
      await sync.started;
      expect(snapshots).toEqual([{ ...old, rpc: null, link: null, attaching: true }]);
      sync.resolve();
      await following;
      expect(snapshots).toEqual([
        { ...old, rpc: null, link: null, attaching: true },
        { ...published(dial), rpc: dial.sessionRpc, link: null, attaching: false },
      ]);
      expect(dial.target).toBe(next);
      expect(dial.project).not.toBe(old.project);
      expect(dial.project).not.toBeNull();
      expect(dial.session).not.toBe(old.session);
      expect(dial.sessionRpc).not.toBeNull();
    } finally {
      stop();
    }
  });

  it("reattaches fresh rooms when switching away and back, without minting on reload", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldSession = peer.providers.find((provider) => provider.roomName === "session")!;
    await dial.follow({ kind: "kernel" });
    expect(dial.project).toBeNull();
    expect([...dial.projects.keys()]).toEqual(["/workspace"]);
    expect(dial.session).toBeNull();
    expect(oldSession.doc.isDestroyed).toBe(true);
    const sync = holdNextSync();
    const following = dial.follow(target("old"));
    await sync.started;
    expect(latestProvider().params).toEqual({ sessionId: "old" });
    expect(dial.attaching).toBe(true);
    sync.resolve();
    await following;
    expect(dial.project).toBe(old.project);
    expect(dial.session).not.toBe(old.session);
    expectAlive(peer.providers.slice(-1));
    expect(peer.waitForSync).toHaveBeenCalledTimes(4);
  });

  it.each(["session", "project"])(
    "preserves explicit mint permission after failed %s sync for Retry",
    async (stage) => {
      const dial = await attachedDial();
      dial.prepareMint("minted");
      if (stage === "project") peer.waitForSync.mockResolvedValueOnce(undefined);
      peer.waitForSync.mockRejectedValueOnce(new Error("unavailable"));
      const next = target("minted", "/mint-project");
      await dial.follow(next);
      expect(dial.link).toEqual({ kind: "unreachable" });
      expect(dial.sessionRpc).toBeNull();
      await dial.follow(dial.requestedTarget);
      const attempts = peer.providers.filter((provider) => provider.params.sessionId === "minted");
      expect(attempts).toHaveLength(2);
      for (const provider of attempts) {
        expect(provider.params).toEqual({ sessionId: "minted", path: "/mint-project" });
      }
      expect(dial.target).toBe(next);
      expect(dial.sessionRpc).not.toBeNull();
    },
  );

  it.each(["first", "second"])("does not consume a newer prepared mint for %s", async (preparedId) => {
    const dial = await attachedDial();
    dial.prepareMint("first");
    const sync = holdNextSync();
    const following = dial.follow(target("first"));
    await sync.started;
    dial.prepareMint(preparedId);
    sync.resolve();
    await following;
    await dial.follow({ kind: "kernel" });
    await dial.follow(target(preparedId));
    const attempts = peer.providers.filter((provider) => provider.params.sessionId === preparedId);
    expect(attempts.at(-1)!.params).toEqual({ sessionId: preparedId, path: "/workspace" });
  });

  it.each(["other project", "global", "empty path"])(
    "rejects a nested session belonging to %s without replacing content",
    async (scope) => {
      const dial = await attachedDial();
      const old = published(dial);
      const oldProviders = [...peer.providers];
      peer.sessionRoot.mockReturnValueOnce({
        path: scope === "empty path" ? "" : "/other",
        agent: { spec: { recipeScope: scope === "global" ? "global" : "project" } },
      });
      const next = target("mismatch");
      await dial.follow(next);
      expectRetained(dial, old);
      expect(dial.requestedTarget).toBe(next);
      expect(dial.attaching).toBe(false);
      expect(dial.link).toMatchObject({ kind: "elsewhere", sessionId: "mismatch" });
      expectAlive(oldProviders);
      expect(peer.providers).toHaveLength(oldProviders.length + 1);
      expect(latestProvider().doc.isDestroyed).toBe(true);
    },
  );

  it("validates cached sessions against the requested project too", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    await dial.follow(target("old", "/wrong"));
    expectRetained(dial, old);
    expect(dial.link).toEqual({ kind: "elsewhere", sessionId: "old", path: "/workspace" });
    expectAlive(peer.providers);
  });

  it.each(["resolve", "reject"] as const)("aborts during sync promptly and ignores later %s", async (outcome) => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldProviders = [...peer.providers];
    const controller = new AbortController();
    const sync = holdNextSync();
    const following = dial.follow(target("cancelled"), controller.signal);
    await sync.started;
    const pending = latestProvider();
    controller.abort();
    expect(pending.doc.isDestroyed).toBe(true);
    expect(dial.attaching).toBe(false);
    expect(dial.link).toEqual({ kind: "cancelled" });
    expectRetained(dial, old);
    await following;
    expectAlive(oldProviders);
    if (outcome === "resolve") sync.resolve();
    else sync.reject(new Error("late failure"));
    await Promise.resolve();
    expectRetained(dial, old);
    expect(dial.link).toEqual({ kind: "cancelled" });
    expect(peer.destroyProvider).toHaveBeenCalledExactlyOnceWith(pending);
  });

  it("aborts the staged session and pending project without touching committed rooms", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldProviders = [...peer.providers];
    peer.sessionRoot.mockReturnValueOnce(projectRoot("/other"));
    peer.waitForSync.mockResolvedValueOnce(undefined);
    const sync = holdNextSync();
    const controller = new AbortController();
    const following = dial.follow(target("cancelled", "/other"), controller.signal);
    await sync.started;
    const staged = peer.providers.slice(-2);
    controller.abort();
    for (const provider of staged) {
      expect(provider.doc.isDestroyed).toBe(true);
      expect(peer.destroyProvider).toHaveBeenCalledWith(provider);
    }
    await following;
    expectRetained(dial, old);
    expectAlive(oldProviders);
    expect(dial.attaching).toBe(false);
    sync.resolve();
    await Promise.resolve();
    expectRetained(dial, old);
    expect(dial.link).toEqual({ kind: "cancelled" });
    expect(peer.destroyProvider).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "committed"])("aborting an old attempt cannot change a newer %s attachment", async (stage) => {
    const dial = await attachedDial();
    const controller = new AbortController();
    const olderSync = holdNextSync();
    const older = dial.follow(target("older"), controller.signal);
    await olderSync.started;
    const olderProvider = latestProvider();
    const newerSync = holdNextSync();
    const newer = dial.follow(target("newer"));
    await newerSync.started;
    if (stage === "committed") {
      newerSync.resolve();
      await newer;
    }
    const current = published(dial);
    const rpc = dial.sessionRpc;
    controller.abort();
    await older;
    expect(published(dial)).toEqual(current);
    expect(dial.sessionRpc).toBe(rpc);
    expect(dial.attaching).toBe(stage === "pending");
    expect(dial.link).toBeNull();
    expect(olderProvider.doc.isDestroyed).toBe(true);
    olderSync.resolve();
    newerSync.resolve();
    await newer;
    expect(dial.target).toEqual(target("newer"));
    expect(dial.sessionRpc).not.toBeNull();
  });

  it("does not open rooms for an already aborted attempt", async () => {
    const dial = await attachedDial();
    const old = published(dial);
    const oldProviders = [...peer.providers];
    const controller = new AbortController();
    controller.abort();
    await dial.follow(target("cancelled"), controller.signal);
    expectRetained(dial, old);
    expect(dial.attaching).toBe(false);
    expect(dial.link).toEqual({ kind: "cancelled" });
    expect(peer.providers).toEqual(oldProviders);
    expectAlive(oldProviders);
  });

  it("removes abort listeners after success and failure", async () => {
    const dial = await attachedDial();
    const succeeded = new AbortController();
    const removed = vi.spyOn(succeeded.signal, "removeEventListener");
    await dial.follow(target("new"), succeeded.signal);
    const current = published(dial);
    const rpc = dial.sessionRpc;
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    succeeded.abort();
    expect(published(dial)).toEqual(current);
    expect(dial.sessionRpc).toBe(rpc);
    expect(dial.link).toBeNull();
    const failed = new AbortController();
    const removedOnFailure = vi.spyOn(failed.signal, "removeEventListener");
    peer.waitForSync.mockRejectedValueOnce(new Error("failure"));
    await dial.follow(target("failed"), failed.signal);
    const link = dial.link;
    expect(removedOnFailure).toHaveBeenCalledWith("abort", expect.any(Function));
    failed.abort();
    expect(dial.link).toBe(link);
  });

  it("attaches every known project for the sidebar and keeps them across route changes", async () => {
    const { KernelPlexus } = await import("@inhuman.tools/harness-peer");
    vi.mocked(KernelPlexus.connect).mockReturnValueOnce({
      awareness: {},
      root: { projects: { "/workspace": "", "/other": "" } },
    } as never);
    const dial = new Dial("ws://localhost");
    await dial.follow({ kind: "kernel" });
    await vi.waitFor(() => expect([...dial.projects.keys()]).toEqual(["/workspace", "/other"]));
    const held = dial.projects.get("/other");
    await dial.follow(target("alpha", "/workspace"));
    expect(dial.projects.get("/other")).toBe(held);
    expect(peer.destroyProvider).not.toHaveBeenCalled();
  });

  it("mints only after explicit prepareMint, consuming that permission once", async () => {
    const dial = await attachedDial();
    dial.prepareMint("new");
    await dial.follow(target("new"));
    const minted = peer.providers.find((provider) => provider.params.sessionId === "new")!;
    expect(minted.params).toEqual({ sessionId: "new", path: "/workspace" });
    await dial.follow({ kind: "kernel" });
    await dial.follow(target("new"));
    expect(latestProvider().roomName).toBe("session");
    const reloaded = peer.providers.filter((provider) => provider.params.sessionId === "new")[1]!;
    expect(reloaded.params).toEqual({ sessionId: "new" });
  });

  it("keeps a cold kernel when a listed session does not open, and waits longer for it", async () => {
    const dial = new Dial("ws://localhost");
    peer.waitForSync.mockResolvedValueOnce(undefined);
    peer.waitForSync.mockRejectedValueOnce(new Error("session: websocket error"));
    await dial.follow(target("listed"));
    expect(dial.kernel).not.toBeNull();
    expect(dial.link).toEqual({ kind: "unanswered" });
    expect(peer.waitForSync).toHaveBeenCalledWith(expect.anything(), "session", 60_000);
  });

  it("says a session is missing only once the kernel has answered and does not list it", async () => {
    peer.kernelSessions = {};
    const dial = new Dial("ws://localhost");
    peer.waitForSync.mockResolvedValueOnce(undefined);
    peer.waitForSync.mockRejectedValueOnce(new Error("session: websocket error"));
    await dial.follow(target("gone"));
    expect(dial.link).toEqual({ kind: "missing", sessionId: "gone" });
    expect(dial.kernel).not.toBeNull();
    expect(peer.waitForSync).toHaveBeenCalledWith(expect.anything(), "session", 8_000);
  });

  it("calls a refused session the kernel does not list missing, and a slow sync unanswered", async () => {
    peer.kernelSessions = {};
    const dial = await attachedDial();
    peer.waitForSync.mockRejectedValueOnce(new Error("session: websocket error"));
    await dial.follow(target("gone"));
    expect(dial.link).toEqual({ kind: "missing", sessionId: "gone" });

    peer.waitForSync.mockRejectedValueOnce(new Error("session: sync timeout connected=true state=1"));
    await dial.follow(target("slow"));
    expect(dial.link).toEqual({ kind: "unanswered" });
  });

  it("says reconnecting while a held room redials, and clears once every room is back", async () => {
    const dial = await attachedDial();
    const session = peer.providers.find((provider) => provider.roomName === "session")!;
    session.wsconnected = false;
    session.emit("status");
    expect(dial.link).toEqual({ kind: "reconnecting" });
    session.wsconnected = true;
    session.emit("status");
    expect(dial.link).toBeNull();

    // A permanent close ends the redial: only a retry attaches again.
    session.emit("closed");
    expect(dial.link).toEqual({ kind: "unreachable" });
  });

  it("ignores a room it already let go", async () => {
    const dial = await attachedDial();
    const old = peer.providers.find((provider) => provider.params.sessionId === "old")!;
    await dial.follow(target("next"));
    old.shouldConnect = false;
    old.wsconnected = false;
    old.emit("status");
    old.emit("closed");
    expect(dial.link).toBeNull();
  });
});
