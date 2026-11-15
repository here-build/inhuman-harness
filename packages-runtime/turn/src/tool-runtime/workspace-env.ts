/**
 * Per-session workspace environment port inversion.
 *
 * Local projects bind `createLocalFsWorkspaceEnv(cwd)` so path resolution and
 * overwrite admission check the local filesystem. Server / virtual projects
 * bind `createVirtualWorkspaceEnv(logicalRoot)` (zero host `node:fs` calls) or a
 * VFS/sandbox plugin's `WorkspaceEnvPort`.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";

import type { WorkspaceEnvPort, WriteAdmitProbe } from "@inhuman.tools/plugin-sdk";

import { priorTextSync } from "./write-admit.js";

export type { WorkspaceEnvPort, WriteAdmitProbe } from "@inhuman.tools/plugin-sdk";

const workspaceEnvs = new WeakMap<object, WorkspaceEnvPort>();

/** Bind (or clear with `undefined`) the WorkspaceEnvPort for a SessionRoot. */
export function bindWorkspaceEnv(root: object, env: WorkspaceEnvPort | undefined): void {
  if (env === undefined) {
    workspaceEnvs.delete(root);
    return;
  }
  workspaceEnvs.set(root, env);
}

/** Retrieve the bound WorkspaceEnvPort for a SessionRoot, if any. */
export function workspaceEnvOf(root: object | null | undefined): WorkspaceEnvPort | undefined {
  return root == null ? undefined : workspaceEnvs.get(root);
}

/** Local filesystem WorkspaceEnvPort backed by `node:fs`. */
export function createLocalFsWorkspaceEnv(rootPath: string): WorkspaceEnvPort {
  return {
    logicalRoot: rootPath,
    async resolveCanonicalPath(target: string): Promise<string | null> {
      try {
        return await realpath(target);
      } catch {
        return null;
      }
    },
    resolveCanonicalPathSync(target: string): string | null {
      try {
        return realpathSync(target);
      } catch {
        return null;
      }
    },
    probeWriteTarget(target: string): WriteAdmitProbe {
      if (!existsSync(target)) {
        return { exists: false };
      }
      const info = statSync(target);
      const canonicalPath = realpathSync(target);
      if (!info.isFile()) {
        return {
          exists: true,
          isDirectory: info.isDirectory(),
          canonicalPath,
          textContent: null,
        };
      }
      return {
        exists: true,
        isDirectory: false,
        canonicalPath,
        textContent: priorTextSync(target),
      };
    },
  };
}

/** Pure logical WorkspaceEnvPort with zero host `node:fs` access. */
export function createVirtualWorkspaceEnv(logicalRoot: string): WorkspaceEnvPort {
  return { logicalRoot };
}
