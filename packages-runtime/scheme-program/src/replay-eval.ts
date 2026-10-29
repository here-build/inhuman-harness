/**
 * Re-run a program against the children it already minted. Does not seal the
 * job, does not append notes, and does not move the watch cursor.
 */
import { parse } from "@here.build/arrival";
import type { EvalTrace } from "@here.build/arrival/provenance";
import { crossingEpoch, crossingOriginAfter, ProgrammaticJob } from "@inhuman.tools/harness-model";
import { callArgsSchema } from "@inhuman.tools/harness-model/schemas";
import { unwrapTopLevelBegins } from "@inhuman.tools/substrate/unwrap-begin";
import { when } from "mobx";

import { evaluateForms, observed, type SharedEval } from "./evaluate.js";
import type { ProgramHost } from "./host.js";
import { openProgram, type OpenedProgram } from "./open.js";
import { detachedRuntime, type ProgramRuntime } from "./runtime.js";

async function once(
  job: ProgrammaticJob,
  host: ProgramHost,
  opened: OpenedProgram,
  runtime: ProgramRuntime,
  trace: EvalTrace | undefined,
): Promise<void> {
  const limits = { timeoutMs: undefined, maxInternalCalls: opened.maxInternalCalls, trace };
  const sourceText = opened.source.source;
  if (sourceText == null) {
    await evaluateForms(job, host, opened.forms, { kind: "once", ...limits }, runtime);
    return;
  }
  const sourceForms = unwrapTopLevelBegins(await parse(sourceText));
  const shared: SharedEval = { signal: host.signal ?? new AbortController().signal };
  const loaded = await evaluateForms(job, host, sourceForms, { kind: "source-load", ...limits, shared }, runtime);
  if (loaded.kind !== "ok") return;
  await evaluateForms(job, host, opened.forms, { kind: "source-body", ...limits, shared }, runtime);
}

async function periods(
  job: ProgrammaticJob,
  host: ProgramHost,
  opened: OpenedProgram,
  runtime: ProgramRuntime,
  trace: EvalTrace | undefined,
): Promise<void> {
  const limits = { timeoutMs: undefined, maxInternalCalls: opened.maxInternalCalls, trace };
  let origin = 0;
  while (host.signal?.aborted !== true) {
    if ((job.completed || job.cancelled) && origin >= job.toolCalls.length) return;
    const before = job.toolCalls.length;
    const epoch = crossingEpoch(job, origin);
    await evaluateForms(job, host, opened.forms, { kind: "period", tick: { origin }, ...limits }, runtime);
    const next = crossingOriginAfter(job, origin, epoch);
    if (next > origin) {
      origin = next;
      continue;
    }
    if (job.completed || job.cancelled || before < job.toolCalls.length) return;
    const joined = when(
      () => host.signal?.aborted === true || job.completed || job.cancelled || job.toolCalls.length > before,
    );
    try {
      await joined;
    } finally {
      joined.cancel();
    }
    if (job.toolCalls.length === before) return;
  }
}

export async function replayEvaluation(job: ProgrammaticJob, host: ProgramHost, trace: EvalTrace): Promise<void> {
  const parsed = callArgsSchema.safeParse(job.args);
  if (!parsed.success) return;
  const opened = await openProgram(job, host, parsed.data, false);
  if (opened == null) return;
  const runtime = detachedRuntime(job, host);
  runtime.arm({ watching: opened.periodMs != null, moduleRoot: opened.moduleRoot });
  await observed(host, async (live) => {
    const tap = live ?? trace;
    if (opened.periodMs == null) {
      await once(job, host, opened, runtime, tap);
      return;
    }
    await periods(job, host, opened, runtime, tap);
  });
}
