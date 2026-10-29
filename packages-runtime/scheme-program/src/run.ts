/**
 * One-shot Scheme program. The host passes the vocabulary. `period` is rejected
 * here; ongoing evaluation is the watchdog.
 */
import { parse, type SchemeValue } from "@here.build/arrival";
import { ProgrammaticJob } from "@inhuman.tools/harness-model";
import { callArgsSchema, REPL_PERIOD_ERR } from "@inhuman.tools/harness-model/schemas";
import { unwrapTopLevelBegins } from "@inhuman.tools/substrate/unwrap-begin";

import {
  createEvaluationTimeout,
  displayPrinted,
  errorText,
  evaluateForms,
  fail,
  guardProgram,
  observed,
  printedValues,
  sealChunk,
  type EvalOutcome,
  type SharedEval,
} from "./evaluate.js";
import type { ProgramHost } from "./host.js";
import { openProgram } from "./open.js";
import { programRuntimeOf } from "./runtime.js";

function rawHasPeriod(raw: unknown): boolean {
  return raw !== null && typeof raw === "object" && "period" in raw;
}

export async function runProgram(chunk: ProgrammaticJob, host: ProgramHost): Promise<void> {
  await guardProgram(chunk, host, async () => {
    const rawArgs = chunk.args;
    if (rawHasPeriod(rawArgs)) {
      sealChunk(chunk, fail(`Error: ${REPL_PERIOD_ERR}`));
      return;
    }
    const parsed = callArgsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid arguments";
      sealChunk(chunk, fail(`Error: ${issue}`));
      return;
    }
    const opened = await openProgram(chunk, host, parsed.data);
    if (opened == null) return;

    const runtime = programRuntimeOf(chunk, host);
    runtime.arm({ watching: false, moduleRoot: opened.moduleRoot });
    const sourceText = opened.source.source;
    let sourceForms: readonly SchemeValue[] | undefined;
    if (sourceText != null) {
      try {
        sourceForms = unwrapTopLevelBegins(await parse(sourceText));
      } catch (error) {
        sealChunk(chunk, fail(errorText(error)));
        return;
      }
    }
    const limits = { timeoutMs: opened.timeoutMs, maxInternalCalls: opened.maxInternalCalls };
    const outcome: EvalOutcome = await observed(host, async (trace) => {
      if (sourceForms === undefined) {
        return evaluateForms(chunk, host, opened.forms, { kind: "once", ...limits, trace }, runtime);
      }
      const timeout = createEvaluationTimeout(host.signal, opened.timeoutMs);
      const shared: SharedEval = { signal: timeout.signal };
      try {
        const loaded = await evaluateForms(
          chunk,
          host,
          sourceForms,
          { kind: "source-load", ...limits, shared, trace },
          runtime,
        );
        return loaded.kind === "ok"
          ? await evaluateForms(chunk, host, opened.forms, { kind: "source-body", ...limits, shared, trace }, runtime)
          : loaded;
      } finally {
        timeout.dispose();
      }
    });
    if (outcome.kind === "park") return;
    if (outcome.kind === "halt") {
      sealChunk(chunk, outcome.result);
      return;
    }
    if (outcome.kind === "fail") {
      sealChunk(chunk, fail(outcome.values.map(displayPrinted).join("\n\n"), outcome.code));
      return;
    }
    const sealed: {
      ok: true;
      value: ReturnType<typeof printedValues>;
      json?: unknown;
      jsonError?: string;
    } = {
      ok: true,
      value: printedValues(outcome.values, opened.kinds),
    };
    if (outcome.jsonError != null) sealed.jsonError = outcome.jsonError;
    else if ("json" in outcome) sealed.json = outcome.json;
    sealChunk(chunk, sealed);
  });
}
