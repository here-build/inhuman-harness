import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { exec } from "@here.build/arrival";
import { expect, test } from "vitest";

import { rpcCapability } from "../rpcCapability.js";
import { uiCapability, UiNode } from "../uiCapability.js";

const PLUGINS = fileURLToPath(new URL("../../../../../plugins/", import.meta.url));

async function surface(path: string, reply: unknown): Promise<{ node: UiNode; reads: unknown[] }> {
  const reads: unknown[] = [];
  const values = await exec(readFileSync(PLUGINS + path, "utf8"), {
    capabilities: [uiCapability, rpcCapability],
    config: {
      rpc: (method: string, params: unknown) => {
        reads.push({ method, params });
        return reply;
      },
    },
  });
  const node = values.at(-1);
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
