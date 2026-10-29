import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionPlexus } from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { pluginStateSnapshotFromHead, restoreSessionPluginState } from "../rewind.js";
import { encodeLog, KernelStateStore, sessionStateKey } from "../state-store.js";
import { hostPropose, StateDirectory } from "../state.js";
import { Dict, toJS, type ReducerDecl } from "../value.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REDUCER = {} as ReducerDecl;

describe("session plugin state rewind", () => {
  it("restores session logs from the nearest turn snapshot; private stays in memory", () => {
    const root = mkdtempSync(join(tmpdir(), "ext-rewind-"));
    temps.push(root);
    const session = SessionPlexus.create("s1", "/work");
    const store = new KernelStateStore(
      () => root,
      (id) => (id === "s1" ? session.root : undefined),
    );
    const directory = new StateDirectory(store);
    const ownerId = directory.ownerId("memo", "session", "s1", "state");
    const pocketId = directory.ownerId("memo", "private", "s1", "pocket");
    const owner = directory.open(ownerId, "session", "abi", REDUCER, new Map());
    const pocket = directory.open(pocketId, "private", "abi", REDUCER, new Map());
    hostPropose(directory, owner, new Dict({ type: "set", n: 1 }));
    hostPropose(directory, pocket, new Dict({ type: "put" }));
    const ended = {
      pluginStateJson: JSON.stringify({
        [sessionStateKey({ plugin: "memo", namespace: "state" })]: encodeLog(owner.log),
      }),
      turnTail: {},
    };
    hostPropose(directory, owner, new Dict({ type: "set", n: 2 }));

    expect(toJS(owner.log)).toEqual([
      { type: "set", n: 1 },
      { type: "set", n: 2 },
    ]);

    runInAction(() => {
      restoreSessionPluginState({
        directory,
        sessionId: "s1",
        live: session.root.pluginState,
        snapshot: pluginStateSnapshotFromHead(ended),
      });
    });

    expect({
      live: JSON.parse(session.root.pluginState["memo:state"] ?? "[]") as unknown,
      replayed: toJS(directory.get(ownerId).log),
      pocket: toJS(directory.get(pocketId).log),
    }).toEqual({
      live: [{ type: "set", n: 1 }],
      replayed: [{ type: "set", n: 1 }],
      pocket: [{ type: "put" }],
    });

    session.destroy();
  });
});
