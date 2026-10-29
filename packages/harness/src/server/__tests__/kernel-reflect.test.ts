import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_APPROVAL_ASK_THROTTLE_MS,
  DEFAULT_AUTO_MODE_JUDGE,
  DEFAULT_COMPACT_KEEP_TURNS,
  DEFAULT_CONTEXT_GLOW_REMAINING,
  DEFAULT_SHELL_TAIL_BYTES,
  DEFAULT_SUPER_KEY,
  KernelPlexus,
  type KernelRoot,
  MAX_SHELL_TAIL_BYTES,
} from "@inhuman.tools/harness-model";
import type { ReActLoopIntentDetectedTrigger } from "@inhuman.tools/harness-model/shared";
import { mkdtemp, readJson, writeFile, writeJson } from "fs-extra";
import { describe, expect, it } from "vitest";

import { reflectKernel } from "../daemon/kernel/fs-reflection/reflectKernel.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";

describe("kernel reflect", () => {
  it("kernel advertise genesis connect.scm", async () => {
    const genesisDir = await mkdtemp(join(tmpdir(), "harness-corecmd-"));
    using daemon = new KernelDaemon(genesisDir);
    await daemon.ready;
    const connect = daemon.plexus.root.commands.connect;
    expect({
      source: connect?.source,
      nonempty: (connect?.body.length ?? 0) > 0,
    }).toEqual({
      source: expect.stringMatching(/defaults\/commands\/connect\.scm$/),
      nonempty: true,
    });
  }, 15_000);

  it("regenerates a sub-1 compactKeepTurns into config.json at boot", async () => {
    const genesisDir = await mkdtemp(join(tmpdir(), "harness-keepturns-"));
    await writeJson(join(genesisDir, "config.json"), { connections: {}, compactKeepTurns: 0 });
    using daemon = new KernelDaemon(genesisDir);
    await daemon.ready;

    // Boot heals the invalid floor in-place; the file is the source of truth.
    const healed = (await readJson(join(genesisDir, "config.json"))) as { compactKeepTurns: number };
    expect(healed.compactKeepTurns).toBe(DEFAULT_COMPACT_KEEP_TURNS);
    expect(daemon.plexus.root.compactKeepTurns).toBe(DEFAULT_COMPACT_KEEP_TURNS);
  }, 15_000);

  it("leaves a valid compactKeepTurns untouched at boot", async () => {
    const genesisDir = await mkdtemp(join(tmpdir(), "harness-keepturns-"));
    await writeJson(join(genesisDir, "config.json"), { connections: {}, compactKeepTurns: 5 });
    using daemon = new KernelDaemon(genesisDir);
    await daemon.ready;

    const kept = (await readJson(join(genesisDir, "config.json"))) as { compactKeepTurns: number };
    expect(kept.compactKeepTurns).toBe(5);
    expect(daemon.plexus.root.compactKeepTurns).toBe(5);
  }, 15_000);

  const CONFIG_ROWS: Array<{
    name: string;
    config: Record<string, unknown>;
    read: (root: KernelRoot) => unknown;
    want: unknown;
  }> = [
    {
      name: "glow default",
      config: { connections: {} },
      read: (root) => root.contextGlowRemaining,
      want: DEFAULT_CONTEXT_GLOW_REMAINING,
    },
    {
      name: "glow custom",
      config: { connections: {}, contextGlowRemaining: "50%" },
      read: (root) => root.contextGlowRemaining,
      want: "50%",
    },
    {
      name: "glow unknown",
      config: { connections: {}, contextGlowRemaining: "nope" },
      read: (root) => root.contextGlowRemaining,
      want: DEFAULT_CONTEXT_GLOW_REMAINING,
    },
    {
      name: "superKey default",
      config: { connections: {} },
      read: (root) => root.superKey,
      want: DEFAULT_SUPER_KEY,
    },
    {
      name: "superKey cmd",
      config: { connections: {}, superKey: "cmd" },
      read: (root) => root.superKey,
      want: "cmd",
    },
    {
      name: "superKey unknown",
      config: { connections: {}, superKey: "meta" },
      read: (root) => root.superKey,
      want: DEFAULT_SUPER_KEY,
    },
    {
      name: "hideFloorTools default",
      config: { connections: {} },
      read: (root) => root.hideFloorTools,
      want: false,
    },
    {
      name: "hideFloorTools on",
      config: { connections: {}, hideFloorTools: true },
      read: (root) => root.hideFloorTools,
      want: true,
    },
    {
      name: "shellTail default",
      config: { connections: {} },
      read: (root) => root.shellTailBytes,
      want: DEFAULT_SHELL_TAIL_BYTES,
    },
    {
      name: "shellTail custom",
      config: { connections: {}, shellTailBytes: 2048 },
      read: (root) => root.shellTailBytes,
      want: 2048,
    },
    {
      name: "shellTail zero",
      config: { connections: {}, shellTailBytes: 0 },
      read: (root) => root.shellTailBytes,
      want: 0,
    },
    {
      name: "shellTail clamp",
      config: { connections: {}, shellTailBytes: 10_000_000 },
      read: (root) => root.shellTailBytes,
      want: MAX_SHELL_TAIL_BYTES,
    },
    {
      name: "loop limits default to unlimited, retries without a deadline, three length continuations",
      config: { connections: {} },
      read: (root) => [
        root.maxRounds,
        root.maxDepth,
        root.maxBotRounds,
        root.maxBotDepth,
        root.retryMaxMs,
        root.retryMaxAttempts,
        root.lengthContinuations,
      ],
      want: [0, 0, 0, 0, 0, 0, 3],
    },
    {
      name: "loop limits from config",
      config: {
        connections: {},
        maxRounds: 40,
        maxDepth: 3,
        maxBotRounds: 10,
        maxBotDepth: 2,
        retryMaxMs: 60_000,
        retryMaxAttempts: 8,
        lengthContinuations: 0,
      },
      read: (root) => [
        root.maxRounds,
        root.maxDepth,
        root.maxBotRounds,
        root.maxBotDepth,
        root.retryMaxMs,
        root.retryMaxAttempts,
        root.lengthContinuations,
      ],
      want: [40, 3, 10, 2, 60_000, 8, 0],
    },
    {
      name: "throttle default",
      config: { connections: {} },
      read: (root) => root.approvalAskThrottleMs,
      want: DEFAULT_APPROVAL_ASK_THROTTLE_MS,
    },
    {
      name: "throttle custom",
      config: { connections: {}, approvalAskThrottleMs: 500 },
      read: (root) => root.approvalAskThrottleMs,
      want: 500,
    },
    {
      name: "defaultPermissionMode last-choice",
      config: { connections: {} },
      read: (root) => root.defaultPermissionMode,
      want: "manual",
    },
    {
      name: "unknown defaultPolicy key",
      config: { connections: {}, defaultPolicy: "auto" },
      read: (root) => root.defaultPermissionMode,
      want: "manual",
    },
    {
      name: "defaultPermissionMode unknown",
      config: { connections: {}, defaultPermissionMode: "plan" },
      read: (root) => root.defaultPermissionMode,
      want: "manual",
    },
    {
      name: "authorization default",
      config: { connections: {} },
      read: (root) => root.authorizationJson,
      want: "",
    },
    {
      name: "authorization custom",
      config: { connections: {}, authorization: { auto: { preset: "full" } } },
      read: (root) => JSON.parse(root.authorizationJson),
      want: { auto: { preset: "full" } },
    },
    {
      name: "the old auto-allow flags are not read",
      config: { connections: {}, autoAllow: { write: true }, autoCoverDeny: false },
      read: (root) => root.authorizationJson,
      want: "",
    },
    {
      name: "reActLoopIntentDetectedTrigger default",
      config: { connections: {} },
      read: (root) => ({
        enabled: root.reActLoopIntentDetectedTrigger.enabled,
        models: { ...root.reActLoopIntentDetectedTrigger.models },
      }),
      want: { enabled: true, models: {} },
    },
    {
      name: "reActLoopIntentDetectedTrigger off",
      config: { connections: {}, reActLoopIntentDetectedTrigger: { enabled: false } },
      read: (root) => ({
        enabled: root.reActLoopIntentDetectedTrigger.enabled,
        models: { ...root.reActLoopIntentDetectedTrigger.models },
      }),
      want: { enabled: false, models: {} },
    },
    {
      name: "reActLoopIntentDetectedTrigger overlay",
      config: {
        connections: {},
        reActLoopIntentDetectedTrigger: { enabled: true, models: { "openai:gpt-5.2": false } },
      },
      read: (root) => ({
        enabled: root.reActLoopIntentDetectedTrigger.enabled,
        models: { ...root.reActLoopIntentDetectedTrigger.models },
      }),
      want: { enabled: true, models: { "openai:gpt-5.2": false } },
    },
    {
      name: "autoModeClassifier default",
      config: { connections: {} },
      read: (root) => root.autoModeClassifier,
      want: DEFAULT_AUTO_MODE_JUDGE,
    },
    {
      name: "autoModeClassifier custom",
      config: { connections: {}, autoModeClassifier: "./my-judge.scm" },
      read: (root) => root.autoModeClassifier,
      want: "./my-judge.scm",
    },
    {
      name: "unknown autoModeAsk key",
      config: { connections: {}, autoModeAsk: "./ask-alias.scm" },
      read: (root) => root.autoModeClassifier,
      want: DEFAULT_AUTO_MODE_JUDGE,
    },
    {
      name: "unknown autoModeJudge key",
      config: { connections: {}, autoModeJudge: "./judge-alias.scm" },
      read: (root) => root.autoModeClassifier,
      want: DEFAULT_AUTO_MODE_JUDGE,
    },
    {
      name: "connection tools lift",
      config: {
        connections: {
          github: {
            driver: "mcp-stdio",
            name: "GitHub",
            tools: ["get_*", "!write_*"],
            toolSeverity: { merge_pull_request: "irreversible-effect" },
            alwaysAllow: ["get_issue"],
            settings: { command: "npx" },
          },
        },
      },
      read: (root) => root.connections.github?.configuration,
      want: {
        command: "npx",
        tools: ["get_*", "!write_*"],
        toolSeverity: { merge_pull_request: "irreversible-effect" },
        alwaysAllow: ["get_issue"],
      },
    },
    {
      name: "keepTurns default",
      config: { connections: {} },
      read: (root) => root.compactKeepTurns,
      want: DEFAULT_COMPACT_KEEP_TURNS,
    },
    {
      name: "keepTurns custom",
      config: { connections: {}, compactKeepTurns: 4 },
      read: (root) => root.compactKeepTurns,
      want: 4,
    },
    {
      name: "keepTurns zero heals to default",
      config: { connections: {}, compactKeepTurns: 0 },
      read: (root) => root.compactKeepTurns,
      want: DEFAULT_COMPACT_KEEP_TURNS,
    },
    {
      name: "keepTurns negative heals to default",
      config: { connections: {}, compactKeepTurns: -2 },
      read: (root) => root.compactKeepTurns,
      want: DEFAULT_COMPACT_KEEP_TURNS,
    },
  ];

  it.each(CONFIG_ROWS)("config.json $name", async ({ config, read, want }) => {
    const system = await mkdtemp(join(tmpdir(), "harness-reflect-"));
    await writeJson(join(system, "config.json"), config);
    const plexus = KernelPlexus.bootstrap();
    reflectKernel(system, plexus.root);
    expect(read(plexus.root)).toEqual(want);
    plexus.doc.destroy();
  });

  it("leftover kernel image without reActLoopIntentDetectedTrigger still reflects config.json", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-reflect-"));
    await writeJson(join(system, "config.json"), {
      connections: {},
      reActLoopIntentDetectedTrigger: { enabled: true, models: { "c:m": true } },
    });
    const plexus = KernelPlexus.bootstrap();
    plexus.root.reActLoopIntentDetectedTrigger = null as unknown as ReActLoopIntentDetectedTrigger;
    reflectKernel(system, plexus.root);
    expect({
      enabled: plexus.root.reActLoopIntentDetectedTrigger.enabled,
      models: { ...plexus.root.reActLoopIntentDetectedTrigger.models },
    }).toEqual({ enabled: true, models: { "c:m": true } });
    plexus.doc.destroy();
  });

  it("a config.json that stops parsing drops the user authorization layer (dist defaults)", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-reflect-"));
    await writeJson(join(system, "config.json"), { connections: {}, authorization: { yolo: { default: "deny" } } });
    const plexus = KernelPlexus.bootstrap();
    reflectKernel(system, plexus.root);
    expect(JSON.parse(plexus.root.authorizationJson)).toEqual({ yolo: { default: "deny" } });
    await writeFile(join(system, "config.json"), '{ "authorization": { "yolo": ');
    reflectKernel(system, plexus.root);
    expect(plexus.root.authorizationJson).toBe("");
    plexus.doc.destroy();
  });

  it("grants.json is reflected: valid rows only, an unreadable file grants nothing", async () => {
    const system = await mkdtemp(join(tmpdir(), "harness-reflect-"));
    const row = {
      id: "g1",
      scope: "global",
      scopeKey: "",
      subject: { kind: "tool", name: "web_extract" },
      createdAtMs: 1,
      expiresAtMs: null,
      source: "settings",
      label: "tool web_extract",
    };
    await writeJson(join(system, "config.json"), { connections: {} });
    await writeJson(join(system, "grants.json"), [row, { id: "bad" }]);
    const plexus = KernelPlexus.bootstrap();
    reflectKernel(system, plexus.root);
    // a row that does not parse invalidates the file: fail closed, nothing is granted
    expect(plexus.root.grantsJson).toBe("");
    await writeJson(join(system, "grants.json"), [row]);
    reflectKernel(system, plexus.root);
    expect(JSON.parse(plexus.root.grantsJson)).toEqual([row]);
    await writeFile(join(system, "grants.json"), "[");
    reflectKernel(system, plexus.root);
    expect(plexus.root.grantsJson).toBe("");
    plexus.doc.destroy();
  });
});

it("nous connection projects web-nous intern; drop removes it", async () => {
  const system = await mkdtemp(join(tmpdir(), "harness-nous-gateway-"));
  await writeJson(join(system, "config.json"), {
    connections: {
      "nous-portal": {
        driver: "nous",
        name: "Nous Portal",
        settings: { baseUrl: "https://inference-api.nousresearch.com/v1" },
      },
    },
  });
  const plexus = KernelPlexus.bootstrap();
  reflectKernel(system, plexus.root);
  const intern = plexus.root.connections["web-nous"];
  expect({
    name: intern?.name,
    annotation: intern?.annotation,
    driver: intern?.driver.name,
    abilityClaim: intern?.driver.abilityClaim,
    configuration: intern?.configuration,
  }).toEqual({
    name: "nous-gateway",
    annotation: "Nous Tool Gateway",
    driver: "web-nous",
    abilityClaim: ["web-search", "web-extract"],
    configuration: {
      apiUrl: "https://firecrawl-gateway.nousresearch.com",
      sourceConnection: "nous-portal",
    },
  });
  plexus.doc.destroy();

  await writeJson(join(system, "config.json"), { connections: {} });
  const gone = KernelPlexus.bootstrap();
  reflectKernel(system, gone.root);
  expect(gone.root.connections["web-nous"]).toBeUndefined();
  gone.doc.destroy();
});
