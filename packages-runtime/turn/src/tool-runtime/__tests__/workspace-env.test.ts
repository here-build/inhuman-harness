import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionRoot } from "@inhuman.tools/harness-model";
import { bindPolicy, reasonableDefaultsSource, whichOnPath } from "@inhuman.tools/policy/floor";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsSpies = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  realpathSync: vi.fn(),
  statSync: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => {
      fsSpies.existsSync(...args);
      return actual.existsSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fsSpies.readFileSync(...args);
      return actual.readFileSync(...args);
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      fsSpies.realpathSync(...args);
      return actual.realpathSync(...args);
    },
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      fsSpies.statSync(...args);
      return actual.statSync(...args);
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      fsSpies.realpath(...args);
      return actual.realpath(...args);
    },
  };
});

import { resolvedWorkspacePath } from "../../policy-processor/real-path.js";
import { floorVerdict, withRealRoots } from "../../policy-processor/scope.js";
import { withSelfProtection } from "../../policy-processor/self-protect.js";
import {
  bindWorkspaceEnv,
  createVirtualWorkspaceEnv,
  workspaceEnvOf,
  type WorkspaceEnvPort,
} from "../workspace-env.js";
import { writeFileAdmitSnap } from "../write-admit.js";

describe("WorkspaceEnvPort inversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes virtual canonical path & policy floor without touching host node:fs", async () => {
    const root = "/vfs/tenant-a/proj-1";
    const env: WorkspaceEnvPort = {
      logicalRoot: root,
      resolveCanonicalPath: (target) => {
        if (target === root) return root;
        if (target === `${root}/notes.txt`) return `${root}/.env`;
        if (target === `${root}/linked-dir`) return `${root}/secrets`;
        if (target === `${root}/readme.md`) return `${root}/readme.md`;
        return null;
      },
    };

    expect(await resolvedWorkspacePath(root, "notes.txt", env)).toBe(".env");
    expect(await resolvedWorkspacePath(root, "linked-dir/sub/new.txt", env)).toBe("secrets/sub/new.txt");
    expect(await resolvedWorkspacePath(root, "readme.md", env)).toBeUndefined();
    expect(await withRealRoots([root], env)).toEqual([root]);

    const policy = bindPolicy(withSelfProtection(JSON.parse(reasonableDefaultsSource)), whichOnPath);
    const linkVerdict = await floorVerdict(policy, "write_file", { path: "notes.txt" }, root, "", undefined, env);
    expect(["deny", "block", "ask"]).toContain(linkVerdict.disposition);
    expect(linkVerdict.disposition).not.toBe("policyApprove");

    // Verify pure virtual env performs zero host FS calls too
    const pureVirtual = createVirtualWorkspaceEnv("/vfs/tenant-b/pure");
    expect(await resolvedWorkspacePath(pureVirtual.logicalRoot, "a.txt", pureVirtual)).toBeUndefined();
    expect(await withRealRoots([pureVirtual.logicalRoot], pureVirtual)).toEqual([pureVirtual.logicalRoot]);

    expect(fsSpies.realpath).not.toHaveBeenCalled();
    expect(fsSpies.existsSync).not.toHaveBeenCalled();
    expect(fsSpies.realpathSync).not.toHaveBeenCalled();
    expect(fsSpies.statSync).not.toHaveBeenCalled();
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
  });

  it("enforces writeFileAdmitSnap overwrite door, priorContent, and root containment via WorkspaceEnvPort", () => {
    const root = "/vfs/tenant-a/proj-1";
    const env: WorkspaceEnvPort = {
      logicalRoot: root,
      resolveCanonicalPathSync: (target) => target,
      probeWriteTarget: (target) => {
        if (target === `${root}/doc.md`) {
          return { exists: true, isDirectory: false, canonicalPath: `${root}/doc.md`, textContent: "hello v1" };
        }
        if (target === `${root}/escape.txt`) {
          return { exists: true, isDirectory: false, canonicalPath: "/etc/passwd", textContent: "nope" };
        }
        return { exists: false };
      },
    };

    const existingBlocked = writeFileAdmitSnap(root, JSON.stringify({ path: "doc.md" }), env);
    expect(existingBlocked.existed).toBe(true);
    expect(existingBlocked.priorContent).toBe("hello v1");
    expect(existingBlocked.refuse).toMatch(/exists/);

    const existingAllowed = writeFileAdmitSnap(
      root,
      JSON.stringify({ path: "doc.md", overwriteExisting: true }),
      env,
    );
    expect(existingAllowed).toEqual({ existed: true, priorContent: "hello v1", refuse: null });

    const fresh = writeFileAdmitSnap(root, JSON.stringify({ path: "new.md" }), env);
    expect(fresh).toEqual({ existed: false, priorContent: null, refuse: null });

    const escape = writeFileAdmitSnap(root, JSON.stringify({ path: "escape.txt" }), env);
    expect(escape).toEqual({ existed: null, priorContent: null, refuse: null });

    const pureVirtual = createVirtualWorkspaceEnv(root);
    expect(writeFileAdmitSnap(root, JSON.stringify({ path: "doc.md" }), pureVirtual)).toEqual({
      existed: null,
      priorContent: null,
      refuse: null,
    });

    expect(fsSpies.existsSync).not.toHaveBeenCalled();
    expect(fsSpies.realpathSync).not.toHaveBeenCalled();
    expect(fsSpies.statSync).not.toHaveBeenCalled();
    expect(fsSpies.readFileSync).not.toHaveBeenCalled();
  });

  it("binds and clears WorkspaceEnvPort per SessionRoot without cross-talk", () => {
    const s1 = new SessionRoot({ path: realpathSync(mkdtempSync(path.join(tmpdir(), "s1-"))) });
    const s2 = new SessionRoot({ path: "/vfs/s2" });
    const env1 = createVirtualWorkspaceEnv("/vfs/one");
    const env2 = createVirtualWorkspaceEnv("/vfs/two");

    bindWorkspaceEnv(s1, env1);
    bindWorkspaceEnv(s2, env2);
    expect(workspaceEnvOf(s1)).toBe(env1);
    expect(workspaceEnvOf(s2)).toBe(env2);

    bindWorkspaceEnv(s1, undefined);
    expect(workspaceEnvOf(s1)).toBeUndefined();
    expect(workspaceEnvOf(s2)).toBe(env2);
  });
});
