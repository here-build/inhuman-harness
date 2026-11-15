/**
 * Host half of file-path policy. The floor is pure and lexical; the tool opens whatever the
 * filesystem says. A link inside the root that points at `.env` is named `notes.txt` to the floor
 * and opens `.env` for the tool. This resolves symlinks (the deepest existing ancestor, so a
 * write to a not-yet-created file under a linked directory resolves too) and re-expresses the
 * result against the real root, so both spellings can be judged and the stricter verdict kept.
 */
import { realpath } from "node:fs/promises";
import nodePath from "node:path";

import { workspacePath } from "@inhuman.tools/harness-model";
import type { WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";

export async function realpathDeepest(absolute: string, env?: WorkspaceEnvPort): Promise<string> {
  if (env !== undefined && env.resolveCanonicalPath == null) {
    return absolute;
  }
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = env !== undefined ? await env.resolveCanonicalPath!(current) : await realpath(current);
      if (real != null) {
        return rest.length === 0 ? real : nodePath.join(real, ...rest.toReversed());
      }
    } catch {
      // Walk up to deepest existing ancestor below.
    }
    const parent = nodePath.dirname(current);
    if (parent === current) return absolute;
    rest.push(nodePath.basename(current));
    current = parent;
  }
}

/**
 * Workspace-relative spelling of the file the OS or VFS would open for `raw`, or undefined when it
 * is the same as the lexical spelling (nothing to add).
 */
export async function resolvedWorkspacePath(
  rootPath: string,
  raw: string,
  env?: WorkspaceEnvPort,
): Promise<string | undefined> {
  const effectiveRoot = env?.logicalRoot.trim() ? env.logicalRoot : rootPath;
  if (effectiveRoot.trim() === "" || !nodePath.isAbsolute(effectiveRoot)) return undefined;
  if (env !== undefined && env.resolveCanonicalPath == null) return undefined;
  const lexical = workspacePath(effectiveRoot, raw);
  const absolute = nodePath.resolve(effectiveRoot, raw.trim() === "" ? "." : raw);
  const realRoot = await realpathDeepest(effectiveRoot, env);
  const realFile = await realpathDeepest(absolute, env);
  const resolved = workspacePath(realRoot, realFile);
  return resolved === lexical ? undefined : resolved;
}
