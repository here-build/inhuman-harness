/**
 * One Arrival evaluation of a ProgrammaticJob. Inner tools parent onto
 * `job.children`. Wait is Arrival's trampoline. Not catalog execute.
 */
import { execState, type LexicalScope, type SchemeValue } from "@here.build/arrival";
import { createDisplaySink } from "@here.build/arrival/host-internals";
import { EvalTrace } from "@here.build/arrival/provenance";
import { AString, AVoid } from "@here.build/arrival/reflect-internals";
import { toSExprString } from "@here.build/arrival-serializer";
import {
  armCrossings,
  crossingEpoch,
  markReplaying,
  CallJob,
  type ApprovableJob,
  cancelOutcomeText,
  isAbortError,
  isTimeoutAbortReason,
  MCPToolJob,
  ProgrammaticJob,
  cancelUnstarted,
  rememberJobResult,
  RESULT_NOTE_CHARS,
  SCHEME_REPL_NAMING,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { isTopLevelDisplay, stripTopLevelDisplay } from "@inhuman.tools/substrate";
import { importDoor, unboundInExprDoor } from "@inhuman.tools/substrate/doors";
import { type TopLevelSplice } from "@inhuman.tools/substrate/unwrap-begin";
import { action } from "mobx";

import { extendEmission, harnessEmission, type ProgramEmission } from "./emission.js";
import { failureCodeOf } from "./failure.js";
import { filePathOf } from "./file-path.js";
import type { ProgramHost, ProgramRuntime } from "./host.js";
import { SCHEME_REPL_DISPLAY_NOTE, SCHEME_REPL_UNWRAP_NOTES } from "./notes.js";
import { structuredJson } from "./source.js";

const rejectInner = action((leaf: ApprovableJob, reason?: unknown): void => {
  cancelUnstarted(leaf, reason);
  if (leaf instanceof CallJob) return;
});

const UNBOUND_VARIABLE = /Unbound variable [`']?([^`'\s]+)/;

export type FailResult = { readonly ok: false; readonly text: string; readonly code?: string };
export type FilePrint = {
  readonly text: string;
  readonly face: { readonly kind: "file"; readonly path: string };
};
export type PrintedValue = string | FilePrint;
export type ValueResult = {
  readonly ok: boolean;
  readonly value: PrintedValue[];
  readonly json?: unknown;
  readonly jsonError?: string;
};
export type CallResult = FailResult | ValueResult;

export type EvalOutcome =
  | {
      readonly kind: "ok";
      readonly values: PrintedValue[];
      readonly json?: unknown;
      readonly jsonError?: string;
    }
  | { readonly kind: "fail"; readonly values: PrintedValue[]; readonly code?: string }
  | { readonly kind: "halt"; readonly result: FailResult }
  | { readonly kind: "park" };

export type SharedEval = {
  scope?: LexicalScope;
  readonly signal: AbortSignal;
  emission?: ProgramEmission;
};

export type EvaluateOpts = {
  readonly timeoutMs: number | undefined;
  readonly maxInternalCalls: number | undefined;
  /** The host's trace for this run. Absent: a period tick mints its own, a one-shot goes untraced. */
  readonly trace?: EvalTrace;
} & (
  | { readonly kind: "once" }
  | { readonly kind: "period"; readonly tick: { readonly origin: number } }
  | { readonly kind: "source-load"; readonly shared: SharedEval }
  | { readonly kind: "source-body"; readonly shared: SharedEval }
);

export function errorText(error: unknown): string {
  if (isAbortError(error) && !isTimeoutAbortReason(error)) return "Error: Scheme REPL call cancelled";
  if (isTimeoutAbortReason(error)) {
    const text = cancelOutcomeText(error);
    return text.startsWith("Error:") ? text : `Error: ${text}`;
  }
  const raw = error instanceof Error ? error.message : String(error);
  return raw.startsWith("Error:") ? raw : `Error: ${raw}`;
}

export function fail(text: string, code?: string): FailResult {
  return code != null && code !== "" ? { ok: false, text, code } : { ok: false, text };
}

/** Strings stay raw (display); path-stamped file strings keep a TUI face. */
export function observationText(value: SchemeValue): PrintedValue {
  if (typeof value === "string") return value;
  if (value instanceof AString) {
    const text = value.valueOf();
    const path = filePathOf(value);
    if (path !== undefined && path !== "") return { text, face: { kind: "file", path } };
    return text;
  }
  return toSExprString(value);
}

export function displayPrinted(value: PrintedValue): string {
  return typeof value === "string" ? value : value.text;
}

function isParkAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === "park";
}

function timedOutText(timeoutMs: number | undefined): string {
  return timeoutMs == null ? "Error: evaluation timed out" : `Error: evaluation timed out after ${timeoutMs}ms`;
}

function haltResult(signal: AbortSignal, timeoutMs: number | undefined, error?: unknown): FailResult | undefined {
  if (isParkAbort(signal)) return undefined;
  if (signal.aborted) {
    const text = cancelOutcomeText(signal.reason);
    if (text === "timed out") return fail(timedOutText(timeoutMs));
    return fail(text === "cancelled" ? "Error: Scheme REPL call cancelled" : `Error: ${text}`);
  }
  if (error instanceof Error && /execution budget exceeded/.test(error.message)) {
    return fail(timedOutText(timeoutMs));
  }
  return undefined;
}

function resultNoteText(result: CallResult): string {
  if ("text" in result) return result.text;
  return result.value.map((item) => (typeof item === "string" ? item : item.text)).join(" ");
}

export function sealChunk(chunk: ProgrammaticJob, result: CallResult): void {
  if (chunk.completed) return;
  rememberJobResult(chunk, resultNoteText(result), RESULT_NOTE_CHARS);
  chunk.outcomeSnap = result;
  chunk.markComplete();
}

export function cancelLiveInvocations(job: ProgrammaticJob, host: ProgramHost, reason?: unknown): void {
  for (const inner of job.children) {
    if (!(inner instanceof ToolCallJob)) continue;
    if (inner.completed || inner.cancelled) continue;
    if (inner instanceof MCPToolJob && inner.dispatched) continue; // on-wire mutation — do not cancel a dispatched call

    if (inner.orchestrated) {
      host.abort?.(inner, reason);
      inner.cancelled = true;
      continue;
    }
    rejectInner(inner, reason);
  }
}

export function hostAbortReason(host: ProgramHost): unknown {
  return host.signal?.aborted === true ? host.signal.reason : undefined;
}

export function parked(host: ProgramHost): boolean {
  return host.signal != null && isParkAbort(host.signal);
}

export function cancelled(host: ProgramHost): boolean {
  return host.signal != null && host.signal.aborted && !isParkAbort(host.signal);
}

export async function waitPeriod(ms: number, signal?: AbortSignal): Promise<"elapsed" | "park" | "abort"> {
  if (signal == null) {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
    return "elapsed";
  }
  const live = signal;
  if (live.aborted) return isParkAbort(live) ? "park" : "abort";
  return await new Promise((resolve) => {
    const timer = setTimeout(() => finish("elapsed"), ms);
    const onAbort = (): void => finish(isParkAbort(live) ? "park" : "abort");
    function finish(result: "elapsed" | "park" | "abort"): void {
      clearTimeout(timer);
      live.removeEventListener("abort", onAbort);
      resolve(result);
    }
    live.addEventListener("abort", onAbort, { once: true });
  });
}

export function createEvaluationTimeout(
  hostSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const timer =
    timeoutMs == null
      ? undefined
      : setTimeout(() => controller.abort(new Error(`evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
  const signal =
    timeoutMs == null
      ? (hostSignal ?? controller.signal)
      : hostSignal == null
        ? controller.signal
        : AbortSignal.any([hostSignal, controller.signal]);
  return { signal, dispose: () => clearTimeout(timer) };
}

function handleEvaluationStop(
  chunk: ProgrammaticJob,
  host: ProgramHost,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  error: unknown,
): Extract<EvalOutcome, { kind: "park" | "halt" }> | undefined {
  if (parked(host) || isParkAbort(signal)) return { kind: "park" };
  if (cancelled(host)) {
    cancelLiveInvocations(chunk, host, hostAbortReason(host));
    return { kind: "halt", result: fail("Error: Scheme REPL call cancelled") };
  }
  const halt = haltResult(signal, timeoutMs, error);
  if (halt) {
    cancelLiveInvocations(chunk, host, signal.reason);
    return { kind: "halt", result: halt };
  }
  return undefined;
}

/** One run under the host's trace, if it keeps one. */
export function observed<T>(host: ProgramHost, run: (trace: EvalTrace | undefined) => Promise<T>): Promise<T> {
  return host.observe === undefined ? run(undefined) : host.observe(run);
}

export async function evaluateForms(
  chunk: ProgrammaticJob,
  host: ProgramHost,
  forms: readonly SchemeValue[],
  opts: EvaluateOpts,
  runtime: ProgramRuntime,
): Promise<EvalOutcome> {
  const { timeoutMs, maxInternalCalls } = opts;
  const tick = opts.kind === "period" ? opts.tick : undefined;
  const shared = opts.kind === "source-load" || opts.kind === "source-body" ? opts.shared : undefined;
  const loadSource = opts.kind === "source-load";
  const collectPrintedValues = !loadSource;
  const tools = host.tools();
  const capabilities = runtime.capabilities;
  const config = runtime.config;
  const stopOnFormError = tick != null || loadSource;
  // Per tick, not per watch: remint so numeric provenance ids are path-stable across periods.
  const trace = opts.trace ?? (tick == null ? undefined : new EvalTrace());
  let timeout: { readonly signal: AbortSignal; readonly dispose: () => void } | undefined;
  let signal: AbortSignal | undefined = shared?.signal;

  try {
    // Rooting the prelude is not the program. A short eval limit must not fire during that setup.
    let scope = shared?.scope;
    if (scope === undefined) {
      const setupSignal = shared?.signal ?? host.signal;
      const rooted = await execState("", {
        capabilities,
        config,
        ...(setupSignal != null ? { signal: setupSignal } : {}),
      });
      scope = rooted.scope;
      if (shared !== undefined) shared.scope = scope;
    }
    if (shared == null) {
      timeout = createEvaluationTimeout(host.signal, timeoutMs);
      signal = timeout.signal;
    }
    const origin = tick?.origin ?? 0;
    runtime.beginTick({ signal: signal ?? new AbortController().signal, origin, maxInternalCalls });
    const evaluated = forms.map((raw) => ({ raw, form: stripTopLevelDisplay(raw) }));
    let emission = shared?.emission;
    if (emission === undefined) {
      emission = harnessEmission(evaluated.map((item) => item.form));
      if (shared !== undefined) shared.emission = emission;
    } else if (opts.kind === "source-body") {
      extendEmission(
        emission,
        evaluated.map((item) => item.form),
      );
    }
    const epoch = crossingEpoch(chunk, origin);
    armCrossings(emission, origin, epoch, opts.kind !== "source-body");
    if (host.replayOnly === true) markReplaying(emission);
    const started = Date.now();
    const values: PrintedValue[] = [];
    const displaySink = createDisplaySink();
    let lastRaw: SchemeValue | undefined;
    let failures = 0;
    let failureCode: string | undefined;
    for (const item of evaluated) {
      runtime.clearFailure();
      const remainingMs = timeoutMs == null ? undefined : timeoutMs - (Date.now() - started);
      try {
        const state = await execState(item.form, {
          capabilities,
          config,
          scope,
          signal,
          display: displaySink,
          emission,
          ...(remainingMs == null ? {} : { budgetMs: remainingMs }),
          ...(trace == null ? {} : { tap: trace }),
        });
        const wasTopLevelDisplay = tick == null && isTopLevelDisplay(item.raw);
        for (const value of state.values) {
          if (value instanceof AVoid) continue;
          lastRaw = value;
          if (!collectPrintedValues) continue;
          const printed = observationText(value);
          values.push(wasTopLevelDisplay ? withDisplayNote(printed) : printed);
        }
        for (const rec of displaySink.drain()) {
          values.push(`#| ${rec.src}:  ${toSExprString(rec.value)} |#`);
        }
      } catch (error) {
        const stopped = signal == null ? undefined : handleEvaluationStop(chunk, host, signal, timeoutMs, error);
        if (stopped != null) return stopped;
        const raw = errorText(error).replace(/^Error:\s*/, "");
        // A failed form leaves its defines unbound. Later "Unbound variable" is the cascade, not a second fault.
        const attempted = UNBOUND_VARIABLE.exec(raw)?.[1];
        if (attempted != null && failures > 0) continue;
        let text = raw.startsWith("Error:") ? raw : `Error: ${raw}`;
        if (attempted != null) {
          const door =
            unboundInExprDoor(
              attempted,
              [...tools.keys()],
              tools,
              SCHEME_REPL_NAMING,
              new Map([...tools].map(([name, tool]) => [name, tool.schema])),
            ) ?? importDoor(attempted);
          if (door !== undefined) text = `${text}${host.doors.enrichInline(door, attempted)}`;
        }
        values.push(text);
        failures += 1;
        failureCode ??= failureCodeOf(error) ?? runtime.failureCode();
        if (stopOnFormError) break;
      }
    }
    if (failures > 0) return { kind: "fail", values, code: failureCode };
    if (lastRaw === undefined || host.evalProgram !== true) return { kind: "ok", values };
    return { kind: "ok", values, ...structuredJson(lastRaw) };
  } catch (error) {
    const stopped = signal == null ? undefined : handleEvaluationStop(chunk, host, signal, timeoutMs, error);
    if (stopped != null) return stopped;
    return { kind: "fail", values: [errorText(error)] };
  } finally {
    timeout?.dispose();
    try {
      if (opts.trace === undefined) trace?.clear();
    } catch {
      /* mid-eval abort — next tick remints */
    }
  }
}

function withDisplayNote(value: PrintedValue): PrintedValue {
  if (typeof value === "string") return `${SCHEME_REPL_DISPLAY_NOTE}\n${value}`;
  return { ...value, text: `${SCHEME_REPL_DISPLAY_NOTE}\n${value.text}` };
}

export function printedValues(values: readonly PrintedValue[], kinds: readonly TopLevelSplice[]): PrintedValue[] {
  return [...kinds.map((kind) => SCHEME_REPL_UNWRAP_NOTES[kind]), ...values];
}

export async function guardProgram(
  chunk: ProgrammaticJob,
  host: ProgramHost,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    if (!chunk.completed && !parked(host) && !cancelled(host)) {
      cancelLiveInvocations(chunk, host, error);
      sealChunk(chunk, fail(errorText(error)));
    }
  } finally {
    if (!chunk.completed && !parked(host)) {
      cancelLiveInvocations(chunk, host, hostAbortReason(host));
      if (cancelled(host)) chunk.cancelled = true;
      sealChunk(chunk, fail("Error: Scheme REPL call cancelled"));
    }
  }
}
