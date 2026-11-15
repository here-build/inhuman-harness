import { prompt } from "@inhuman.tools/harness-commons";
import { describe, expect, it } from "vitest";
import { z as z } from "zod";

import {
  InhumanAction,
  InhumanPlugin,
  InhumanTool,
  normalizeDefinitions,
  type ActivatedProjectPlugin,
} from "../index.js";

const ping = new InhumanTool({
  name: "ping",
  class: "read",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  run: () => ({ ok: true }),
});

describe("InhumanPlugin", () => {
  it("accepts an empty bag", () => {
    const p = new InhumanPlugin({});
    expect(p.tools).toEqual([]);
    expect(InhumanPlugin.isInhumanPlugin(p)).toBe(true);
  });

  it("holds tools and actions", () => {
    const sync = new InhumanAction({ name: "sync", run: async () => ({ ok: true }) });
    const p = new InhumanPlugin({
      tools: [ping],
      actions: [sync],
    });
    expect(p.tools).toEqual([ping]);
  });

  it("rejects a non-tool in tools", () => {
    expect(
      () =>
        new InhumanPlugin({
          tools: [{ name: "x", input: z.object({}), output: z.object({}) } as never],
        }),
    ).toThrow(/run/);
  });

  it("rejects a non-action in actions", () => {
    expect(() => new InhumanPlugin({ actions: [{ name: "bad" } as never] })).toThrow(/function required/);
  });

  it("rejects colliding action names", () => {
    const a = new InhumanAction({ name: "sync", run: () => undefined });
    const b = new InhumanAction({ name: "sync", run: () => undefined });
    expect(() => new InhumanPlugin({ actions: [a, b] })).toThrow(/collides/);
  });

  it("holds bots with description and invokes", () => {
    const p = new InhumanPlugin({
      bots: [
        {
          name: "reviewer",
          recipeScope: "session",
          description: "standing critic",
          instructions: prompt.system`cite file:line`,
        },
        {
          name: "implementer",
          recipeScope: "session",
          instructions: prompt.system`smallest change`,
          invokes: ["reviewer"],
        },
      ],
    });
    expect({
      names: p.bots.map((bot) => bot.name),
      invoke: p.bots.find((bot) => bot.name === "implementer")?.invokes,
      description: p.bots.find((bot) => bot.name === "reviewer")?.description,
    }).toEqual({
      names: ["reviewer", "implementer"],
      invoke: ["reviewer"],
      description: "standing critic",
    });
  });

  it("holds a projection and tool flags", () => {
    const p = new InhumanPlugin({
      projection: {
        initial: () => ({ n: 0 }),
        reduce: (state: { n: number }, action: { d: number }) => ({ n: state.n + action.d }),
      },
      tools: [
        new InhumanTool({
          name: "note",
          class: "meta",
          triggersReactLoop: false,
          tapeHidden: true,
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          run: () => ({ ok: true }),
        }),
      ],
    });
    expect({
      n: p.projection?.reduce(p.projection.initial() as { n: number }, { d: 2 }),
      flags: { loop: p.tools[0]!.triggersReactLoop, hidden: p.tools[0]!.tapeHidden },
    }).toEqual({
      n: { n: 2 },
      flags: { loop: false, hidden: true },
    });
  });

  it("rejects invokes of an unknown bot", () => {
    expect(
      () =>
        new InhumanPlugin({
          bots: [
            {
              name: "implementer",
              recipeScope: "session",
              instructions: prompt.system`go`,
              invokes: ["ghost"],
            },
          ],
        }),
    ).toThrow(/invokes unresolved "ghost"/);
  });

  it("preserves projectConfigSchema and activateProject across InhumanPlugin and normalizeDefinitions", async () => {
    const projectConfigSchema = z.object({ sandboxId: z.string().min(1) });
    const plugin = new InhumanPlugin({
      projectConfigSchema,
      activateProject: async (ctx, config): Promise<ActivatedProjectPlugin> => ({
        workspaceEnv: {
          logicalRoot: `/vfs/${ctx.projectId}/${config.sandboxId}`,
          resolveCanonicalPath: (p) => p,
        },
        async [Symbol.asyncDispose]() {},
      }),
    });

    expect(plugin.projectConfigSchema).toBe(projectConfigSchema);
    expect(typeof plugin.activateProject).toBe("function");

    const normalized = normalizeDefinitions(plugin, "vfs-test");
    expect(normalized.projectConfigSchema).toBe(projectConfigSchema);
    expect(normalized.activateProject).toBe(plugin.activateProject);

    const activated = await normalized.activateProject?.(
      { kernelId: "k1", projectId: "p1", kind: "virtual", workspacePath: "/vfs/p1" },
      { sandboxId: "sb-42" },
    );
    expect(activated?.workspaceEnv?.logicalRoot).toBe("/vfs/p1/sb-42");
    await activated?.[Symbol.asyncDispose]?.();
  });
});
