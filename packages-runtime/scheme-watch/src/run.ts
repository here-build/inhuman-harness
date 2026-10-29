/**
 * scheme_watch. Same evaluation as a one-shot program, plus the period clock.
 * This tool roots meta-reactivity; the host still passes the vocabulary.
 */
import { metaReactivityCapability } from "@inhuman.tools/env-capability-meta-reactivity";
import { PERIOD_BREAKER_ERR, type ProgrammaticJob } from "@inhuman.tools/harness-model";
import { watchArgsSchema } from "@inhuman.tools/harness-model/schemas";
import {
  appendNotify,
  cancelLiveInvocations,
  cancelled,
  displayPrinted,
  evaluateForms,
  fail,
  guardProgram,
  hostAbortReason,
  moduleRootOf,
  observationText,
  observed,
  openProgram,
  parked,
  printedValues,
  programRuntimeOf,
  sealChunk,
  waitPeriod,
  type ProgramHost,
} from "@inhuman.tools/scheme-program/eval";

import { reachableDoneCondition } from "./period.js";

export function watchHost(host: ProgramHost): ProgramHost {
  return {
    identity: host.identity,
    signal: host.signal,
    doors: host.doors,
    root: host.root,
    abort: host.abort,
    notify: host.notify,
    evalProgram: host.evalProgram,
    moduleRoot: host.moduleRoot,
    observe: host.observe,
    replayOnly: host.replayOnly,
    tools: host.tools,
    prepare(opts) {
      const prepared = host.prepare(opts);
      return {
        capabilities: [...prepared.capabilities, metaReactivityCapability],
        config: prepared.config,
      };
    },
  };
}

export async function runWatch(chunk: ProgrammaticJob, host: ProgramHost): Promise<void> {
  const watching = watchHost(host);
  await guardProgram(chunk, watching, async () => {
    const parsed = watchArgsSchema.safeParse(chunk.args);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid arguments";
      sealChunk(chunk, fail(`Error: ${issue}`));
      return;
    }
    const opened = await openProgram(chunk, watching, parsed.data);
    if (opened == null) return;
    if (opened.periodMs === undefined || !reachableDoneCondition(opened.forms)) {
      sealChunk(chunk, fail(`Error: ${PERIOD_BREAKER_ERR}`));
      return;
    }
    const periodMs = opened.periodMs;
    const root = moduleRootOf(undefined, watching.moduleRoot, watching.root);
    const runtime = programRuntimeOf(chunk, watching);
    runtime.arm({ watching: true, moduleRoot: root });
    while (!chunk.completed) {
      if (parked(watching)) return;
      if (cancelled(watching)) {
        cancelLiveInvocations(chunk, watching, hostAbortReason(watching));
        return;
      }

      if (watching.replayOnly !== true && chunk.periodWaitUntilMs != null) {
        const left = chunk.periodWaitUntilMs - Date.now();
        if (left > 0) {
          const waited = await waitPeriod(left, watching.signal);
          if (waited === "park") return;
          if (waited === "abort") {
            cancelLiveInvocations(chunk, watching, hostAbortReason(watching));
            return;
          }
        }
        chunk.periodWaitUntilMs = null;
      }

      const inners = chunk.toolCalls;
      if (inners.length <= chunk.periodChildAt) chunk.periodChildAt = inners.length;

      metaReactivityCapability.begin(chunk);
      const outcome = await observed(watching, (trace) =>
        evaluateForms(
          chunk,
          watching,
          opened.forms,
          {
            kind: "period",
            timeoutMs: opened.timeoutMs,
            maxInternalCalls: opened.maxInternalCalls,
            tick: { origin: chunk.periodChildAt },
            trace,
          },
          runtime,
        ),
      );
      if (outcome.kind === "park") return;
      if (outcome.kind === "halt") {
        if (cancelled(watching)) return;
        metaReactivityCapability.abandon(chunk);
        appendNotify(chunk, watching, `period tick failed: ${outcome.result.text}`);
        if (watching.replayOnly !== true) {
          chunk.periodChildAt = chunk.toolCalls.length;
          chunk.periodWaitUntilMs = Date.now() + periodMs;
        }
        continue;
      }
      if (outcome.kind === "fail") {
        metaReactivityCapability.abandon(chunk);
        if (watching.replayOnly !== true) {
          appendNotify(chunk, watching, `period tick failed: ${outcome.values.map(displayPrinted).join("\n\n")}`);
          chunk.periodChildAt = chunk.toolCalls.length;
          chunk.periodWaitUntilMs = Date.now() + periodMs;
        }
        continue;
      }

      const sealed = metaReactivityCapability.commit(chunk);
      if (watching.replayOnly !== true) chunk.periodChildAt = chunk.toolCalls.length;
      if (sealed.done) {
        if (watching.replayOnly === true) return;
        sealChunk(chunk, {
          ok: true,
          value: printedValues(
            sealed.result !== undefined ? [observationText(sealed.result)] : outcome.values,
            opened.kinds,
          ),
        });
        return;
      }
      if (watching.replayOnly !== true) chunk.periodWaitUntilMs = Date.now() + periodMs;
    }
  });
}
