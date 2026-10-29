import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionPlexus, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { bindSessionCatalog, KernelToolCatalog, type CatalogEntry } from "@/tool-catalog";

import {
  behaviorEntriesThatRun,
  executeSystemTool,
  guardHostTool,
  guardedCallOf,
  stampUnentered,
  ToolCallHandler,
} from "../index.js";

beforeEach(() => resetLocalIDs());

function shellEntry(execute: CatalogEntry["execute"]): CatalogEntry {
  return {
    wireName: "shell",
    description: "shell",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    class: "effect",
    source: { kind: "pack", pluginName: "toolkit" },
    execute,
  };
}

describe("deny/ask do not start the effect", () => {
  it("a license refusal (ask/deny) never reaches catalog.execute", async () => {
    let cores = 0;
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      shellEntry(async () => {
        cores += 1;
        return { ok: true, text: "ran" };
      }),
    ]);
    const handler = new ToolCallHandler({ catalog });
    const job = handler.admit({
      id: "c2",
      type: "function",
      function: {
        name: "shell",
        arguments: JSON.stringify({ command: "echo hi" }),
      },
    });
    const plexus = SessionPlexus.create("deny-license", "/tmp/deny-license");
    onTestFinished(() => plexus.destroy());
    const turn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`p`,
      queue: [],
    });
    turn.pushChild(job);
    plexus.root.head = turn;
    bindSessionCatalog(plexus.root, catalog);

    const decision = await guardHostTool({
      job: job as SystemToolJob,
      origin: "rpc",
      agent: null,
      behaviorEntries: [],
      guardedCall: (leaf) => guardedCallOf(leaf, plexus.root.path),
      license: async () => false,
      turnId: turn.uuid,
      onUnentered: stampUnentered,
    });
    if (decision.allowed && job instanceof SystemToolJob) {
      await executeSystemTool(job, new AbortController().signal);
    }

    expect({
      allowed: decision.allowed,
      cores,
      sealed: job.receiptJson,
    }).toEqual({
      allowed: false,
      cores: 0,
      sealed: null,
    });
  });

  it("an RPC origin still asks the license before the effect", async () => {
    let cores = 0;
    const catalog = new KernelToolCatalog();
    catalog.replacePack([
      shellEntry(async () => {
        cores += 1;
        return { ok: true, text: "ran" };
      }),
    ]);
    const job = new ToolCallHandler({ catalog }).admit({
      id: "c3",
      type: "function",
      function: {
        name: "shell",
        arguments: JSON.stringify({ command: "rm -rf x" }),
      },
    });
    const decision = await guardHostTool({
      job: job as SystemToolJob,
      origin: "rpc",
      agent: null,
      behaviorEntries: [],
      guardedCall: (leaf) => guardedCallOf(leaf, "/tmp"),
      license: async () => {
        cores += 10;
        return false;
      },
      turnId: "t",
      onUnentered: stampUnentered,
    });
    expect({ allowed: decision.allowed, cores }).toEqual({
      allowed: false,
      cores: 10,
    });
  });

  it("a behavior-declared name skips the license only while the behavior's entry is the one that runs", async () => {
    const behavior = shellEntry(async () => ({ ok: true, text: "behavior" }));
    const pack = shellEntry(async () => ({ ok: true, text: "pack" }));
    const catalog = new KernelToolCatalog();
    catalog.replacePack([pack]);
    const handler = new ToolCallHandler({ catalog });
    const job = handler.admit({
      id: "c3",
      type: "function",
      function: { name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
    });
    let licensed = 0;
    const decision = await guardHostTool({
      job: job as SystemToolJob,
      origin: "model",
      agent: null,
      behaviorEntries: behaviorEntriesThatRun([behavior], (wire) => catalog.catalogEntry(wire)),
      guardedCall: (leaf) => guardedCallOf(leaf, "/tmp"),
      license: async () => {
        licensed += 1;
        return false;
      },
      turnId: "t",
      onUnentered: stampUnentered,
    });
    // The pack entry shadows the behavior entry at execution, so the license must still run.
    expect({ allowed: decision.allowed, licensed }).toEqual({ allowed: false, licensed: 1 });
    // Nothing shadows it: the behavior is its own grant.
    const alone = new KernelToolCatalog();
    expect(behaviorEntriesThatRun([behavior], (wire) => alone.catalogEntry(wire))).toEqual([behavior]);
    // The very entry that runs is still skipped.
    expect(behaviorEntriesThatRun([pack], (wire) => catalog.catalogEntry(wire))).toEqual([pack]);
  });
});
