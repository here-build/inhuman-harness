import { join } from "node:path";

export const HARNESS_DIR = ".harness";

export function daemonSocketPath(systemRoot: string): string {
  return join(systemRoot, "daemon.sock");
}

/** One append-only log for host, worker, and daemon. */
export function daemonLogPath(systemRoot: string): string {
  return join(systemRoot, "harness.log");
}

export function projectHarnessDir(workspacePath: string): string {
  return join(workspacePath, HARNESS_DIR);
}

export function projectSessionsDir(workspacePath: string): string {
  return join(projectHarnessDir(workspacePath), "sessions");
}
