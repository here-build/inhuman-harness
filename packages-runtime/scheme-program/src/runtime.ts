import { EnvCapability } from "@here.build/arrival";
import type { ProgrammaticJob } from "@inhuman.tools/harness-model";
import { DISPLAY_INTERNAL, displaySymbol } from "@inhuman.tools/substrate";
import invariant from "tiny-invariant";

import type { PreparedProgram, ProgramHost, ProgramRuntime } from "./host.js";

type ReplRig = {
  signal: AbortSignal;
  origin: number;
  replayAt: number;
  /** toolCalls length at the start of the current top-level statement. */
  formAt: number;
  maxInternalCalls: number | undefined;
  failureCode: string | undefined;
};

/** `(display …)` is a host verb. Arrival has no IO; the runner rewrites the call onto this symbol. */
const displayCapability = EnvCapability.define("harness/scheme-repl-display", {
  symbols: () => ({
    [DISPLAY_INTERNAL]: displaySymbol(),
  }),
});

const runtimes = new WeakMap<
  ProgrammaticJob,
  { readonly identity: object; readonly signal?: AbortSignal; readonly runtime: ProgramRuntime }
>();

function runtimeFor(job: ProgrammaticJob, host: ProgramHost): ProgramRuntime {
  const rig: ReplRig = {
    signal: new AbortController().signal,
    origin: 0,
    replayAt: 0,
    formAt: 0,
    maxInternalCalls: undefined,
    failureCode: undefined,
  };
  let armed: PreparedProgram | undefined;
  const view = (): PreparedProgram => {
    if (armed === undefined) throw new Error("scheme-repl: arm the runtime before evaluating");
    return armed;
  };
  const runtime: ProgramRuntime = {
    arm(opts) {
      if (armed !== undefined) return;
      const prepared = host.prepare({ moduleRoot: opts.moduleRoot, job });
      armed = {
        capabilities: [...prepared.capabilities, displayCapability],
        config: { ...prepared.config, job, rig },
      };
    },
    beginTick(tick) {
      rig.signal = tick.signal;
      rig.origin = tick.origin;
      rig.replayAt = tick.origin;
      rig.maxInternalCalls = tick.maxInternalCalls;
      rig.failureCode = undefined;
    },
    clearFailure() {
      rig.formAt = job.toolCalls.length;
      rig.failureCode = undefined;
    },
    failureCode() {
      return rig.failureCode;
    },
    get capabilities() {
      return view().capabilities;
    },
    get config() {
      return view().config;
    },
  };
  return runtime;
}

/** One runtime per job. A new host is legal only after the previous signal parked. The first prepare wins. */
export function programRuntimeOf(job: ProgrammaticJob, host: ProgramHost): ProgramRuntime {
  const existing = runtimes.get(job);
  if (existing !== undefined) {
    if (existing.identity === host.identity) return existing.runtime;
    const stale = existing.signal;
    invariant(
      stale != null && stale.aborted && stale.reason === "park",
      "scheme-repl: ProgrammaticJob rebound to a different host",
    );
    runtimes.delete(job);
  }
  const runtime = runtimeFor(job, host);
  runtimes.set(job, { identity: host.identity, signal: host.signal, runtime });
  return runtime;
}

/** A second host reading the same job (the browser's replay) must not take the daemon's runtime. */
export function detachedRuntime(job: ProgrammaticJob, host: ProgramHost): ProgramRuntime {
  return runtimeFor(job, host);
}

export { type ProgramRuntime } from "./host.js";
