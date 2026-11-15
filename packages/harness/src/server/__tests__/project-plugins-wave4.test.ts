import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prompt } from "@inhuman.tools/harness-commons";
import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { defineTool, InhumanPlugin, type WorkspaceEnvPort } from "@inhuman.tools/plugin-sdk";
import { SqliteKvStore } from "@inhuman.tools/scope-plane-sqlite";
import { explainCall } from "@inhuman.tools/turn/explain";
import { runInAction } from "mobx";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { LicenseScope } from "@/policy-processor/scope";
import { bindWorkspaceEnv, executeSystemTool, workspaceEnvOf, writeFileAdmitSnap } from "@/tool-runtime";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { MultiKernelRegistry } from "../multi-kernel-registry.js";
import { MemorySecretsVault } from "../secrets.js";
import { LOCAL_ENV_PLUGIN_NAME, SHELL_PLUGIN_NAME, TOOLKIT_PLUGIN_NAME } from "../system-plugins/index.js";
import { DEFAULT_PRODUCT_TOOLS_ADDENDUM } from "../toolkit/tool-table.js";

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("Wave 4: project pluginConfigs overlay, toggleable FS/shell, and WorkspaceEnvPort", () => {
  it("validates project/configure schemas, persists virtual projects, stamps projectId, and disposes/rehydrates on evict", async () => {
    const dir = tempDir("w4-cfg-");
    const db = new SqliteKvStore(join(dir, "harness.db"));
    onTestFinished(() => db.close());

    const lifecycleEvents: string[] = [];
    let activateCount = 0;
    let disposeCount = 0;

    const vfsConfigSchema = z.object({
      rootLabel: z.string().min(1),
      initialFiles: z.record(z.string(), z.string()).default({}),
    });

    const vfsPlugin = new InhumanPlugin({
      projectConfigSchema: vfsConfigSchema,
      activateProject(ctx, rawConfig) {
        const cfg = vfsConfigSchema.parse(rawConfig);
        activateCount += 1;
        const idx = activateCount;
        lifecycleEvents.push(`activate#${idx}:${ctx.projectId}:${cfg.rootLabel}`);
        const env: WorkspaceEnvPort = {
          logicalRoot: ctx.workspacePath,
          resolveCanonicalPathSync: (target) => target,
          probeWriteTarget: (target) => {
            const rel = target.startsWith(`${ctx.workspacePath}/`)
              ? target.slice(ctx.workspacePath.length + 1)
              : target;
            const hit = cfg.initialFiles[rel];
            return hit !== undefined
              ? { exists: true, isDirectory: false, canonicalPath: target, textContent: hit }
              : { exists: false };
          },
        };
        const infoTool = defineTool({
          name: "vfs_info",
          description: "Inspect virtual workspace config.",
          class: "read",
          representation: "tool",
          input: z.object({}),
          output: z.object({ label: z.string(), projectId: z.string(), root: z.string() }),
          run: (_args, callCtx) => ({
            label: cfg.rootLabel,
            projectId: ctx.projectId,
            root: callCtx.workspaceEnv?.logicalRoot ?? "",
          }),
        });
        return {
          workspaceEnv: env,
          tools: [infoTool],
          [Symbol.dispose]() {
            disposeCount += 1;
          },
          async [Symbol.asyncDispose]() {
            disposeCount += 1;
            lifecycleEvents.push(`dispose#${idx}:${ctx.projectId}:${cfg.rootLabel}`);
          },
        };
      },
    });

    const registry = new MultiKernelRegistry({
      db,
      idleEvictMs: 0,
      createSecretsVault: () => new MemorySecretsVault(),
      runtimePlugins: { "vfs-plugin": vfsPlugin },
    });
    onTestFinished(() => registry[Symbol.asyncDispose]());

    const virtualPath = "/virtual/wave4-repo";
    const lease1 = await registry.acquire("tenant-w4");
    const k1 = lease1.kernel;

    await expect(
      k1.handleRequest("project/configure", {
        workspacePath: virtualPath,
        kind: "virtual",
        enabledPlugins: ["vfs-plugin"],
        pluginConfigs: { "vfs-plugin": { rootLabel: 123 } },
      }),
    ).rejects.toThrow();

    await expect(
      k1.handleRequest("project/configure", {
        workspacePath: virtualPath,
        kind: "virtual",
        enabledPlugins: ["vfs-plugin"],
      }),
    ).rejects.toThrow(/missing or invalid config for enabled plugin vfs-plugin/);

    await expect(
      k1.handleRequest("project/configure", {
        workspacePath: virtualPath,
        kind: "virtual",
        enabledPlugins: ["no-such-plugin"],
      }),
    ).rejects.toThrow(/unknown or disallowed plugin|unknown plugin/);

    const configured = (await k1.handleRequest("project/configure", {
      projectId: "proj-v1",
      workspacePath: virtualPath,
      kind: "virtual",
      title: "Virtual Repo 1",
      enabledPlugins: ["vfs-plugin"],
      pluginConfigs: {
        "vfs-plugin": {
          rootLabel: "alpha",
          initialFiles: { "README.md": "hello" },
        },
      },
    })) as {
      projectId: string;
      kind: string;
      title: string;
      enabledPlugins: string[];
      pluginConfigs: Record<string, Record<string, unknown>>;
    };

    expect(configured).toEqual({
      projectId: "proj-v1",
      workspacePath: virtualPath,
      kind: "virtual",
      title: "Virtual Repo 1",
      enabledPlugins: ["vfs-plugin"],
      pluginConfigs: {
        "vfs-plugin": {
          rootLabel: "alpha",
          initialFiles: { "README.md": "hello" },
        },
      },
    });

    const dbRow = await db.get("projects", "proj-v1");
    expect(dbRow).toMatchObject({
      projectId: "proj-v1",
      kernelId: "tenant-w4",
      kind: "virtual",
      title: "Virtual Repo 1",
      workspacePath: virtualPath,
    });

    const p1 = k1.project(virtualPath);
    await p1.ready;
    expect(p1.doc.root.pluginsConfigured).toBe(true);
    expect(p1.doc.root.kind).toBe("virtual");
    expect(p1.doc.root.title).toBe("Virtual Repo 1");
    expect(p1.effectiveCatalog.catalogEntry("vfs_info")).toBeDefined();
    expect(existsSync(virtualPath)).toBe(false);
    expect(activateCount).toBe(1);

    const s1 = await p1.session("s-virt-1");
    expect(s1.root.projectId).toBe("proj-v1");
    expect(workspaceEnvOf(s1.root)?.logicalRoot).toBe(virtualPath);

    await k1.handleRequest("project/configure", {
      projectId: "proj-v1",
      workspacePath: virtualPath,
      kind: "virtual",
      title: "Virtual Repo 1 (Beta)",
      enabledPlugins: ["vfs-plugin"],
      pluginConfigs: {
        "vfs-plugin": {
          rootLabel: "beta",
          initialFiles: { "README.md": "v2" },
        },
      },
    });

    expect(disposeCount).toBe(1);
    expect(activateCount).toBe(2);

    await s1.park();
    lease1[Symbol.dispose]();
    expect(await registry.evict("tenant-w4")).toBe(true);
    expect(disposeCount).toBe(2);

    const lease2 = await registry.acquire("tenant-w4");
    onTestFinished(() => lease2[Symbol.dispose]());
    const p2 = lease2.kernel.project(virtualPath);
    await p2.ready;
    expect(p2.doc.root.kind).toBe("virtual");
    expect(p2.doc.root.title).toBe("Virtual Repo 1 (Beta)");
    expect(p2.doc.root.pluginsConfigured).toBe(true);
    expect(activateCount).toBe(3);

    const s2 = await p2.session("s-virt-1");
    expect(s2.root.projectId).toBe("proj-v1");
    expect(lifecycleEvents).toEqual([
      "activate#1:proj-v1:alpha",
      "dispose#1:proj-v1:alpha",
      "activate#2:proj-v1:beta",
      "dispose#2:proj-v1:beta",
      "activate#3:proj-v1:beta",
    ]);
  });

  it("toggles FS/shell via toolkit, shell, and @inhuman.tools/plugin-local-env across server and local contours", async () => {
    const dir = tempDir("w4-toggle-");
    const db = new SqliteKvStore(join(dir, "harness.db"));
    onTestFinished(() => db.close());

    const serverKernel = new KernelDaemon({
      contour: "server",
      kernelId: "tenant-toggle",
      db,
      ownsDb: false,
      secrets: new MemorySecretsVault(),
    });
    onTestFinished(() => serverKernel[Symbol.asyncDispose]());
    await serverKernel.ready;

    // Server contour defaults: toolkit + shell are disabled.
    expect(serverKernel.catalog.catalogEntry("write_file")).toBeUndefined();
    expect(serverKernel.catalog.catalogEntry("edit_file")).toBeUndefined();
    expect(serverKernel.catalog.catalogEntry("shell")).toBeUndefined();
    expect(serverKernel.catalog.catalogEntry("read_file")).toBeUndefined();
    expect(serverKernel.catalog.TOOLS_SYSTEM_ADDENDUM).not.toContain("write_file");
    expect(serverKernel.catalog.TOOLS_SYSTEM_ADDENDUM).not.toContain("edit_file");
    expect(serverKernel.catalog.TOOLS_SYSTEM_ADDENDUM).not.toContain("shell");
    expect(serverKernel.catalog.TOOLS_SYSTEM_ADDENDUM).not.toContain(
      "File paths resolve from the project root, not /.",
    );

    const inheritProject = serverKernel.project("/virtual/inherit-proj");
    await inheritProject.ready;
    const inheritSession = await inheritProject.session("s-inherit");
    const turn = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`p`, queue: [] });
    const refusedShell = inheritProject.toolCalls.admit(
      { id: "call_1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "pwd" }) } },
      inheritProject.effectiveCatalog,
      { session: inheritSession.root },
    );
    const refusedWrite = inheritProject.toolCalls.admit(
      {
        id: "call_2",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x" }) },
      },
      inheritProject.effectiveCatalog,
      { session: inheritSession.root },
    );
    runInAction(() => {
      inheritSession.root.head = turn;
      turn.pushChild(refusedShell);
      turn.pushChild(refusedWrite);
    });
    await executeSystemTool(refusedShell as SystemToolJob, new AbortController().signal);
    await executeSystemTool(refusedWrite as SystemToolJob, new AbortController().signal);
    expect(refusedShell.outcomeSnap?.ok).toBe(false);
    expect(refusedShell.outcomeSnap?.text).toMatch(/unknown tool "shell"/);
    expect(refusedWrite.outcomeSnap?.ok).toBe(false);
    expect(refusedWrite.outcomeSnap?.text).toMatch(/unknown tool "write_file"/);

    // Enable both toolkit and shell via umbrella @inhuman.tools/plugin-local-env.
    await serverKernel.handleRequest("plugin/set", { name: LOCAL_ENV_PLUGIN_NAME, enabled: true });
    expect(serverKernel.catalog.catalogEntry("write_file")).toBeDefined();
    expect(serverKernel.catalog.catalogEntry("edit_file")).toBeDefined();
    expect(serverKernel.catalog.catalogEntry("shell")).toBeDefined();
    expect(serverKernel.catalog.catalogEntry("read_file")).toBeDefined();
    expect(serverKernel.catalog.TOOLS_SYSTEM_ADDENDUM).toBe(DEFAULT_PRODUCT_TOOLS_ADDENDUM);
    expect(inheritProject.effectiveCatalog.catalogEntry("shell")).toBeDefined();
    expect(inheritProject.effectiveCatalog.TOOLS_SYSTEM_ADDENDUM).toBe(DEFAULT_PRODUCT_TOOLS_ADDENDUM);

    // Per-project overlay can enable toolkit without shell, leaving sibling project untouched.
    await serverKernel.handleRequest("project/configure", {
      projectId: "proj-no-shell",
      workspacePath: "/virtual/no-shell",
      kind: "virtual",
      enabledPlugins: [TOOLKIT_PLUGIN_NAME],
    });
    const noShellProject = serverKernel.project("/virtual/no-shell");
    await noShellProject.ready;
    expect(noShellProject.effectiveCatalog.catalogEntry("write_file")).toBeDefined();
    expect(noShellProject.effectiveCatalog.catalogEntry("read_file")).toBeDefined();
    expect(noShellProject.effectiveCatalog.catalogEntry("shell")).toBeUndefined();
    expect(noShellProject.effectiveCatalog.TOOLS_SYSTEM_ADDENDUM).toContain("write_file, edit_file");
    expect(noShellProject.effectiveCatalog.TOOLS_SYSTEM_ADDENDUM).not.toContain(
      "JSON tools are write_file, edit_file, shell",
    );
    expect(noShellProject.effectiveCatalog.TOOLS_SYSTEM_ADDENDUM).toContain(
      "File paths resolve from the project root, not /.",
    );
    expect(inheritProject.effectiveCatalog.catalogEntry("shell")).toBeDefined();

    // Local contour defaults both enabled, and can toggle shell independently or via umbrella.
    const localRoot = tempDir("w4-local-");
    const localKernel = new KernelDaemon(localRoot);
    onTestFinished(() => localKernel[Symbol.asyncDispose]());
    await localKernel.ready;

    expect(localKernel.catalog.TOOLS_SYSTEM_ADDENDUM).toBe(DEFAULT_PRODUCT_TOOLS_ADDENDUM);
    expect(localKernel.catalog.catalogEntry("shell")).toBeDefined();
    expect(localKernel.catalog.catalogEntry("write_file")).toBeDefined();

    await localKernel.handleRequest("plugin/set", { name: SHELL_PLUGIN_NAME, enabled: false });
    expect(localKernel.catalog.catalogEntry("shell")).toBeUndefined();
    expect(localKernel.catalog.catalogEntry("write_file")).toBeDefined();
    expect(localKernel.catalog.TOOLS_SYSTEM_ADDENDUM).not.toBe(DEFAULT_PRODUCT_TOOLS_ADDENDUM);
    expect(localKernel.catalog.TOOLS_SYSTEM_ADDENDUM).toContain("File paths resolve from the project root, not /.");

    await localKernel.handleRequest("plugin/set", { name: LOCAL_ENV_PLUGIN_NAME, enabled: false });
    expect(localKernel.catalog.catalogEntry("shell")).toBeUndefined();
    expect(localKernel.catalog.catalogEntry("write_file")).toBeUndefined();
    expect(localKernel.catalog.catalogEntry("read_file")).toBeUndefined();
  });

  it("enforces symlink policy prohibit and writeFileAdmitSnap via virtual VFS WorkspaceEnvPort without host FS", async () => {
    const dir = tempDir("w4-vfs-");
    const db = new SqliteKvStore(join(dir, "harness.db"));
    onTestFinished(() => db.close());

    const virtualWs = "/virtual/ws";
    const files = new Map<string, string>([
      [`${virtualWs}/note.txt`, "prev\n"],
      [`${virtualWs}/.env`, "SECRET=top-secret\n"],
    ]);
    const symlinks = new Map<string, string>([[`${virtualWs}/link.txt`, `${virtualWs}/.env`]]);

    const vfsEnvPlugin = new InhumanPlugin({
      projectConfigSchema: z.object({ mode: z.literal("mem").default("mem") }),
      activateProject(ctx) {
        const resolveCanonical = (target: string): string => symlinks.get(target) ?? target;
        const env: WorkspaceEnvPort = {
          logicalRoot: ctx.workspacePath,
          resolveCanonicalPathSync: resolveCanonical,
          resolveCanonicalPath: async (target) => resolveCanonical(target),
          probeWriteTarget: (target) => {
            const canonical = resolveCanonical(target);
            const text = files.get(canonical);
            return text !== undefined
              ? { exists: true, isDirectory: false, canonicalPath: canonical, textContent: text }
              : { exists: false };
          },
        };
        const vfsWrite = defineTool({
          name: "vfs_write",
          description: "Write a file into the in-memory VFS.",
          class: "write",
          representation: "tool",
          input: z.object({ path: z.string(), content: z.string() }),
          output: z.object({ ok: z.boolean(), canonicalPath: z.string() }),
          run: (args, callCtx) => {
            const wsEnv = callCtx.workspaceEnv;
            const raw = `${ctx.workspacePath}/${args.path}`;
            const canonical = wsEnv?.resolveCanonicalPathSync?.(raw) ?? raw;
            files.set(canonical, args.content);
            return { ok: true, canonicalPath: canonical };
          },
        });
        const vfsRead = defineTool({
          name: "vfs_read",
          description: "Read a file from the in-memory VFS.",
          class: "read",
          representation: "tool",
          input: z.object({ path: z.string() }),
          output: z.object({ content: z.string().nullable() }),
          run: (args, callCtx) => {
            const raw = `${ctx.workspacePath}/${args.path}`;
            const probed = callCtx.workspaceEnv?.probeWriteTarget?.(raw);
            return { content: probed?.exists ? (probed.textContent ?? null) : null };
          },
        });
        return {
          workspaceEnv: env,
          tools: [vfsRead, vfsWrite],
          [Symbol.dispose]() {},
        };
      },
    });

    const kernel = new KernelDaemon({
      contour: "server",
      kernelId: "tenant-vfs",
      db,
      ownsDb: false,
      secrets: new MemorySecretsVault(),
      runtimePlugins: { "vfs-env": vfsEnvPlugin },
    });
    onTestFinished(() => kernel[Symbol.asyncDispose]());
    await kernel.ready;

    await kernel.handleRequest("project/configure", {
      projectId: "proj-vfs",
      workspacePath: virtualWs,
      kind: "virtual",
      enabledPlugins: ["vfs-env"],
      pluginConfigs: { "vfs-env": { mode: "mem" } },
    });

    const project = kernel.project(virtualWs);
    await project.ready;
    const session = await project.session("s-vfs");
    const env = workspaceEnvOf(session.root);
    expect(env).toBeDefined();
    expect(existsSync(virtualWs)).toBe(false);

    // Policy floor uses WorkspaceEnvPort symlink resolution and prohibits writing through link.txt -> .env
    const scope = new LicenseScope(session.root);
    onTestFinished(() => scope.close());
    const explanation = await explainCall(scope, {
      kind: "path",
      cluster: "write",
      path: "link.txt",
    });
    expect(explanation.tier).toBe("block");
    expect(explanation.outcome).toBe("blocked");

    // writeFileAdmitSnap inspects virtual note.txt without touching host FS
    const blockedOverwrite = writeFileAdmitSnap(session.root.path, JSON.stringify({ path: "note.txt" }), env);
    expect(blockedOverwrite.existed).toBe(true);
    expect(blockedOverwrite.priorContent).toBe("prev\n");
    expect(blockedOverwrite.refuse).toMatch(/exists/);

    const allowedOverwrite = writeFileAdmitSnap(
      session.root.path,
      JSON.stringify({ path: "note.txt", overwriteExisting: true }),
      env,
    );
    expect(allowedOverwrite).toEqual({ existed: true, priorContent: "prev\n", refuse: null });

    // Execute VFS tools with bound WorkspaceEnvPort
    const writeEntry = project.effectiveCatalog.catalogEntry("vfs_write");
    const readEntry = project.effectiveCatalog.catalogEntry("vfs_read");
    expect(writeEntry?.execute).toBeTypeOf("function");
    expect(readEntry?.execute).toBeTypeOf("function");

    const writeRes = await writeEntry!.execute!({ path: "created.txt", content: "virtual content" }, {
      root: session.root.path,
      workspaceEnv: env,
    } as never);
    expect(writeRes).toEqual({ ok: true, canonicalPath: `${virtualWs}/created.txt` });

    const readRes = await readEntry!.execute!({ path: "created.txt" }, {
      root: session.root.path,
      workspaceEnv: env,
    } as never);
    expect(readRes).toEqual({ content: "virtual content" });
    expect(files.get(`${virtualWs}/created.txt`)).toBe("virtual content");
    expect(existsSync(virtualWs)).toBe(false);

    bindWorkspaceEnv(session.root, undefined);
  });
});
