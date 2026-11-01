import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { SessionTurn } from "@inhuman.tools/harness-model";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { PNG } from "pngjs";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import {
  attachScriptedModel,
  installScriptedModel,
  modelOf,
  scriptedConnectionId,
} from "../../../testkit/scripted-model.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

async function openSession(): Promise<{ session: SessionDaemon; kernel: KernelDaemon }> {
  const system = await mkdtemp(join(tmpdir(), "harness-visual-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-visual-p-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  installScriptedModel(kernel, "other");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { session, kernel };
}

const visuals = [
  { mime: "image/png", bytesBase64: PNG.sync.write(new PNG({ width: 1, height: 1 })).toString("base64") },
];

describe("turn.send image capabilities", () => {
  beforeEach(() => resetLocalIDs());

  it.each([
    { model: "gpt-6.1-sol", capabilities: { "gpt-6.1-sol": { inputModalities: ["text", "image"] } } },
    { model: "arbitrary", capabilities: { arbitrary: { inputModalities: ["image"] } } },
    { model: "unknown", capabilities: undefined },
    { model: "gpt-4o-mini", capabilities: { "gpt-4o": { supportsVision: false } } },
    { model: "GPT-4o", capabilities: { "gpt-4o": { supportsVision: false } } },
  ])("allows $model using only the selected connection and exact model", async ({ model, capabilities }) => {
    const { session, kernel } = await openSession();
    await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
    await session.handleRequest("kv/set", { key: "model", value: model });
    kernel.connections[scriptedConnectionId()]!.live = { modelCapabilities: capabilities };
    kernel.connections[scriptedConnectionId("other")]!.live = {
      modelCapabilities: { [model]: { inputModalities: ["text"] } },
    };
    modelOf(session).reply({ text: "seen" });
    await expect(session.handleRequest("turn", { prompt: "describe", visuals })).resolves.toEqual({ ok: true });
    const turn = session.root.head;
    if (!(turn instanceof SessionTurn)) throw new TypeError("expected a turn");
    await when(() => turn.reducerExited, { timeout: 4_000 });
    expect(turn.visuals.map(({ mime, width, height }) => ({ mime, width, height }))).toEqual([
      { mime: "image/png", width: 1, height: 1 },
    ]);
  });

  it.each([
    { model: "arbitrary", capabilities: { arbitrary: { inputModalities: ["text"] } } },
    { model: "gpt-4o", capabilities: { "gpt-4o": { supportsVision: false } } },
    { model: " gpt-4o ", capabilities: { "gpt-4o": { supportsVision: false } } },
    {
      model: "arbitrary",
      connection: ` ${scriptedConnectionId()} `,
      capabilities: { arbitrary: { inputModalities: ["text"] } },
    },
    { model: "", capabilities: undefined },
  ])("rejects explicit text-only or empty model: $model", async (row) => {
    const { model, capabilities } = row;
    const { session, kernel } = await openSession();
    await session.handleRequest("kv/set", {
      key: "connection",
      value: "connection" in row ? row.connection : scriptedConnectionId(),
    });
    await session.handleRequest("kv/set", { key: "model", value: model });
    kernel.connections[scriptedConnectionId()]!.live = { modelCapabilities: capabilities };
    kernel.connections[scriptedConnectionId("other")]!.live = {
      modelCapabilities: { [model]: { inputModalities: ["text", "image"] } },
    };
    await expect(session.handleRequest("turn", { prompt: "describe", visuals })).rejects.toThrow(
      "this model can't see images",
    );
  });

  it("requires a connection before checking model metadata", async () => {
    const { session } = await openSession();
    await session.handleRequest("kv/set", { key: "connection", value: "" });
    await session.handleRequest("kv/set", { key: "model", value: "" });
    await expect(session.handleRequest("turn", { prompt: "describe", visuals })).rejects.toThrow(
      "connection is required",
    );
  });
});
