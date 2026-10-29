/** runWatch: period door, done-condition reachability, and the tick clock. */
import { EnvCapability, jsToScheme, type CallCtx } from "@here.build/arrival";
import { PERIOD_BREAKER_ERR, ProgrammaticJob, SystemToolJob } from "@inhuman.tools/harness-model";
import { PERIOD_ERR } from "@inhuman.tools/harness-model/schemas";
import { type ProgramHost } from "@inhuman.tools/scheme-program";
import { DoorSession } from "@inhuman.tools/substrate/doors";
import { describe, expect, it, vi } from "vitest";

import { runWatch } from "../run.js";

const MINUTE = "1 minutes";

function outcomeOf(chunk: ProgrammaticJob): { ok: boolean; text?: string; value?: unknown } {
  return JSON.parse(chunk.receiptJson ?? "null") as { ok: boolean; text?: string; value?: unknown };
}

function watch(expr: string, extra: Record<string, unknown> = {}, id = "w"): ProgrammaticJob {
  return new ProgrammaticJob({
    toolName: "scheme_watch",
    toolCallId: id,
    argsJson: JSON.stringify({ description: "test", expr, ...extra }),
  });
}

function host(prepare?: ProgramHost["prepare"], signal?: AbortSignal): ProgramHost {
  return {
    identity: {},
    signal,
    doors: new DoorSession(() => {}),
    root: "/tmp",
    tools: () => new Map(),
    prepare: prepare ?? (() => ({ capabilities: [], config: {} })),
  };
}

function counterCapability(ticks: { n: number }): EnvCapability {
  return EnvCapability.define("test/scheme-watch-counter", {
    symbols: (declare, sz) => ({
      ticks: declare.native`ticks: increments once per call`(
        { input: [], output: [sz.schemeValue] },
        function (this: CallCtx) {
          ticks.n += 1;
          return jsToScheme(this.runCtx, ticks.n);
        },
      ),
    }),
  });
}

function stepCapability(state: { n: number }): EnvCapability {
  return EnvCapability.define("test/scheme-watch-step", {
    symbols: (declare, sz) => ({
      step: declare.native`step: throws on the first call`(
        { input: [], output: [sz.schemeValue] },
        function (this: CallCtx) {
          state.n += 1;
          if (state.n === 1) throw new Error("boom");
          return jsToScheme(this.runCtx, true);
        },
      ),
    }),
  });
}

async function reachWait(chunk: ProgrammaticJob): Promise<void> {
  for (let i = 0; i < 50 && chunk.periodWaitUntilMs == null && !chunk.completed; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
  if (chunk.periodWaitUntilMs == null && !chunk.completed) {
    throw new Error(`watch did not wait: ${chunk.receiptJson ?? "pending"}`);
  }
}

describe("runWatch", () => {
  it("rejects a bad period and an unreachable done-condition; a reachable call seals", async () => {
    const repl = host();
    const missing = watch("(tick)", {}, "missing");
    const bad = watch("(+ 1 2)", { period: "5" }, "bad");
    const numbered = watch("(+ 1 2)", { period: 1 }, "numbered");
    const noBreaker = watch("(+ 1 2)", { period: MINUTE }, "no-breaker");
    const quoted = watch("(quote (meta-reactivity/done-condition #t))", { period: MINUTE }, "quoted");
    const lambdaOnly = watch("(lambda () (meta-reactivity/done-condition #t))", { period: MINUTE }, "lambda");
    const deadIf = watch("(if #f (meta-reactivity/done-condition #t) 1)", { period: MINUTE }, "dead-if");
    const sealed = watch('(meta-reactivity/done-condition #t "merged")', { period: MINUTE }, "sealed");
    const iife = watch('((lambda () (meta-reactivity/done-condition #t "ok")))', { period: MINUTE }, "iife");
    await Promise.all(
      [missing, bad, numbered, noBreaker, quoted, lambdaOnly, deadIf, sealed, iife].map((chunk) =>
        runWatch(chunk, repl),
      ),
    );
    expect({
      missing: outcomeOf(missing).text,
      bad: outcomeOf(bad).text,
      numbered: outcomeOf(numbered).text,
      noBreaker: outcomeOf(noBreaker).text,
      quoted: outcomeOf(quoted).text,
      lambdaOnly: outcomeOf(lambdaOnly).text,
      deadIf: outcomeOf(deadIf).text,
      sealed: outcomeOf(sealed),
      iife: outcomeOf(iife),
    }).toEqual({
      missing: expect.stringContaining(PERIOD_ERR),
      bad: expect.stringContaining(PERIOD_ERR),
      numbered: expect.stringContaining(PERIOD_ERR),
      noBreaker: expect.stringContaining(PERIOD_BREAKER_ERR),
      quoted: expect.stringContaining(PERIOD_BREAKER_ERR),
      lambdaOnly: expect.stringContaining(PERIOD_BREAKER_ERR),
      deadIf: expect.stringContaining(PERIOD_BREAKER_ERR),
      sealed: { ok: true, value: ["merged"] },
      iife: { ok: true, value: ["ok"] },
    });
  });

  it("re-evaluates on the period, parks without sealing, and cancel leaves a finished child", async () => {
    vi.useFakeTimers();
    try {
      const ticks = { n: 0 };
      const clock = watch(
        "(let ((n (ticks))) (meta-reactivity/done-condition (> n 1) n))",
        { period: MINUTE },
        "clock",
      );
      const clockRun = runWatch(
        clock,
        host(() => ({ capabilities: [counterCapability(ticks)], config: {} })),
      );
      await reachWait(clock);
      const afterFirst = { n: ticks.n, completed: clock.completed };
      await vi.advanceTimersByTimeAsync(60_000);
      await clockRun;

      const parked = watch("(meta-reactivity/done-condition #f)", { period: MINUTE }, "parked");
      const park = new AbortController();
      const parkRun = runWatch(parked, host(undefined, park.signal));
      await reachWait(parked);
      park.abort("park");
      await parkRun;

      const prior = new SystemToolJob({
        name: "tick",
        toolCallId: "cancel:prior",
        completed: true,
        humanApprove: true,
        outcomeJson: JSON.stringify({ ok: true, value: 1 }),
      });
      const cancelled = watch("(meta-reactivity/done-condition #f)", { period: MINUTE }, "cancel");
      cancelled.children.push(prior);
      const abort = new AbortController();
      const cancelRun = runWatch(cancelled, host(undefined, abort.signal));
      await reachWait(cancelled);
      abort.abort(new Error("cancelled"));
      await cancelRun;

      const state = { n: 0 };
      const recovered = watch('(step) (meta-reactivity/done-condition #t "ok")', { period: MINUTE }, "recovered");
      const recoverRun = runWatch(
        recovered,
        host(() => ({ capabilities: [stepCapability(state)], config: {} })),
      );
      await reachWait(recovered);
      const failedNote = recovered.notifications.some((note) => note.message.includes("boom"));
      await vi.advanceTimersByTimeAsync(60_000);
      await recoverRun;

      expect({
        clock: { afterFirst, outcome: outcomeOf(clock) },
        parked: { completed: parked.completed, receipt: parked.receiptJson },
        cancel: {
          completed: cancelled.completed,
          cancelled: cancelled.cancelled,
          priorCancelled: prior.cancelled,
          text: outcomeOf(cancelled).text,
        },
        recovered: { calls: state.n, failedNote, outcome: outcomeOf(recovered) },
      }).toEqual({
        clock: { afterFirst: { n: 1, completed: false }, outcome: { ok: true, value: ["2"] } },
        parked: { completed: false, receipt: null },
        cancel: {
          completed: true,
          cancelled: true,
          priorCancelled: false,
          text: "Error: Scheme REPL call cancelled",
        },
        recovered: { calls: 2, failedNote: true, outcome: { ok: true, value: ["ok"] } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
