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

export async function realpathDeepest(absolute: string): Promise<string> {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : nodePath.join(real, ...rest.toReversed());
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return absolute;
      rest.push(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Workspace-relative spelling of the file the OS would open for `raw`, or undefined when it
 * is the same as the lexical spelling (nothing to add).
 */
export async function resolvedWorkspacePath(rootPath: string, raw: string): Promise<string | undefined> {
  if (rootPath.trim() === "" || !nodePath.isAbsolute(rootPath)) return undefined;
  const lexical = workspacePath(rootPath, raw);
  const absolute = nodePath.resolve(rootPath, raw.trim() === "" ? "." : raw);
  const realRoot = await realpathDeepest(rootPath);
  const realFile = await realpathDeepest(absolute);
  const resolved = workspacePath(realRoot, realFile);
  return resolved === lexical ? undefined : resolved;
}
