import { execFileSync } from "node:child_process";

/** Workspace snapshot for genesis / refresh. Host-local — not a client replica. */
export function captureEnv(cwd: string): Record<string, string> {
  const env: Record<string, string> = {
    cwd,
    date: new Date().toISOString().slice(0, 10),
    platform: process.platform,
  };
  const branch = gitBranch(cwd);
  if (branch !== "") env.branch = branch;
  return env;
}

function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
