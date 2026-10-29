import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isMainThread } from "node:worker_threads";

import { debugEnabled, debugOn } from "./debug-gate.js";

/** Worker and the detached daemon inherit this path; they do not open their own file. */
const LOG_ENV = "HARNESS_LOG";

let logTag = "harness";
let mutedAt: number | undefined;
let processLogInstalled = false;
let crashHook: ((error: unknown) => void | Promise<void>) | undefined;
let crashing = false;

function logPath(): string | undefined {
  const path = process.env[LOG_ENV];
  if (path === undefined || path === "") return undefined;
  return path;
}

function formatError(error: unknown): string {
  if (error === undefined || error === null) return "";
  if (error instanceof Error) {
    const text = error.stack ?? error.message;
    return ` ${text.replaceAll(/\s+/g, " ").trim()}`;
  }
  return ` ${String(error)}`;
}

function formatLine(prefix: string, body: string): string {
  return `${new Date().toISOString()} ${prefix} pid=${process.pid} ${body}\n`;
}

/** Y.Doc identity for shadow vs lens/main vs client replica. */
export function docTag(doc: { guid?: string; clientID?: number } | null | undefined): string {
  if (doc == null) return "none";
  return `guid=${doc.guid ?? "?"} client=${doc.clientID ?? "?"}`;
}

/** File whenever a path exists. stderr: enabled chatter, or always-lines when unmuted. */
function writeLine(prefix: string, body: string, toStderr: boolean): void {
  const line = formatLine(prefix, body);
  const path = logPath();
  if (path !== undefined) {
    try {
      appendFileSync(path, line);
    } catch {
      /* best-effort */
    }
  }
  if (toStderr && isMainThread && mutedAt === undefined) process.stderr.write(line);
}

/** Open `path` when `HARNESS_LOG` is unset. Callers inject the layout. */
export function openLog(path: string): string {
  const existing = logPath();
  if (existing !== undefined) return existing;
  mkdirSync(dirname(path), { recursive: true });
  process.env[LOG_ENV] = path;
  return path;
}

export function mute(): void {
  const path = logPath();
  if (path === undefined) {
    mutedAt = 0;
    return;
  }
  try {
    mutedAt = statSync(path).size;
  } catch {
    mutedAt = 0;
  }
}

/**
 * Un-namespaced chatter. Same gate as `DEBUG` set to anything — `DEBUG=*` and
 * `DEBUG=harness:judge` both print these. Prefer {@link trace} for new lines.
 */
export function step(message: string): void {
  writeLine(logTag, message, debugOn());
}

/**
 * Namespace line. `DEBUG=*` or a matching prefix. File when `HARNESS_LOG` is
 * set; stderr on the main thread unless {@link mute} is holding the glass.
 * Returns before formatting when the namespace is off.
 */
export function trace(name: string, message: string): void {
  if (!debugEnabled(name)) return;
  writeLine(name, message, true);
}

/** Lifecycle that must survive mute: exit reason, shutdown, worker code. */
export function note(message: string): void {
  writeLine(logTag, message, true);
}

/** Exit reasons and crashes — file even without DEBUG; dumped after TTY restore. */
export function fail(message: string, error?: unknown): void {
  writeLine(logTag, `FAIL ${message}${formatError(error)}`, true);
}

export function dumpSkipped(out: NodeJS.WritableStream = process.stderr): void {
  const from = mutedAt;
  mutedAt = undefined;
  if (from === undefined) return;
  const path = logPath();
  if (path === undefined) return;
  let rest: string;
  try {
    rest = readFileSync(path, "utf8").slice(from);
  } catch {
    return;
  }
  if (rest === "") return;
  out.write(rest.endsWith("\n") ? rest : `${rest}\n`);
}

/**
 * Record why this isolate died. Uncaught handlers must restore the TTY first
 * (`onCrash`) — Node will not run `run()`'s finally if we `process.exit` here.
 * A hook that returns a promise is the wait: exit runs when it settles, so a
 * child can finish its own destructor before this process dies.
 */
export function installProcessLog(tag: string, onCrash?: (error: unknown) => void | Promise<void>): void {
  logTag = tag;
  if (onCrash !== undefined) crashHook = onCrash;
  if (processLogInstalled) return;
  processLogInstalled = true;
  const crash = (kind: string, error: unknown): void => {
    if (crashing) return;
    crashing = true;
    fail(`${tag} ${kind}`, error);
    let result: void | Promise<void>;
    try {
      result = crashHook?.(error);
    } catch {
      process.exit(1);
      return;
    }
    if (result instanceof Promise) {
      void result.then(
        () => process.exit(1),
        () => process.exit(1),
      );
      return;
    }
    process.exit(1);
  };
  process.on("uncaughtException", (error) => {
    crash("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    crash("unhandledRejection", reason);
  });
  process.on("beforeExit", (code) => {
    note(`${tag} beforeExit ${code}`);
  });
  process.on("exit", (code) => {
    note(`${tag} process exit ${code}`);
  });
}
