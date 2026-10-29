/**
 * Canonical workspace identity from realpath (§7).
 */
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function canonicalWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  const base = trimmed === "" ? process.cwd() : trimmed;
  return realpathSync(base);
}

export function workspaceId(workspacePath: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(workspacePath)).digest("hex");
}

export function memoryDbPath(workspacePath: string): string {
  const id = workspaceId(workspacePath);
  const dir = join(homedir(), ".harness", "memory", id.slice(0, 2), id);
  mkdirSync(dir, { recursive: true });
  return join(dir, "memory.db");
}

export function assertWorkspaceDirectory(workspacePath: string): void {
  const path = canonicalWorkspacePath(workspacePath);
  if (!statSync(path).isDirectory()) {
    throw new Error(`MEMORY_WORKSPACE is not a directory: ${path}`);
  }
}
