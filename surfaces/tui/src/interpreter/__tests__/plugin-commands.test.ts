import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ConnectionSpec } from "@inhuman.tools/expectations";
import { InstalledPlugin, KernelRoot, SessionRoot, SessionTurn } from "@inhuman.tools/harness-model";
import { expect, test } from "vitest";

import { buildEffortSurface, effortChoices, evalUiSurface, UiNode } from "../uiCapability.js";

const PLUGINS = fileURLToPath(new URL("../../../../../plugins/", import.meta.url));
const DEFAULTS = fileURLToPath(
  new URL("../../../../../packages/harness/src/server/defaults/commands/", import.meta.url),
);

async function surface(path: string, reply: unknown): Promise<{ node: UiNode; reads: unknown[] }> {
  const reads: unknown[] = [];
  const node = evalUiSurface(readFileSync(PLUGINS + path, "utf8"), {
    rpc: (method: string, params: unknown) => {
      reads.push({ method, params });
      return reply;
    },
  });
  expect(node).toBeInstanceOf(UiNode);
  return { node: node as UiNode, reads };
}

function leaves(node: UiNode) {
  return {
    action: node.action.map((leaf) => ({ op: leaf.op, params: leaf.params })),
    rows: node.choices.map((row) => ({
      name: row.name,
      description: row.description,
      action: row.action.map((leaf) => ({ op: leaf.op, params: leaf.params })),
    })),
  };
}

test("/goal sets from the composer text, shows status, and clears through the plugin's state", async () => {
  const { node, reads } = await surface("inhuman-plugin-goal/tools/inhuman/commands/goal.scm", {
    ok: true,
    value: { text: "ship it", status: "active", loops: 3 },
  });
  expect({ reads, ...leaves(node) }).toEqual({
    reads: [
      {
        method: "plugin/method",
        params: { plugin: "inhuman-plugin-goal", method: "get" },
      },
    ],
    action: [
      {
        op: "plugin/method",
        params: {
          plugin: "inhuman-plugin-goal",
          method: "set",
          args: '{"loops": 32}',
          field: "text",
          input: "",
        },
      },
    ],
    rows: [
      {
        name: "status",
        description: "active · 3 loops left · ship it",
        action: [],
      },
      {
        name: "clear",
        description: "Drop the session goal",
        action: [
          {
            op: "plugin/method",
            params: { plugin: "inhuman-plugin-goal", method: "clear" },
          },
        ],
      },
    ],
  });
});

test("/plan opens from the composer text; a failed status read still renders", async () => {
  const { node } = await surface("inhuman-plugin-fusion/tools/inhuman/commands/plan.scm", {
    ok: false,
    error: "plugin fusion is not enabled",
  });
  expect(leaves(node)).toEqual({
    action: [
      {
        op: "plugin/method",
        params: {
          plugin: "fusion",
          method: "open",
          args: '{"steps": 8}',
          field: "text",
          input: "",
        },
      },
    ],
    rows: [
      {
        name: "status",
        description: "plugin fusion is not enabled",
        action: [],
      },
      {
        name: "clear",
        description: "Drop the session plan",
        action: [
          {
            op: "plugin/method",
            params: { plugin: "fusion", method: "clear" },
          },
        ],
      },
    ],
  });
});

test("/plugins lists installed plugins with toggle/foreground/remove actions and offers uninstalled default plugins", () => {
  const kernel = new KernelRoot();
  kernel.plugins.tasks = new InstalledPlugin({
    pluginName: "tasks",
    description: "Session notebook pages with a frozen exam, and project promotion of an accepted task.",
    sourceNpm: "@inhuman.tools/plugin-tasks",
    sourceVersion: "0.2.0",
    enabled: true,
    foreground: true,
  });
  const fusion = new InstalledPlugin({
    pluginName: "fusion",
    sourceNpm: "@inhuman.tools/plugin-fusion",
    sourceVersion: "0.0.1",
    enabled: false,
    foreground: false,
  });
  kernel.plugins.fusion = fusion;
  const node = evalUiSurface(readFileSync(`${DEFAULTS}plugins.scm`, "utf8"), { kernel });
  expect(node).toBeInstanceOf(UiNode);
  const root = node as UiNode;
  expect({
    action: root.action.map((leaf) => ({ op: leaf.op, params: leaf.params })),
    choices: root.choices.map((row) => ({
      name: row.name,
      aliases: row.aliases,
      annotation: row.annotation,
      health: row.health,
      action: row.action.map((leaf) => ({ op: leaf.op, name: leaf.name, params: leaf.params })),
      alts: row.alternateActions.map((leaf) => ({
        op: leaf.op,
        name: leaf.name,
        hotkey: leaf.hotkey,
        params: leaf.params,
      })),
    })),
  }).toEqual({
    action: [{ op: "plugin/install", params: { spec: "" } }],
    choices: [
      {
        name: "tasks",
        aliases: ["todos"],
        annotation: "0.2.0",
        health: "ok",
        action: [{ op: "plugin/set", name: "Disable plugin", params: { name: "tasks", enabled: false } }],
        alts: [
          {
            op: "plugin/set",
            name: "Disable foreground",
            hotkey: "control-f",
            params: { name: "tasks", foreground: false },
          },
          {
            op: "plugin/remove",
            name: "Remove plugin",
            hotkey: "control-x",
            params: { name: "tasks", confirm: false },
          },
        ],
      },
      {
        name: "fusion",
        aliases: ["plan"],
        annotation: "0.0.1 · disabled",
        health: "degraded",
        action: [{ op: "plugin/set", name: "Enable plugin", params: { name: "fusion", enabled: true } }],
        alts: [
          {
            op: "plugin/set",
            name: "Enable foreground",
            hotkey: "control-f",
            params: { name: "fusion", foreground: true },
          },
          {
            op: "plugin/remove",
            name: "Remove plugin",
            hotkey: "control-x",
            params: { name: "fusion", confirm: false },
          },
        ],
      },
      {
        name: "inhuman-plugin-goal",
        aliases: ["goal", "goals"],
        annotation: "not installed",
        health: "degraded",
        action: [{ op: "plugin/install", name: "Install plugin", params: { spec: "@inhuman.tools/plugin-goal" } }],
        alts: [],
      },
      {
        name: "offload-tingle",
        aliases: ["memory"],
        annotation: "not installed",
        health: "degraded",
        action: [
          { op: "plugin/install", name: "Install plugin", params: { spec: "@inhuman.tools/plugin-offload-tingle" } },
        ],
        alts: [],
      },
      {
        name: "Install plugin",
        aliases: [],
        annotation: "",
        health: "ok",
        action: [{ op: "plugin/install", name: "Install plugin", params: {} }],
        alts: [],
      },
    ],
  });
});

test("/effort builds model-filtered effort choices and annotates current and cache-drop transitions", () => {
  const kernel = new KernelRoot();
  const conn = new ConnectionSpec({
    id: "openai",
    name: "OpenAI",
  });
  conn.configuration = { baseUrl: "https://api.openai.com/v1" };
  conn.live = {
    modelCapabilities: {
      o3: {
        supportsReasoning: true,
        reasoningEfforts: ["low", "medium", "high"],
      },
    },
  };
  kernel.connections.openai = conn;

  const session = new SessionRoot();
  session.kvs.connection = "openai";
  session.kvs.model = "o3";
  session.kvs.reasoningEffort = "medium";
  session.agent.spec.reasoningEffort = "high";

  const coldChoices = effortChoices(kernel, session).map((c) => ({
    name: c.name,
    description: c.description,
    annotation: c.annotation,
    value: c.action[0]?.params.value,
  }));
  expect(coldChoices).toEqual([
    { name: "default", description: "default (high)", annotation: "", value: "" },
    { name: "low", description: "", annotation: "", value: "low" },
    { name: "medium", description: "current", annotation: "current", value: "medium" },
    { name: "high", description: "", annotation: "", value: "high" },
  ]);

  session.head = new SessionTurn();
  const warmSurface = buildEffortSurface(kernel, session);
  expect({
    action: warmSurface.action.map((a) => ({ op: a.op, name: a.name, params: a.params })),
    choices: warmSurface.choices.map((c) => ({
      name: c.name,
      description: c.description,
      annotation: c.annotation,
      value: c.action[0]?.params.value,
    })),
  }).toEqual({
    action: [
      {
        op: "kv/set",
        name: "Set reasoning effort",
        params: { key: "reasoningEffort", value: "", remember: "1" },
      },
    ],
    choices: [
      { name: "default", description: "default (high) · drops cache", annotation: "drops cache", value: "" },
      { name: "low", description: "drops cache", annotation: "drops cache", value: "low" },
      { name: "medium", description: "current", annotation: "current", value: "medium" },
      { name: "high", description: "drops cache", annotation: "drops cache", value: "high" },
    ],
  });

  const fromCommandFile = evalUiSurface(readFileSync(`${DEFAULTS}effort.scm`, "utf8"), { kernel, session });
  expect(fromCommandFile?.choices.map((c) => c.name)).toEqual(["default", "low", "medium", "high"]);

  // Anthropic model uses "drops message cache" when warm, and preserves when target matches effective effort
  session.kvs.model = "claude-opus-4-6";
  delete session.kvs.reasoningEffort;
  const anthropicWarm = effortChoices(kernel, session).map((c) => ({
    name: c.name,
    description: c.description,
    annotation: c.annotation,
  }));
  expect(anthropicWarm).toEqual([
    { name: "default", description: "default (high) · current", annotation: "current" },
    { name: "off", description: "drops message cache", annotation: "drops message cache" },
    { name: "low", description: "drops message cache", annotation: "drops message cache" },
    { name: "medium", description: "drops message cache", annotation: "drops message cache" },
    { name: "high", description: "", annotation: "" },
    { name: "max", description: "drops message cache", annotation: "drops message cache" },
  ]);
});
