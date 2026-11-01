/**
 * Shared origin-aware guard/approval path. Plugin guards may refuse,
 * answer without running, or narrow arguments; narrowed values are written
 * back before license judges them. Denied/ask never start the effect.
 */
import {
  AgentCallJob,
  CallJob,
  FailureOutcome,
  stringifyOutcomeValue,
  SuccessfulOutcome,
  SystemToolJob,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { observable, runInAction } from "mobx";

import { type AgentBehavior, type Opened, Refusal, type ToolOutcome } from "@/extensions";
import { bounded, DEFAULT_PLUGIN_HOOK_TIMEOUT_MS } from "@/extensions/hook-deadline";

import { unenteredOutcome, type GuardedCall } from "./tool-behavior.js";

/**
 * Behavior-declared tools are licensed by their behavior, not by policy. That holds only while the
 * behavior's entry is the one that runs: execution resolves the catalog first, so a pack or host
 * tool that took the same wire name afterwards would otherwise inherit the skip.
 */
export function behaviorEntriesThatRun<T extends { readonly wireName: string }>(
  entries: readonly T[],
  catalogEntry: (wireName: string) => unknown,
): readonly T[] {
  return entries.filter((entry) => {
    const resolved = catalogEntry(entry.wireName);
    return resolved === undefined || resolved === entry;
  });
}

/** The license already stamped its own receipt; a guard only sees that it refused. */
const LICENSE_REFUSED = "the host did not license this call";

type GuardHostTool = {
  readonly job: ToolCallJob;
  /** Scheme/RPC callers should pass their origin through this door, not a second path. */
  readonly origin: "model" | "scheme" | "extension" | "rpc";
  readonly agent: AgentBehavior | null | undefined;
  readonly behaviorEntries: readonly { readonly wireName: string }[];
  readonly guardedCall: (job: ToolCallJob) => GuardedCall | null;
  readonly license: (job: ToolCallJob) => Promise<boolean>;
  readonly turnId: string;
  readonly hookTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly stopped?: () => boolean;
  readonly narrowAgent?: (job: AgentCallJob, tools: readonly string[]) => void;
  readonly onUnentered: (
    job: ToolCallJob,
    outcome: {
      readonly ok: boolean;
      readonly text?: string;
      readonly value?: unknown;
    },
  ) => void;
  readonly onProblem?: (what: string, error: unknown) => void;
  readonly onReport?: (job: ToolCallJob, outcome: ToolOutcome) => void;
};

type GuardDecision = {
  readonly allowed: boolean;
  readonly opened?: Opened<ToolOutcome>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The receipt of a call a guard kept from running; an agent call reports it as its outcome. */
export function stampUnentered(
  job: ToolCallJob,
  outcome: {
    readonly ok: boolean;
    readonly text?: string;
    readonly value?: unknown;
  },
): void {
  if (!(job instanceof CallJob)) {
    job.outcomeSnap ??= outcome;
    return;
  }
  if (job.outcome != null) return;
  job.outcome = outcome.ok
    ? new SuccessfulOutcome({
        valueJson: stringifyOutcomeValue(outcome.value ?? outcome.text ?? null),
      })
    : new FailureOutcome({ code: "denied", message: outcome.text ?? "" });
}

/**
 * Guard phase of a host tool. Origins keep their policy rules; RPC skips
 * plugin guards (floor only). Declared extension tools have no host effect
 * to license.
 */
export async function guardHostTool(opts: GuardHostTool): Promise<GuardDecision> {
  const { job } = opts;
  if (job instanceof SystemToolJob && opts.behaviorEntries.some((row) => row.wireName === job.name)) {
    return { allowed: true };
  }
  const agent = opts.agent;
  const skipPlugin = opts.origin === "rpc" || agent == null || agent.empty;
  const call = skipPlugin ? null : opts.guardedCall(job);
  if (skipPlugin || call == null || !agent!.selects(call.point, call.paths)) {
    return { allowed: await opts.license(job) };
  }
  const licensing = observable.box(false);
  let abandoned = false;
  const noLongerActive = () =>
    opts.signal?.aborted === true || opts.stopped?.() === true || job.cancelled || job.completed;
  const active = () => !abandoned && !noLongerActive();
  const opened = agent!.openTool({
    point: call.point,
    paths: call.paths,
    raw: call.raw,
    turnId: opts.turnId,
    floor: async (value) => {
      if (!active()) return new Refusal("call no longer active");
      const next = call.argsFor(value);
      if ("error" in next) return new Refusal(next.error);
      if (next.args !== job.args || next.tools != null || next.speech !== undefined) {
        if (job.policyResult != null || job.humanApprove != null) {
          return new Refusal("a plugin guard changed the arguments after they were judged");
        }
        runInAction(() => {
          if (next.speech !== undefined && job instanceof AgentCallJob) job.replaceSpeech(next.speech);
          if (next.args !== job.args) job.args = next.args;
          if (next.tools != null && job instanceof AgentCallJob) opts.narrowAgent?.(job, next.tools);
        });
      }
      runInAction(() => licensing.set(true));
      try {
        const licensed = await opts.license(job);
        return licensed && active() ? value : new Refusal(LICENSE_REFUSED);
      } finally {
        runInAction(() => licensing.set(false));
      }
    },
  });
  try {
    const result = await bounded(opened.started, {
      ms: opts.hookTimeoutMs ?? DEFAULT_PLUGIN_HOOK_TIMEOUT_MS,
      paused: () => licensing.get(),
      signal: opts.signal,
      stopped: noLongerActive,
    });
    if (result.kind !== "done") {
      abandoned = true;
      opened.abandon();
      throw new Error(result.kind === "timeout" ? "plugin guard deadline exceeded" : "call stopped");
    }
    if (!active()) {
      abandoned = true;
      opened.abandon();
      return { allowed: false };
    }
    const started = result.value;
    if (started.entered) return { allowed: true, opened };
    opts.onReport?.(job, started.outcome);
    runInAction(() => opts.onUnentered(job, unenteredOutcome(started.outcome)));
  } catch (error) {
    abandoned = true;
    opened.abandon();
    if (noLongerActive()) return { allowed: false };
    opts.onProblem?.(`plugin ${job.name} guard`, error);
    runInAction(() =>
      opts.onUnentered(job, {
        ok: false,
        text: `plugin guard failed: ${messageOf(error)}`,
      }),
    );
  }
  return { allowed: false };
}
