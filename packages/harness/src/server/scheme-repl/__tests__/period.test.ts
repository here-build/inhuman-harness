/** Period clock on ProgrammaticJob: ticks, done-condition, notify, join. */
import { AgentCallNotification, ProgrammaticJob, SystemToolJob, periodMsOf } from "@inhuman.tools/harness-model";
import { callArgsSchema, watchArgsSchema } from "@inhuman.tools/harness-model/schemas";
import { boundToolsOf, interpretSchemeRepl, type SchemeReplHost } from "@inhuman.tools/harness-scheme";
import { InhumanPlugin, InhumanTool } from "@inhuman.tools/plugin-sdk";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { joinReleased } from "@inhuman.tools/turn/agent-calls";
import { when } from "mobx";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { applyPackPlugins } from "../../toolkit/actor.js";
import { KernelToolCatalog, workerToolAllowed } from "../../toolkit/tool-table.js";

const MINUTE = "1 minutes";

async function sealWatch(chunk: ProgrammaticJob, host: SchemeReplHost): Promise<void> {
  vi.useFakeTimers();
  try {
    const run = interpretSchemeRepl(chunk, host);
    await when(() => chunk.completed || chunk.periodWaitUntilMs != null);
    while (!chunk.completed) {
      await vi.advanceTimersByTimeAsync(periodMsOf(MINUTE));
      await when(() => chunk.completed || chunk.periodWaitUntilMs != null);
    }
    await run;
  } finally {
    vi.useRealTimers();
  }
}

function outcomeOf(chunk: ProgrammaticJob): { ok: boolean; text?: string; value?: unknown } {
  return JSON.parse(chunk.receiptJson ?? "null") as { ok: boolean; text?: string; value?: unknown };
}

async function packCatalog(): Promise<KernelToolCatalog> {
  const catalog = new KernelToolCatalog();
  const tick = new InhumanTool({
    name: "tick",
    class: "read",
    input: z.object({}),
    output: z.unknown(),
    run: () => 0,
  });
  const boom = new InhumanTool({
    name: "boom",
    class: "read",
    input: z.object({}),
    output: z.unknown(),
    run: () => {
      throw new Error("boom");
    },
  });
  await applyPackPlugins(catalog, [{ pluginName: "period-pack", module: new InhumanPlugin({ tools: [tick, boom] }) }]);
  return catalog;
}

function hostOf(catalog: KernelToolCatalog, extras: Partial<SchemeReplHost> = {}): SchemeReplHost {
  let ticks = 0;
  return {
    catalog,
    root: "/tmp",
    doors: new DoorSession(),
    admit: (call) => {
      const name = call.function.name;
      if (name === "boom") {
        return new SystemToolJob({
          name,
          toolCallId: call.id,
          completed: true,
          humanApprove: true,
          outcomeJson: JSON.stringify({ ok: false, text: "boom" }),
        });
      }
      ticks += 1;
      return new SystemToolJob({
        name,
        toolCallId: call.id,
        completed: true,
        humanApprove: true,
        outcomeJson: JSON.stringify({ ok: true, value: ticks }),
      });
    },
    ...extras,
  };
}

describe("scheme_watch", () => {
  it("notifies across ticks and completes when the host cancels", async () => {
    const watch = new ProgrammaticJob({
      toolName: "scheme_watch",
      background: true,
      argsJson: JSON.stringify({
        description: "test",
        expr: '(self/notify "new comment") (meta-reactivity/done-condition #f)',
        period: MINUTE,
      }),
    });
    const controller = new AbortController();
    const notifyHost = hostOf(await packCatalog(), { signal: controller.signal });
    let afterFirst = 0;
    let afterSecond = { completed: true, notes: 0 };
    vi.useFakeTimers();
    try {
      const run = interpretSchemeRepl(watch, notifyHost);
      await when(() => watch.periodWaitUntilMs != null);
      afterFirst = watch.notifications.length;
      await vi.advanceTimersByTimeAsync(periodMsOf(MINUTE));
      await when(() => watch.notifications.length === 2 && watch.periodWaitUntilMs != null);
      afterSecond = { completed: watch.completed, notes: watch.notifications.length };
      controller.abort(new Error("cancelled"));
      await run;
    } finally {
      vi.useRealTimers();
    }

    expect({ afterFirst, afterSecond, completed: watch.completed, notes: watch.notifications.length }).toEqual({
      afterFirst: 1,
      afterSecond: { completed: false, notes: 2 },
      completed: true,
      notes: 2,
    });
  });

  it("self/notify seals, replay does not remint, nested scheme_watch stays unbound, and joinReleased follows background", async () => {
    const catalog = new KernelToolCatalog();
    const bound = boundToolsOf(catalog);
    const watchExpr = "(meta-reactivity/done-condition #f)";
    const host = hostOf(await packCatalog());

    const nested = new ProgrammaticJob({
      argsJson: JSON.stringify({
        description: "test",
        expr: '(scheme_watch (dict :expr "(+ 1 2)" :period "1 minutes"))',
      }),
    });
    await interpretSchemeRepl(nested, host);

    const packed = await packCatalog();
    const packedHost = hostOf(packed);
    const sealedOnce = new ProgrammaticJob({
      toolName: "scheme_watch",
      toolCallId: "once",
      argsJson: JSON.stringify({
        description: "test",
        expr: '(self/notify "hello") (meta-reactivity/done-condition #t "merged")',
        period: MINUTE,
      }),
    });
    await interpretSchemeRepl(sealedOnce, packedHost);

    const bag = new ProgrammaticJob({
      toolName: "scheme_watch",
      toolCallId: "recall",
      argsJson: JSON.stringify({ description: "test", expr: "(+ 1 2)" }),
      orchestrationResult: true,
    });
    bag.notifications.push(new AgentCallNotification({ message: "from the watch" }));
    const catalogEmpty = new KernelToolCatalog();
    const joinFg = joinReleased(bag, catalogEmpty);
    bag.background = true;
    const joinBg = joinReleased(bag, catalogEmpty);

    const full = new ProgrammaticJob({
      toolName: "scheme_watch",
      toolCallId: "full",
      argsJson: JSON.stringify({
        description: "test",
        expr: `${"(tick) ".repeat(16)}(meta-reactivity/done-condition #t "ok")`,
        period: MINUTE,
      }),
    });
    for (let i = 0; i < 16; i++) {
      full.children.push(
        new SystemToolJob({
          name: "tick",
          toolCallId: `full:inner:${i + 1}`,
          completed: true,
          humanApprove: true,
          outcomeJson: JSON.stringify({ ok: true, value: i + 1 }),
        }),
      );
    }
    await interpretSchemeRepl(full, hostOf(packed));

    const comments = new InhumanTool({
      name: "comments",
      class: "read",
      input: z.object({}),
      output: z.unknown(),
      run: () => [],
    });
    await applyPackPlugins(packed, [
      { pluginName: "period-comments", module: new InhumanPlugin({ tools: [comments] }) },
    ]);
    let waves = 0;
    const delta = new ProgrammaticJob({
      toolName: "scheme_watch",
      toolCallId: "delta",
      argsJson: JSON.stringify({
        description: "test",
        expr: `(let ((xs (comments)))
                 (meta-reactivity/done-condition
                   (not (null? (meta-reactivity/added :identity :id xs)))
                   "seen"))`,
        period: MINUTE,
      }),
    });
    await sealWatch(
      delta,
      hostOf(packed, {
        admit: (call) => {
          if (call.function.name === "comments") {
            waves += 1;
            const rows = waves === 1 ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }];
            return new SystemToolJob({
              name: "comments",
              toolCallId: call.id,
              completed: true,
              humanApprove: true,
              outcomeJson: JSON.stringify({ ok: true, value: rows }),
            });
          }
          return hostOf(packed).admit(call);
        },
      }),
    );

    expect({
      registration: {
        replHasPeriod: "period" in callArgsSchema.shape,
        replBare: callArgsSchema.safeParse({ expr: "(+ 1 2)" }).success,
        replDescribed: callArgsSchema.safeParse({ expr: "(+ 1 2)", description: "add one and two" }).success,
        replEmptyDescription: callArgsSchema.safeParse({ expr: "(+ 1 2)", description: "   " }).success,
        replNonStringDescription: callArgsSchema.safeParse({ expr: "(+ 1 2)", description: 1 }).success,
        watchBare: watchArgsSchema.safeParse({ expr: "(+ 1 2)", period: "1 minutes" }).success,
        watchDescribed: watchArgsSchema.safeParse({
          expr: "(+ 1 2)",
          description: "add one and two",
          period: "1 minutes",
        }).success,
        tokens: Object.fromEntries(
          ["1 minutes", "2 hours", "3 days", null, 1, "0 minutes", "5", "1 seconds"].map((period) => [
            String(period),
            watchArgsSchema.safeParse({ expr: watchExpr, description: "test", period }).success,
          ]),
        ),
        required: catalog.catalogEntry("scheme_watch")?.parameters,
        execute: catalog.catalogEntry("scheme_watch")?.execute,
        boundRepl: bound.has("scheme_repl"),
        boundWatch: bound.has("scheme_watch"),
        workerWatch: workerToolAllowed(catalog, "quick-search", "scheme_watch"),
      },
      duration: {
        minutes: periodMsOf("1 minutes"),
        hours: periodMsOf("2 hours"),
        days: periodMsOf("3 days"),
      },
      nested: { text: JSON.stringify(outcomeOf(nested)), invocations: nested.toolCalls.length },
      seal: {
        once: { outcome: outcomeOf(sealedOnce), notes: sealedOnce.notifications.map((note) => note.message) },
      },
      recall: {
        joinFg,
        joinBg,
      },
      replay: {
        outcome: outcomeOf(full),
        inners: full.toolCalls.length,
        failed: full.notifications.length,
      },
      delta: outcomeOf(delta),
    }).toEqual({
      registration: {
        replHasPeriod: false,
        replBare: true,
        replDescribed: true,
        replEmptyDescription: true,
        replNonStringDescription: true,
        watchBare: true,
        watchDescribed: true,
        tokens: {
          "1 minutes": true,
          "2 hours": true,
          "3 days": true,
          null: false,
          "1": false,
          "0 minutes": false,
          "5": false,
          "1 seconds": false,
        },
        required: expect.objectContaining({ required: ["expr", "period"] }),
        execute: undefined,
        boundRepl: false,
        boundWatch: false,
        workerWatch: true,
      },
      duration: { minutes: 60_000, hours: 7_200_000, days: 259_200_000 },
      nested: { text: expect.stringMatching(/unbound|Unbound|scheme_watch cannot be invoked/i), invocations: 0 },
      seal: {
        once: { outcome: { ok: true, value: ["merged"] }, notes: ["hello"] },
      },
      recall: {
        joinFg: false,
        joinBg: true,
      },
      replay: {
        outcome: { ok: true, value: ["ok"] },
        inners: 16,
        failed: 0,
      },
      delta: { ok: true, value: ["seen"] },
    });
  }, 20_000);
});
