/**
 * Worker entry is a sibling file URL. worker_threads does not go through TS path mapping.
 */
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { dumpSkipped, fail, installProcessLog, mute, note, openLog, step } from "@inhuman.tools/harness-diagnostics";
import { clampChars, occupiedSessionIds, SESSION_TITLE_MAX_CHARS } from "@inhuman.tools/harness-model";
import { Client } from "@inhuman.tools/harness-sdk";
import {
  clearTermContinue,
  hasCliAgentFlags,
  pickContinueSession,
  resolveCliAgent,
  termSessionKey,
  type CliAgentFlags,
  type ResolvedAgent,
  type ShellStreams,
  type Streams,
} from "@inhuman.tools/harness-sdk/launch";
import { daemonLogPath } from "@inhuman.tools/harness-sdk/paths";

import { tuiReplaceBoot, type HostToWorker, type WorkerToHost } from "./channel.js";
import { startRustPresent, type RustPresent } from "./rust-present.js";
import { SPINNER_PHASE } from "./spinner-phase.js";
import { type WorkerBoot } from "../schemas/index.js";

/** First Ctrl-C hint when `spec.resident` is set. Second press still leaves the TUI. */
export const DAEMON_QUIT_ACTION = "exit the UI and keep session running in background";

export function sessionTitleOsc(text: string): string {
  const payload =
    clampChars(text.replaceAll(/[\u0000-\u001F\u007F-\u009F]/g, "").trim(), SESSION_TITLE_MAX_CHARS) || "harness";
  return `\u001B]0;${payload}\u0007`;
}

export function hostExitCode(args: { failed: string | null; workerCode: number | null; shutdown: boolean }): {
  code: number;
  reason: string;
} {
  if (args.failed !== null) return { code: 1, reason: `failed ${args.failed}` };
  if (args.shutdown) {
    const clean = args.workerCode === 0 || args.workerCode === null;
    return { code: clean ? 0 : 1, reason: "shutdown" };
  }
  if (args.workerCode === 0) return { code: 1, reason: "worker 0 unexpected" };
  if (args.workerCode === null) return { code: 1, reason: "worker signal" };
  return { code: 1, reason: `worker ${args.workerCode}` };
}

export async function attachTui(args: {
  kernel: string;
  session: string | undefined;
  continueLast?: boolean;
  restartDaemon: boolean;
  agent?: CliAgentFlags;
  streams: ShellStreams;
  /** Start or attach the daemon. The launcher owns that; the shell only asks. */
  ensure: (kernel: string, options?: { readonly restart?: boolean }) => Promise<void>;
}): Promise<number> {
  const { kernel, streams } = args;
  const log = openLog(daemonLogPath(kernel));
  installProcessLog("host");
  note(`log ${log}`);
  try {
    step(`ensure ${kernel}`);
    await args.ensure(kernel, { restart: args.restartDaemon });
    step("ensure ready");
  } catch (error) {
    fail("ensure", error);
    streams.writeErr(error);
    return 1;
  }

  let sessionId = args.session;
  let restore = sessionId !== undefined;
  let agent: ResolvedAgent | undefined;
  try {
    const flags = args.agent ?? {};
    const needKernel = args.continueLast === true || hasCliAgentFlags(flags);
    if (needKernel) {
      await using handle = await Client.kernel(kernel);
      if (hasCliAgentFlags(flags)) {
        const resolved = await resolveCliAgent(handle, flags);
        if (!resolved.ok) {
          streams.writeErr(resolved.error);
          return 1;
        }
        agent = resolved.agent;
      }
      if (args.continueLast === true) {
        const picked = await pickContinueSession({
          key: termSessionKey(process.env),
          termContinue: handle.plexus.root.termContinue,
          sessions: handle.plexus.root.sessions,
          occupied: occupiedSessionIds(handle.plexus.awareness),
          sessionExists: (id) => Client.sessionExists(kernel, id),
        });
        if (picked.staleKeyToClear != null) {
          await clearTermContinue((method, params) => handle.request(method, params), picked.staleKeyToClear);
        }
        sessionId = picked.sessionId;
        restore = picked.sessionId !== undefined;
      }
    }
    if (args.continueLast !== true && sessionId !== undefined) {
      if (!(await Client.sessionExists(kernel, sessionId))) {
        streams.writeErr(`session not found: ${sessionId}`);
        return 1;
      }
      restore = true;
    }
  } catch (error) {
    fail("continue lookup", error);
    streams.writeErr(error);
    return 1;
  }

  const boot: WorkerBoot = {
    kernel,
    path: process.cwd(),
    ...(sessionId === undefined || !restore ? {} : { sessionId, restore: true }),
    ...(agent != null && agent.connection !== "" ? { connection: agent.connection } : {}),
    ...(agent?.model != null && agent.model !== "" ? { model: agent.model } : {}),
  };

  mute();
  let worker = spawnTuiWorker(boot, streams);

  const defaultGeometry = { cols: streams.stdout.columns ?? 80, rows: streams.stdout.rows ?? 24 };
  let rust: RustPresent | null = null;
  let attached = false;
  let failed: string | null = null;
  let shutdown = false;
  let resident = false;
  let replacing = false;
  let workerCode: number | null = null;
  let resolveAttached: () => void = () => undefined;
  let rejectAttached: (error: Error) => void = () => undefined;
  let resolveRunning: () => void = () => undefined;
  const attachedWait = new Promise<void>((resolve, reject) => {
    resolveAttached = resolve;
    rejectAttached = reject;
  });
  const runningWait = new Promise<void>((resolve) => {
    resolveRunning = resolve;
  });

  const postShutdown = (mine: Worker): void => {
    mine.postMessage({ lane: "host", kind: "shutdown" } satisfies HostToWorker);
  };

  let phase = "";
  const showPhase = (text: string): void => {
    if (text === phase) return;
    phase = text;
    rust?.writeDown({ kind: "phase", text });
    if (text !== "") note(`spinner ${text}`);
  };

  const applyPaint = (message: Extract<WorkerToHost, { lane: "paint" }>, from: Worker): void => {
    if (from !== worker || replacing) return;
    if (phase !== "") showPhase("");
    for (const item of message.batch) {
      try {
        rust?.writeDown(item);
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
        fail("paint protocol", error);
        if (attached) postShutdown(worker);
        else rejectAttached(error instanceof Error ? error : new Error(failed));
        return;
      }
    }
  };

  const onWorkerFailed = (reason: string, error?: unknown): void => {
    failed = reason;
    fail(`worker failed ${failed}`, error);
    if (attached) {
      resolveRunning();
    } else {
      rejectAttached(error instanceof Error ? error : new Error(failed));
    }
  };

  const replaceWorker = async (message: { path: string; draft?: string; sessionId?: string }): Promise<void> => {
    if (replacing || shutdown) return;
    replacing = true;
    showPhase(SPINNER_PHASE.closingSession);
    const old = worker;
    const exited = waitWorkerExit(old);
    postShutdown(old);
    const result = await exited;
    note(`host replace exit code=${result.code} signal=${result.signal ?? ""}`);
    if (shutdown) {
      workerCode = result.code;
      resolveRunning();
      return;
    }
    showPhase(SPINNER_PHASE.openingSession);
    const geometry = rust?.geometry() ?? defaultGeometry;
    const next = spawnTuiWorker(tuiReplaceBoot(kernel, message, process.cwd(), geometry), streams);
    worker = next;
    replacing = false;
    wireWorker(next);
    next.postMessage({
      lane: "paint",
      message: { kind: "resize", cols: geometry.cols, rows: geometry.rows },
    } satisfies HostToWorker);
  };

  const wireWorker = (mine: Worker): void => {
    mine.on("message", (message: WorkerToHost) => {
      if (mine !== worker) return;
      if (message.lane === "host" && message.kind === "title") {
        rust?.writeDown({ kind: "title", text: message.text });
        return;
      }
      if (message.lane === "host" && message.kind === "phase") {
        showPhase(message.text);
        return;
      }
      if (message.lane === "paint") {
        applyPaint(message, mine);
        return;
      }
      if (message.kind === "quit") {
        requestShutdown("quit");
        return;
      }
      if (message.kind === "resident") {
        resident = message.resident;
        return;
      }
      if (message.kind === "replace") {
        void replaceWorker(message);
        return;
      }
      if (message.kind === "attached") {
        step("worker attached");
        showPhase("");
        attached = true;
        resolveAttached();
        return;
      }
      onWorkerFailed(message.reason ?? "worker failed");
    });
    mine.on("error", (error) => {
      if (mine !== worker) return;
      failed = error instanceof Error ? error.message : String(error);
      fail("host worker error", error);
      if (!attached) rejectAttached(error instanceof Error ? error : new Error(failed));
    });
    mine.once("exit", (code: number, signal: NodeJS.Signals | null) => {
      if (replacing || mine !== worker) return;
      workerCode = code;
      note(`host worker exit code=${code} signal=${signal ?? ""}`);
      if (!attached && failed === null) {
        rejectAttached(new Error(`tui worker exited ${code}`));
      }
      resolveRunning();
    });
  };

  const requestShutdown = (why: string): void => {
    if (shutdown) return;
    shutdown = true;
    note(`host ${why}`);
    postShutdown(worker);
  };

  step("render");
  let session: RustPresent;
  try {
    session = startRustPresent({
      stderr: streams.stderr,
      onUp: (message) => {
        const down: HostToWorker = { lane: "paint", message };
        worker.postMessage(down);
      },
      onQuit: () => requestShutdown(resident ? "quit resident" : "quit"),
      onFailed: (reason) => onWorkerFailed(reason),
    });
  } catch (error) {
    fail("qd", error);
    streams.writeErr(error);
    await worker.terminate();
    return 1;
  }
  rust = session;
  wireWorker(worker);

  installProcessLog("host", () => {
    dumpSkipped(streams.stderr);
    return session.restore();
  });

  process.once("SIGINT", () => requestShutdown("SIGINT"));
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));

  try {
    step("wait attached");
    await attachedWait;
    step("running");
    await runningWait;
    const ended = hostExitCode({ failed, workerCode, shutdown });
    note(`host end ${ended.reason}`);
    return ended.code;
  } catch (error) {
    fail("host run", error);
    streams.writeErr(error);
    return 1;
  } finally {
    await session.restore();
    await worker.terminate();
    dumpSkipped(streams.stderr);
  }
}

function spawnTuiWorker(boot: WorkerBoot, streams: Streams): Worker {
  const self = fileURLToPath(import.meta.url);
  const workerFile = fileURLToPath(
    new URL(self.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js", import.meta.url),
  );
  step(`worker ${workerFile}`);
  const worker = new Worker(workerFile, {
    workerData: boot,
    // STDERR_PIPE: default inherit writes fd 2 into the alt-screen; holdStderr never sees those.
    stderr: true,
  });
  worker.stderr.on("data", (chunk: string | Buffer) => {
    streams.stderr.write(chunk);
  });
  return worker;
}

function waitWorkerExit(worker: Worker): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    worker.once("exit", (code: number, signal: NodeJS.Signals | null) => resolve({ code, signal }));
  });
}
