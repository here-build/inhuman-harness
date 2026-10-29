import { tmpdir } from "node:os";
import { join } from "node:path";

import { KERNEL_DOC_GUID, KernelPlexus, SessionPlexus } from "@inhuman.tools/harness-model";
import { mkdtemp, readJson } from "fs-extra";
import { autorun } from "mobx";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";

const SEEDED = { theme: "project", editor: "vim", connection: "grok", goal: "ship" };

describe("session kv", () => {
  it("last-choice bag: kv and permissionMode seed, attach, clear, scope, replica", async () => {
    using hosts = await fixture();
    const { kernel, project } = hosts;

    const snapshots: Array<Record<string, string>> = [];
    const stopWatch = autorun(() => {
      snapshots.push({
        theme: kernel.plexus.root.kvs.theme ?? "<absent>",
        editor: kernel.plexus.root.kvs.editor ?? "<absent>",
        connection: kernel.plexus.root.kvs.connection ?? "<absent>",
        scratch: kernel.plexus.root.kvs.scratch ?? "<absent>",
      });
    });
    kernel.plexus.root.applyKvs([
      { form: "kv-set", key: "theme", value: "kernel" },
      { form: "kv-set", key: "editor", value: "vim" },
      { form: "kv-set", key: "connection", value: "grok" },
      { form: "kv-set", key: "scratch", value: "x" },
      { form: "kv-clear", key: "scratch" },
    ]);
    stopWatch();
    expect(snapshots).toEqual([
      { theme: "<absent>", editor: "<absent>", connection: "<absent>", scratch: "<absent>" },
      { theme: "kernel", editor: "vim", connection: "grok", scratch: "<absent>" },
    ]);

    project.root.applyKvs([
      { form: "kv-set", key: "theme", value: "project" },
      { form: "kv-set", key: "goal", value: "ship" },
    ]);

    const session = await project.session("s1");
    expect({
      session: session.root.kvs,
      kernelTheme: kernel.plexus.root.kvs.theme,
      projectEditor: project.root.kvs.editor,
    }).toEqual({
      session: SEEDED,
      kernelTheme: "kernel",
      projectEditor: undefined,
    });

    using sessionReplica = liveSessionReplica(session.plexus);
    using kernelReplica = liveKernelReplica(kernel.plexus);
    expect(sessionReplica.root.kvs).toEqual(SEEDED);

    kernel.plexus.root.applyKvs([{ form: "kv-set", key: "later", value: "nope" }]);
    const attached = await project.session("s1");
    expect({ same: attached === session, kvs: attached.root.kvs }).toEqual({ same: true, kvs: SEEDED });

    const next = await project.session("s2");
    expect({
      s2: next.root.kvs,
      s1Later: session.root.kvs.later,
    }).toEqual({
      s2: { ...SEEDED, later: "nope" },
      s1Later: undefined,
    });

    await expect(session.handleRequest("kv/set", { key: "model", value: "m1", remember: true })).resolves.toEqual({
      ok: true,
    });
    expect({
      session: session.root.kvs.model,
      project: project.root.kvs.model,
      kernel: kernel.plexus.root.kvs.model,
      replica: sessionReplica.root.kvs.model,
      used: kernel.plexus.root.modelsUsage["grok/m1"],
      file: await readJson(join(kernel.root, "kv.json")),
      s3: (await project.session("s3")).root.kvs.model,
    }).toEqual({
      session: "m1",
      project: "m1",
      kernel: "m1",
      replica: "m1",
      used: expect.any(Number),
      file: expect.objectContaining({ model: "m1" }),
      s3: "m1",
    });

    await session.handleRequest("kv/set", { key: "theme", value: "session" });
    await session.handleRequest("kv/clear", { key: "theme" });
    expect({
      session: session.root.kvs.theme,
      project: project.root.kvs.theme,
      kernel: kernel.plexus.root.kvs.theme,
      file: await readJson(join(kernel.root, "kv.json")),
      s4: (await project.session("s4")).root.kvs.theme,
    }).toEqual({
      session: undefined,
      project: "session",
      kernel: "session",
      file: expect.objectContaining({ theme: "session" }),
      s4: "session",
    });

    await session.handleRequest("kv/set", { key: "goal", value: "other", scope: "project" });
    expect({
      project: project.root.kvs.goal,
      session: session.root.kvs.goal,
      kernel: kernel.plexus.root.kvs.goal,
    }).toEqual({ project: "other", session: "ship", kernel: undefined });

    await session.handleRequest("kv/set", { key: "font", value: "mono", scope: "kernel" });
    expect({
      kernel: kernel.plexus.root.kvs.font,
      replica: kernelReplica.root.kvs.font,
      session: session.root.kvs.font,
      project: project.root.kvs.font,
      file: await readJson(join(kernel.root, "kv.json")),
    }).toEqual({
      kernel: "mono",
      replica: "mono",
      session: undefined,
      project: undefined,
      file: expect.objectContaining({ font: "mono" }),
    });

    await session.handleRequest("kv/clear", { key: "font", scope: "kernel" });
    expect({
      kernel: kernel.plexus.root.kvs.font,
      replica: kernelReplica.root.kvs.font,
      file: await readJson(join(kernel.root, "kv.json")),
    }).toEqual({
      kernel: undefined,
      replica: undefined,
      file: { model: "m1", theme: "session" },
    });

    expect({
      session: session.root.permissionMode,
      project: project.root.defaultPermissionMode,
      kernel: kernel.plexus.root.defaultPermissionMode,
    }).toEqual({ session: "manual", project: "", kernel: "manual" });

    session.root.permissionMode = "yolo";
    expect({
      session: session.root.permissionMode,
      project: project.root.defaultPermissionMode,
      kernel: kernel.plexus.root.defaultPermissionMode,
      config: await configPolicy(kernel.root),
    }).toEqual({ session: "yolo", project: "", kernel: "manual", config: undefined });

    await expect(session.handleRequest("policy/set", { policy: "auto" })).resolves.toEqual({ ok: true });
    expect({
      session: session.root.permissionMode,
      standing: session.root.standingPermissionMode,
      project: project.root.defaultPermissionMode,
      kernel: kernel.plexus.root.defaultPermissionMode,
      config: await configPolicy(kernel.root),
    }).toEqual({ session: "auto", standing: "auto", project: "auto", kernel: "auto", config: "auto" });

    const policyAttached = await project.session("s1");
    kernel.adjustConfig((config) => {
      config.defaultPermissionMode = "yolo";
    });
    const afterAuto = await project.session("s-auto");
    expect({
      same: policyAttached === session,
      current: policyAttached.root.permissionMode,
      project: project.root.defaultPermissionMode,
      minted: afterAuto.root.permissionMode,
    }).toEqual({ same: true, current: "auto", project: "auto", minted: "auto" });

    using other = await secondProject(kernel);
    const fresh = await other.session("p2-s1");
    expect({
      session: fresh.root.permissionMode,
      project: other.root.defaultPermissionMode,
      kernel: kernel.plexus.root.defaultPermissionMode,
    }).toEqual({ session: "yolo", project: "", kernel: "yolo" });

    await expect(fresh.handleRequest("policy/set", { policy: "manual" })).resolves.toEqual({ ok: true });
    expect({
      other: other.root.defaultPermissionMode,
      original: project.root.defaultPermissionMode,
      kernel: kernel.plexus.root.defaultPermissionMode,
      config: await configPolicy(kernel.root),
      s3: (await project.session("s5")).root.permissionMode,
      p2: (await other.session("p2-s2")).root.permissionMode,
    }).toEqual({
      other: "manual",
      original: "auto",
      kernel: "manual",
      config: "manual",
      s3: "auto",
      p2: "manual",
    });
  });

  it("lastUsedConnectionModel: mint merges kernel+project; remember writes through, a bare set does not", async () => {
    using hosts = await fixture();
    const { kernel, project } = hosts;

    kernel.plexus.root.stampModelUsage("work", "gpt-4");
    const seeded = await project.session("lucm-s1");
    expect(seeded.root.lastUsedConnectionModel).toEqual({ work: "gpt-4" });

    // Project wins on collision; kernel-only keys survive.
    project.root.stampLastUsedConnectionModel("work", "gpt-4o");
    project.root.stampLastUsedConnectionModel("personal", "claude");
    const merged = await project.session("lucm-s2");
    expect(merged.root.lastUsedConnectionModel).toEqual({ work: "gpt-4o", personal: "claude" });

    // Bare session writes stay on the session. Subagent and --model use this.
    await merged.handleRequest("kv/set", { key: "connection", value: "work" });
    await merged.handleRequest("kv/set", { key: "model", value: "gpt-5" });
    expect({
      sessionModel: merged.root.kvs.model,
      sessionLast: merged.root.lastUsedConnectionModel.work,
      projectModel: project.root.kvs.model,
      projectLast: project.root.lastUsedConnectionModel.work,
      kernelModel: kernel.plexus.root.kvs.model,
      kernelLast: kernel.plexus.root.lastUsedConnectionModel.work,
      used: kernel.plexus.root.modelsUsage["work/gpt-5"],
    }).toEqual({
      sessionModel: "gpt-5",
      sessionLast: "gpt-4o",
      projectModel: undefined,
      projectLast: "gpt-4o",
      kernelModel: undefined,
      kernelLast: "gpt-4",
      used: undefined,
    });

    // /model and /connect pass remember: session + project + kernel.
    await merged.handleRequest("kv/set", { key: "connection", value: "work", remember: true });
    await merged.handleRequest("kv/set", { key: "model", value: "gpt-5", remember: true });
    expect({
      session: merged.root.lastUsedConnectionModel.work,
      project: project.root.lastUsedConnectionModel.work,
      kernel: kernel.plexus.root.lastUsedConnectionModel.work,
    }).toEqual({ session: "gpt-5", project: "gpt-5", kernel: "gpt-5" });

    // Later sessions mint the remembered state.
    expect((await project.session("lucm-s3")).root.lastUsedConnectionModel).toEqual({
      work: "gpt-5",
      personal: "claude",
    });
  });
});

type Hosts = {
  kernel: KernelDaemon;
  project: ProjectDaemon;
  [Symbol.dispose](): void;
};

async function fixture(): Promise<Hosts> {
  const system = await mkdtemp(join(tmpdir(), "harness-skv-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-skv-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  return {
    kernel,
    project,
    [Symbol.dispose](): void {
      project[Symbol.dispose]();
      kernel[Symbol.dispose]();
    },
  };
}

async function secondProject(kernel: KernelDaemon): Promise<ProjectDaemon> {
  const workspace = await mkdtemp(join(tmpdir(), "harness-skv-p2-"));
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  return project;
}

async function configPolicy(root: string): Promise<unknown> {
  return ((await readJson(join(root, "config.json"))) as { defaultPermissionMode?: unknown }).defaultPermissionMode;
}

function liveSessionReplica(owner: SessionPlexus): { root: SessionPlexus["root"]; [Symbol.dispose](): void } {
  const doc = new Y.Doc({ guid: owner.doc.guid });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc));
  const plexus = SessionPlexus.connect(doc);
  owner.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === doc) return;
    Y.applyUpdate(doc, update, owner.doc);
  });
  return {
    get root() {
      return plexus.root;
    },
    [Symbol.dispose](): void {
      doc.destroy();
    },
  };
}

function liveKernelReplica(owner: KernelPlexus): { root: KernelPlexus["root"]; [Symbol.dispose](): void } {
  const doc = new Y.Doc({ guid: KERNEL_DOC_GUID });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(owner.doc));
  const plexus = KernelPlexus.connect(doc);
  owner.doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === doc) return;
    Y.applyUpdate(doc, update, owner.doc);
  });
  return {
    get root() {
      return plexus.root;
    },
    [Symbol.dispose](): void {
      doc.destroy();
    },
  };
}
