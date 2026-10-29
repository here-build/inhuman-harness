/**
 * One-shot / session workers live-follow the caller desk. Project roots do not.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { AskAgentSpec } from "@inhuman.tools/harness-model";
import { mkdtemp } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const TIMEOUT = 8_000;

async function openHarness() {
  const system = await mkdtemp(join(tmpdir(), "harness-desk-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-desk-p-"));
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("caller");
  onTestFinished(() => {
    for (const row of Object.values(project.sessions)) row?.[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { kernel, project, session };
}

describe("worker desk permissions", () => {
  beforeEach(() => resetLocalIDs());

  it("session and one-shot follow caller mode and roots; project does not", async () => {
    const { project, session } = await openHarness();
    session.root.permissionMode = "auto";
    session.root.addReadRoot("/opt/shared");
    const pal = await project.session("w-pal");
    pal.root.agent.spec.recipeScope = "session";
    pal.root.agent.spec.name = "echo";
    pal.root.ensureAgentCallback("req-pal", session.sessionId);
    await when(() => pal.root.permissionMode === "auto" && pal.root.readRoots["/opt/shared"] === "session", {
      timeout: TIMEOUT,
    });
    const shot = await project.session("w-ask");
    shot.root.agent.spec = new AskAgentSpec({ name: "explore" });
    shot.root.ensureAgentCallback("req-ask", session.sessionId);
    await when(() => shot.root.permissionMode === "auto", { timeout: TIMEOUT });
    session.root.permissionMode = "yolo";
    delete session.root.readRoots["/opt/shared"];
    await when(
      () =>
        pal.root.permissionMode === "yolo" &&
        pal.root.readRoots["/opt/shared"] === undefined &&
        shot.root.permissionMode === "yolo",
      { timeout: TIMEOUT },
    );
    const crew = await project.session("w-crew");
    crew.root.agent.spec.recipeScope = "project";
    crew.root.agent.spec.name = "crew";
    crew.root.ensureAgentCallback("req-crew", session.sessionId);
    expect({
      pal: pal.root.permissionMode,
      shot: shot.root.permissionMode,
      crew: { policy: crew.root.permissionMode, scope: crew.root.agent.spec.recipeScope },
    }).toEqual({
      pal: "yolo",
      shot: "yolo",
      crew: { policy: "manual", scope: "project" },
    });
  });
});
