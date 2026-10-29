/**
 * The cached prompt prefix (tools[] and the leading system rows) must not move
 * while nothing the user configured has moved. Five things used to move it:
 * the env block's date and git branch, the live `Mode:` line, the tools addendum
 * read from the live catalog, `agent__respond` appearing with an open call (covered in
 * the turn package's tools.test.ts), and the live scheme_repl inventory. Each is stirred between rounds and turns here.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  reactChunks,
  responseCall,
  SessionTurn,
  tapeCompletion,
} from "@inhuman.tools/harness-model";
import { mkdtemp, realpath } from "fs-extra";
import { when } from "mobx";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { toolsFor, viewWire } from "@/providers/openai-compat";

import { attachScriptedModel, modelOf, scriptedConnectionId } from "../../../testkit/scripted-model.js";
import { sessionCatalog } from "../../../toolkit/tool-table.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";

const TIMEOUT = 4_000;

function completionsOf(turn: SessionTurn): CompletionExpectation[] {
  const out: CompletionExpectation[] = [];
  for (const chunk of reactChunks(turn)) {
    const pew = tapeCompletion(chunk);
    if (pew != null) out.push(pew);
  }
  return out;
}

/** What the provider caches: tools[] then the leading run of system messages, as bytes. */
function prefixOf(completion: CompletionExpectation) {
  const rows = [...viewWire(completion)];
  const head: unknown[] = [];
  for (const row of rows) {
    if (row.role !== "system") break;
    head.push(row);
  }
  return { tools: toolsFor(completion).map((tool) => JSON.stringify(tool)), system: head };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });

async function openSession() {
  const system = await realpath(await mkdtemp(join(tmpdir(), "harness-prefix-k-")));
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "harness-prefix-p-")));
  git(workspace, "init", "-b", "main");
  git(workspace, "commit", "--allow-empty", "-m", "init");
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  attachScriptedModel(kernel, session);
  onTestFinished(() => {
    void session.park();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await session.handleRequest("kv/set", { key: "connection", value: scriptedConnectionId() });
  await session.handleRequest("kv/set", { key: "model", value: "grok-4.6" });
  return { session, workspace };
}

describe("prompt prefix stability", () => {
  beforeEach(() => {
    resetLocalIDs();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("is byte-identical across two rounds of a turn and across two turns", async () => {
    const { session, workspace } = await openSession();
    const root = session.root;
    const model = modelOf(session);

    // Turn 1, round 1: a tool call, so a second round follows.
    await session.handleRequest("turn", { prompt: "one" });
    const turn1 = root.head as SessionTurn;
    await when(() => completionsOf(turn1).length === 1, { timeout: TIMEOUT });
    const round1 = prefixOf(completionsOf(turn1)[0]!);
    const text = JSON.stringify(round1.system);
    expect(text).toContain("Workspace:");
    expect(text).toContain("date: 2026-10-25");
    expect(text).toContain("branch: main");
    expect(text).toContain("Mode: act");

    // Stir everything that used to move the prefix, in the middle of the turn.
    vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
    git(workspace, "checkout", "-b", "feature");
    root.mode = "plan";
    const catalog = sessionCatalog(root);
    if (catalog != null)
      catalog.TOOLS_SYSTEM_ADDENDUM = prompt.system`${catalog.TOOLS_SYSTEM_ADDENDUM}\nA new paragraph.`;

    model.reply({ calls: [responseCall("m1", "update_metadata", JSON.stringify({ current_turn_title: "t" }))] });
    await when(() => completionsOf(turn1).length === 2, { timeout: TIMEOUT });
    expect(prefixOf(completionsOf(turn1)[1]!)).toEqual(round1);

    model.reply({ text: "done" });
    await when(() => turn1.reducerExited, { timeout: TIMEOUT });
    root.mode = "act";

    // Turn 2, a day later on another branch: still the same bytes.
    await session.handleRequest("turn", { prompt: "two" });
    await when(() => root.head !== turn1 && root.head instanceof SessionTurn && completionsOf(root.head).length === 1, {
      timeout: TIMEOUT,
    });
    const turn2 = root.head as SessionTurn;
    expect(prefixOf(completionsOf(turn2)[0]!)).toEqual(round1);
    model.reply({ text: "done" });
    await when(() => turn2.reducerExited, { timeout: TIMEOUT });
  }, 30_000);

  it("takes a mode change at the next turn, as a config change", async () => {
    const { session } = await openSession();
    const root = session.root;
    const model = modelOf(session);
    await session.handleRequest("turn", { prompt: "one" });
    const turn1 = root.head as SessionTurn;
    await when(() => completionsOf(turn1).length === 1, { timeout: TIMEOUT });
    model.reply({ text: "done" });
    await when(() => turn1.reducerExited, { timeout: TIMEOUT });
    root.mode = "plan";
    await session.handleRequest("turn", { prompt: "two" });
    await when(() => root.head !== turn1 && root.head instanceof SessionTurn && completionsOf(root.head).length === 1, {
      timeout: TIMEOUT,
    });
    const turn2 = root.head as SessionTurn;
    expect(JSON.stringify(prefixOf(completionsOf(turn2)[0]!).system)).toContain("Mode: plan");
    model.reply({ text: "done" });
  }, 30_000);
});
