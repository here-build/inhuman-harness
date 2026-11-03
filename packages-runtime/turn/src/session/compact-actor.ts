/**
 * Compact cases of the turn loop. Calculations come from context; the
 * Scheme compact is `applyCompact`.
 */
import type { PromptComplete } from "@inhuman.tools/env-capability-module-prompt";
import {
  CompactJob,
  liveBackgroundJobs,
  liveJobsCheckIn,
  SessionRoot,
  SessionTurn,
} from "@inhuman.tools/harness-model/session";
import { runInAction } from "mobx";

import { applyCompact } from "./compact-env.js";
import { loadCompactProgram, type CompactProgram } from "./compact.js";
import {
  compactRejectReason,
  historyBehind,
  keepFloorsOfJob,
  sliceCompactZones,
  stampCompactInputs,
  textOfCell,
  Transcript,
} from "../context/index.js";
import { parseCompactSnapshot, restoreCompactProgram, snapshotCompactProgram } from "../resources/compact-snapshot.js";
import { pinModuleLoader } from "../resources/module-bundle.js";

/** Human tape only. Not injected into the next model prompt. */
const COMPACT_FAILED_NOTICE = "couldn't compact — try again later";

type CompactRunHost = {
  readonly turn: SessionTurn;
  readonly session: SessionRoot;
  readonly compactKeepTurns: number;
  readonly connectionId: string;
  readonly model: string;
  complete?: PromptComplete;
  log?: (message: string) => void;
  fail?: (label: string, error: unknown) => void;
};

export type CompactHost = CompactRunHost &
  (
    | {
        readonly program: CompactProgram | Promise<CompactProgram>;
        checkpoint(job: CompactJob): Promise<void>;
      }
    | {
        readonly compactStrategy: string;
        readonly kernelFsRoot: string;
        loadProgram?: (spec: string | undefined, kernelFsRoot: string) => CompactProgram | Promise<CompactProgram>;
        checkpoint?: (job: CompactJob) => Promise<void>;
      }
  );

function compactRead(
  configFloor: number,
  kv: Readonly<Record<string, string>>,
): {
  readonly configFloor: number;
  readonly kv: Readonly<Record<string, string>>;
} {
  return { configFloor: Math.max(configFloor, 1), kv };
}

function failCompact(job: CompactJob): void {
  runInAction(() => {
    job.failed = true;
    job.notice = COMPACT_FAILED_NOTICE;
    job.standIn = "";
    job.markComplete();
  });
}

async function loadStrategy(host: CompactHost): Promise<CompactProgram> {
  if ("program" in host) return host.program;
  return (host.loadProgram ?? loadCompactProgram)(host.compactStrategy, host.kernelFsRoot);
}

async function prepareStrategy(job: CompactJob, host: CompactHost, signal?: AbortSignal): Promise<CompactProgram> {
  signal?.throwIfAborted();
  if (job.resourceSnapshotJson != null && job.resourceSnapshotJson !== "") {
    const program = restoreCompactProgram(parseCompactSnapshot(job.resourceSnapshotJson));
    await host.checkpoint?.(job);
    signal?.throwIfAborted();
    return program;
  }
  const program = await loadStrategy(host);
  const snapshot = snapshotCompactProgram(program);
  const persist = async (): Promise<void> => {
    signal?.throwIfAborted();
    runInAction(() => {
      job.resourceSnapshotJson = JSON.stringify(snapshot);
    });
    await host.checkpoint?.(job);
    signal?.throwIfAborted();
  };
  await persist();
  return program.moduleLoader === undefined
    ? program
    : {
        ...program,
        moduleLoader: pinModuleLoader(program.moduleLoader, async (path, content) => {
          snapshot.modules[path] = content;
          await persist();
        }),
      };
}

/** Abort leaves the job open: an incomplete compact is not a cutoff, and its owner settles it. */
export async function runCompactJob(job: CompactJob, host: CompactHost, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const rejected = compactRejectReason(host.turn);
  if (rejected != null) {
    host.log?.(`compact ${rejected}`);
    if (signal?.aborted) return;
    job.markComplete();
    return;
  }
  try {
    const session = host.session;
    const read = compactRead(host.compactKeepTurns, session.kvs);
    const eat = Transcript.fromCells(historyBehind(host.turn, read));
    const need = host.turn.contextNeed;
    // The job's cut comes from the settings recorded on it (F8). An unstamped
    // job is stamped here, on its first run, and keeps that reading for good.
    if (job.keepTurns == null) stampCompactInputs(job, read.configFloor, session.kvs);
    const floors = keepFloorsOfJob(job, need, { kv: session.kvs, configFloor: read.configFloor });
    const zones = sliceCompactZones(eat, floors);
    if (zones.prefix.cells.length === 0) {
      host.log?.("compact keep-all");
      signal?.throwIfAborted();
      job.markComplete();
      return;
    }
    const focus = job.reason === "user" ? host.turn.prompt.trim() || need?.focus || "" : (need?.focus ?? "");
    const strategy = await prepareStrategy(job, host, signal);
    signal?.throwIfAborted();
    if (strategy.failsafe != null) {
      // Keep-first is a failsafe, not a strategy: it keeps one cell and drops the
      // rest. Say so, or a broken install looks like a working compaction.
      host.fail?.("compact failsafe", `no compaction program loaded (${strategy.failsafe}); using keep-first`);
      host.log?.(`compact failsafe: ${strategy.failsafe}`);
    }
    const result = await applyCompact(strategy.source, zones.prefix, eat, {
      reason: job.reason,
      focus,
      kv: session.kvs,
      forced: job.reason === "user",
      sourcePath: strategy.sourcePath,
      moduleLoader: strategy.moduleLoader,
      job: host.turn,
      complete: host.complete,
      connectionId: host.connectionId === "" ? undefined : host.connectionId,
      completionModel: host.model === "" ? undefined : host.model,
      signal,
    });
    signal?.throwIfAborted();
    if (!result.ok) {
      host.fail?.("compact strategy", result.reason);
      signal?.throwIfAborted();
      failCompact(job);
      return;
    }
    const background = await liveBackgroundJobs(session.motionWork());
    signal?.throwIfAborted();
    const jobs = liveJobsCheckIn(background);
    const body = result.checkIn
      .map((cell) => textOfCell(cell).trim())
      .filter((line) => line !== "")
      .join("\n\n");
    const checkIn = [jobs, body].filter((line) => line !== "").join("\n\n");
    if (checkIn === "") {
      host.fail?.("compact strategy", "empty-check-in");
      signal?.throwIfAborted();
      failCompact(job);
      return;
    }
    runInAction(() => {
      job.standIn = checkIn;
      job.failed = false;
      job.notice = "";
      job.markComplete();
    });
  } catch (error) {
    if (signal?.aborted) return;
    host.fail?.("compact strategy", error);
    if (signal?.aborted) return;
    failCompact(job);
  }
}
