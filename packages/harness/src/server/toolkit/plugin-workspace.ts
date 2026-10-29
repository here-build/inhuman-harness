/**
 * Resolve canonical workspace id from a session root path.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

import type { SessionRoot } from "@inhuman.tools/harness-model";

export function workspaceIdFromRoot(root: SessionRoot): string {
  const path = root.path.trim() === "" ? process.cwd() : root.path;
  try {
    return createHash("sha256").update(realpathSync(path)).digest("hex").slice(0, 32);
  } catch {
    return createHash("sha256").update(path).digest("hex").slice(0, 32);
  }
}
