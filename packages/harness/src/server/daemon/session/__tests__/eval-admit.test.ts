/**
 * Eval admission is one ProgrammaticJob on an ordinary turn. Duplicates
 * reuse identities; `manual` is not a legal eval policy.
 */
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
  evalProgramOf,
  findEvalTurnByRequestId,
  hostingTurnOf,
} from "@inhuman.tools/harness-model";
import { walkWork } from "@inhuman.tools/plexus-expectations";
import { mkdtemp, writeJson } from "fs-extra";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { documentKey } from "@/protocol/document";
import { documentImagePath } from "@/yjs/storage";

import { RpcInvalidParams } from "../../../contract.js";
import { KernelDaemon } from "../../kernel/KernelDaemon.js";
import { ProjectDaemon } from "../../project/ProjectDaemon.js";
import type { SessionDaemon } from "../SessionDaemon.js";

const TIMEOUT = 8_000;

async function openSession(): Promise<SessionDaemon> {
  const system = await mkdtemp(join(tmpdir(), "harness-eval-k-"));
  const workspace = await mkdtemp(join(tmpdir(), "harness-eval-p-"));
  await writeJson(join(system, "config.json"), { connections: {} });
  const kernel = new KernelDaemon(system);
  await kernel.ready;
  const project = new ProjectDaemon(kernel, workspace);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return session;
}

describe("eval admission", () => {
  beforeEach(() => resetLocalIDs());

  it("admit machine: pure Scheme no wire; duplicate reuses; manual refused; busy refused; policy_denied vs residual ask; result/cancel follow admitted turn after head moves; failed persist creates no turn", async () => {
    const session = await openSession();
    const first = (await session.handleRequest("eval", {
      requestId: "req-1",
      expr: "(+ 1 2)",
      policy: "auto",
    })) as { ok: true; turnId: string; programId: string };
    const again = await Promise.all([
      session.handleRequest("eval", { requestId: "req-1", expr: "(+ 1 2)", policy: "auto" }),
      session.handleRequest("eval", { requestId: "req-1", expr: "(+ 1 2)", policy: "auto" }),
    ]);
    const turn = findEvalTurnByRequestId(session.root, "req-1");
    const program = evalProgramOf(turn!);
    await when(() => program?.completed === true && turn?.reducerExited === true, { timeout: TIMEOUT });
    expect({
      first,
      again,
      policy: turn?.evalSpec?.permissionMode,
      prompt: turn?.prompt,
      kvs: session.root.kvs.connection ?? "",
      outcome: program?.outcomeSnap,
    }).toEqual({
      first: { ok: true, turnId: turn?.uuid, programId: program?.uuid },
      again: [
        { ok: true, turnId: turn?.uuid, programId: program?.uuid },
        { ok: true, turnId: turn?.uuid, programId: program?.uuid },
      ],
      policy: "auto",
      prompt: "",
      kvs: "",
      outcome: { ok: true, value: ["3"] },
    });

    const manual = await session.handleRequest("eval", {
      requestId: "req-off",
      expr: "(+ 1 2)",
      policy: "manual",
    });
    const unknown = await session.handleRequest("eval", {
      requestId: "req-unknown",
      expr: "(+ 1 2)",
      policy: "always-approve",
    });
    expect({
      manual,
      unknown,
      manualTurn: findEvalTurnByRequestId(session.root, "req-off"),
      unknownTurn: findEvalTurnByRequestId(session.root, "req-unknown"),
    }).toEqual({
      manual: { ok: false, code: "policy_unavailable", text: expect.stringMatching(/not available/) },
      unknown: { ok: false, code: "policy_unavailable", text: expect.stringMatching(/not available/) },
      manualTurn: null,
      unknownTurn: null,
    });

    const admitted = (await session.handleRequest("eval", {
      requestId: "req-2",
      expr: "(+ 1 2)",
      policy: "yolo",
    })) as { ok: true; turnId: string; programId: string };
    await expect(
      session.handleRequest("eval", { requestId: "req-2", expr: "(+ 3 4)", policy: "yolo" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    expect({ duplicateInput: findEvalTurnByRequestId(session.root, "req-2")?.uuid }).toEqual({
      duplicateInput: admitted.turnId,
    });
    const req2 = findEvalTurnByRequestId(session.root, "req-2")!;
    await when(() => evalProgramOf(req2)?.completed === true && req2.reducerExited, { timeout: TIMEOUT });

    const overlay = new SessionTurn({
      turnTail: turn!,
      prompt: prompt.user`interactive overlay`,
      queue: [],
    });
    session.root.head = overlay;
    session.root.permissionMode = "yolo";
    expect({
      head: session.root.head?.prompt,
      outcome: evalProgramOf(turn!, first.programId)?.outcomeSnap,
      host: hostingTurnOf(session.root, program!),
      requestId: turn!.evalSpec?.requestId,
      policy: turn!.evalSpec?.permissionMode,
    }).toEqual({
      head: "interactive overlay",
      outcome: { ok: true, value: ["3"] },
      host: turn,
      requestId: "req-1",
      policy: "auto",
    });
    await expect(session.handleRequest("turn/cancel", { turnId: first.turnId })).resolves.toEqual({
      ok: true,
    });
    expect({
      evalCancel: turn!.cancelRequested,
      overlayCancel: overlay.cancelRequested,
    }).toEqual({ evalCancel: true, overlayCancel: false });
    overlay.reducerExited = true;

    const secret = join(session.root.path, ".env");
    const allowed = join(session.root.path, "allowed.txt");
    const chat = join(session.root.path, "chat.txt");
    await session.handleRequest("eval", {
      requestId: "req-deny",
      expr: '(write_file ".env" "secret")',
      policy: "auto",
    });
    const denyTurn = findEvalTurnByRequestId(session.root, "req-deny")!;
    const denyProgram = evalProgramOf(denyTurn);
    await when(() => denyProgram?.completed === true && denyTurn.reducerExited, { timeout: TIMEOUT });
    const denyLeaf = [...walkWork(denyTurn)].find((node): node is SystemToolJob => node instanceof SystemToolJob);
    await session.handleRequest("eval", {
      requestId: "req-write",
      expr: '(write_file "allowed.txt" "ok")',
      policy: "yolo",
    });
    const writeTurn = findEvalTurnByRequestId(session.root, "req-write")!;
    const writeProgram = evalProgramOf(writeTurn);
    await when(() => writeProgram?.completed === true && writeTurn.reducerExited, { timeout: TIMEOUT });
    await session.handleRequest("eval", {
      requestId: "req-ask",
      expr: '(shell "curl x")',
      policy: "auto",
    });
    const askTurn = findEvalTurnByRequestId(session.root, "req-ask")!;
    const askProgram = evalProgramOf(askTurn);
    await when(
      () =>
        askProgram != null &&
        [...walkWork(askTurn)].some((node) => node instanceof SystemToolJob && node.policyResult === "ask"),
      { timeout: TIMEOUT },
    );
    // Unattended, an ask the judge cannot decide is not a prompt nobody will answer: after one retry it is
    // denied as interaction_required, and the run goes on.
    await when(() => askProgram?.completed === true && askTurn.reducerExited, { timeout: TIMEOUT });

    const write = new SystemToolJob({
      name: "write_file",
      toolCallId: "c-write",
      argsJson: JSON.stringify({ path: "chat.txt", content: "x" }),
    });
    const sh = new SystemToolJob({
      name: "shell",
      toolCallId: "c-shell",
      argsJson: JSON.stringify({ command: "curl x" }),
    });
    session.root.head = new SessionTurn({
      turnTail: session.root.head ?? new SessionSystemPrompt(),
      prompt: prompt.user`write it`,
      queue: [write, sh],
      permissionMode: "manual",
    });
    await when(() => write.policyResult === "ask" && sh.policyResult === "ask", { timeout: TIMEOUT });
    expect({
      deny: {
        leaf: denyLeaf?.outcomeSnap,
        outcome: denyProgram?.outcomeSnap,
        file: existsSync(secret),
      },
      write: {
        outcome: writeProgram?.outcomeSnap,
        file: existsSync(allowed),
      },
      ask: {
        outcome: askProgram?.outcomeSnap,
        policyResult: [...walkWork(askTurn)].find((node): node is SystemToolJob => node instanceof SystemToolJob)
          ?.policyResult,
      },
      interactive: {
        write: write.humanApprove,
        writeCompleted: write.completed,
        shell: sh.humanApprove,
        file: existsSync(chat),
      },
    }).toEqual({
      deny: {
        leaf: {
          ok: false,
          text: "Policy prohibits this tool use. Do not try to bypass it; if this is crucial, ask user to do it",
          refusalReason:
            "Policy prohibits this tool use. Do not try to bypass it; if this is crucial, ask user to do it",
          code: "policy_denied",
        },
        outcome: {
          ok: false,
          text: expect.stringMatching(/Policy prohibits this tool use/),
          code: "policy_denied",
        },
        file: false,
      },
      write: { outcome: { ok: true, value: [expect.anything()] }, file: true },
      ask: {
        outcome: { ok: false, text: expect.stringMatching(/needs a person/), code: "interaction_required" },
        policyResult: "ask",
      },
      interactive: { write: null, writeCompleted: false, shell: null, file: false },
    });

    const busySession = await openSession();
    const pending = new SystemToolJob({
      name: "shell",
      argsJson: '{"command":"true"}',
    });
    busySession.root.head = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      prompt: prompt.user`busy`,
      queue: [pending],
    });
    await when(() => busySession.root.findRunningTurn() != null, { timeout: TIMEOUT });
    await expect(
      busySession.handleRequest("eval", { requestId: "req-busy", expr: "(+ 1 2)", policy: "auto" }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    expect({ busy: findEvalTurnByRequestId(busySession.root, "req-busy") }).toEqual({ busy: null });

    const persistSession = await openSession();
    const sessionsDir = join(persistSession.kernel.root, "documents", "sessions");
    const image = documentImagePath(persistSession.kernel.root, documentKey("sessions", persistSession.sessionId));
    expect(existsSync(image)).toBe(true);
    await chmod(sessionsDir, 0o555);
    await chmod(image, 0o444);
    onTestFinished(async () => {
      await chmod(image, 0o600);
      await chmod(sessionsDir, 0o755);
    });
    const target = join(persistSession.root.path, "escaped.txt");
    await expect(
      persistSession.handleRequest("eval", {
        requestId: "req-persist",
        expr: '(write_file "escaped.txt" "nope")',
        policy: "yolo",
      }),
    ).rejects.toBeInstanceOf(RpcInvalidParams);
    const leftover = findEvalTurnByRequestId(persistSession.root, "req-persist");
    expect({
      file: existsSync(target),
      leftover:
        leftover == null
          ? null
          : { cancelRequested: leftover.cancelRequested, completed: evalProgramOf(leftover)?.completed },
    }).toEqual({
      file: false,
      leftover: leftover == null ? null : { cancelRequested: true, completed: true },
    });
  }, 30_000);
});
