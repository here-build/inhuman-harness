/**
 * needsAcknowledgement over the daemon: ack/pending, ack/answer, ack/list|add|revoke. Acks travel over
 * RPC; the job carries only the daemon-stamped `ackState`.
 */
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import type { SessionDaemon } from "../daemon/session/SessionDaemon.js";

const TIMEOUT = 8_000;

async function open(flags: unknown[]) {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-ack-k-"))));
  await kernel.ready;
  kernel.adjustConfig((config) => {
    config.authorization = { acknowledge: flags } as never;
  });
  const path = await realpath(await mkdtemp(join(tmpdir(), "harness-ack-p-")));
  const project = new ProjectDaemon(kernel, path);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  await when(() => session.root.authorizationUserJson !== "", { timeout: TIMEOUT });
  return { session, kernel };
}

let n = 0;
function call(session: SessionDaemon, command: string): SystemToolJob {
  n += 1;
  const job = new SystemToolJob({ toolCallId: `c${n}`, name: "shell", argsJson: JSON.stringify({ command }) });
  session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [job] });
  return job;
}

const STATUS = { match: { command: ["git", "status"] }, why: "status is audited" };
const answer = (session: SessionDaemon, job: SystemToolJob, extra: Record<string, unknown> = {}) =>
  session.handleRequest("ack/answer", {
    sessionId: "s1",
    jobId: job.uuid,
    ackId: job.uuid,
    accept: true,
    ...extra,
  });

describe("ack over RPC", () => {
  beforeEach(() => resetLocalIDs());

  it("an allowed call waits; ack/pending describes it; ack/answer lets it run", async () => {
    const { session } = await open([STATUS]);
    const job = call(session, "git status");
    await when(() => job.policyResult !== null, { timeout: TIMEOUT });
    expect([job.policyResult, job.ackState, job.licenseDecision, job.needsHuman]).toEqual([
      "policyApprove",
      "pending",
      null,
      true,
    ]);
    const pending = (await session.handleRequest("ack/pending", {})) as {
      acks: Array<{
        ackId: string;
        jobId: string;
        summary: string;
        detail: string;
        flags: unknown[];
        verdict: unknown;
        storeOptions: Array<{ scope: string; defaultTtlMs: number | null }>;
      }>;
    };
    expect(pending.acks).toHaveLength(1);
    const [request] = pending.acks;
    expect(request).toMatchObject({
      ackId: job.uuid,
      jobId: job.uuid,
      summary: 'shell · "git status"',
      flags: [{ label: "`git status`", why: "status is audited", layer: "user" }],
      verdict: { tier: "allow", licensedBy: "floor" },
    });
    expect(request!.detail).toBe('{"command":"git status"}');
    expect(request!.storeOptions.map((option) => [option.scope, option.defaultTtlMs])).toEqual(
      expect.arrayContaining([
        ["session", null],
        ["project", 7 * 86_400_000],
        ["global", 7 * 86_400_000],
      ]),
    );
    expect(request!.storeOptions.some((option) => option.scope === "bot")).toBe(false);

    await expect(answer(session, job)).resolves.toEqual({ ok: true });
    expect([job.ackState, job.humanApprove, job.licenseDecision]).toEqual(["satisfied", null, true]);
    await expect(session.handleRequest("ack/pending", {})).resolves.toEqual({ acks: [] });
  });

  it("remembering at project scope stores a seven-day ack that covers the next call; ack/revoke asks again", async () => {
    const { session, kernel } = await open([STATUS]);
    const first = call(session, "git status");
    await when(() => first.ackState === "pending", { timeout: TIMEOUT });
    const subject = first.ackOptions[0]!.subject;
    const before = Date.now();
    const result = (await answer(session, first, { store: { scope: "project", subject } })) as {
      ok: true;
      ack: { id: string; kind: string; scope: string; scopeKey: string; expiresAtMs: number };
    };
    expect(result.ack).toMatchObject({ kind: "ack", scope: "project", scopeKey: session.root.path });
    expect(result.ack.expiresAtMs).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    // grant/list shows grants, ack/list shows acks: the same store, told apart by kind
    expect(kernel.persistentGrants()).toHaveLength(1);
    await expect(session.handleRequest("grant/list", {})).resolves.toEqual({ rows: [] });
    const listed = (await session.handleRequest("ack/list", {})) as { rows: Array<{ id: string }> };
    expect(listed.rows.map((row) => row.id)).toEqual([result.ack.id]);

    const second = call(session, "git status");
    await when(() => second.policyResult !== null, { timeout: TIMEOUT });
    expect([second.ackState, second.ackedBy, second.licenseDecision]).toEqual(["satisfied", result.ack.id, true]);

    await expect(session.handleRequest("ack/revoke", { id: result.ack.id })).resolves.toEqual({ ok: true });
    const third = call(session, "git status");
    await when(() => third.policyResult !== null, { timeout: TIMEOUT });
    expect([third.ackState, third.licenseDecision]).toEqual(["pending", null]);
  });

  it("a session-scope ack ends with the session and is not shared", async () => {
    const { session } = await open([STATUS]);
    const first = call(session, "git status");
    await when(() => first.ackState === "pending", { timeout: TIMEOUT });
    const result = (await answer(session, first, {
      store: { scope: "session", subject: first.ackOptions[0]!.subject },
    })) as { ack: { expiresAtMs: number | null; scopeKey: string } };
    expect(result.ack).toMatchObject({ expiresAtMs: null, scopeKey: "s1" });
    const next = call(session, "git status");
    await when(() => next.policyResult !== null, { timeout: TIMEOUT });
    expect(next.ackState).toBe("satisfied");
  });

  it("a refusal is a human denial: the call is denied with no policy code, the comment is kept", async () => {
    const { session } = await open([STATUS]);
    const job = call(session, "git status");
    await when(() => job.ackState === "pending", { timeout: TIMEOUT });
    await expect(answer(session, job, { accept: false, comment: "not now" })).resolves.toEqual({ ok: true });
    expect([job.ackState, job.humanApprove, job.licenseDetail, job.approvalComment]).toEqual([
      "refused",
      false,
      { decision: false, code: null },
      "not now",
    ]);
  });

  it("refuses what it should: unknown job, already answered, a subject it did not offer, an unavailable scope", async () => {
    const { session } = await open([STATUS]);
    const job = call(session, "git status");
    await when(() => job.ackState === "pending", { timeout: TIMEOUT });
    await expect(
      session.handleRequest("ack/answer", { sessionId: "s1", jobId: "nope", ackId: "nope", accept: true }),
    ).resolves.toEqual({ ok: false, reason: "not-pending" });
    await expect(
      session.handleRequest("ack/answer", { sessionId: "other", jobId: job.uuid, ackId: job.uuid, accept: true }),
    ).resolves.toEqual({ ok: false, reason: "not-pending" });
    await expect(
      answer(session, job, { store: { scope: "global", subject: { kind: "command", argv0: "git", spine: [], args: [] } } }),
    ).resolves.toEqual({ ok: false, reason: "subject-not-offered" });
    // a class ack is not on offer for a command flag
    await expect(
      answer(session, job, { store: { scope: "global", subject: { kind: "class", class: "publish" } } }),
    ).resolves.toEqual({ ok: false, reason: "subject-not-offered" });
    // this session is not a bot
    await expect(
      answer(session, job, { store: { scope: "bot", subject: job.ackOptions[0]!.subject } }),
    ).resolves.toEqual({ ok: false, reason: "scope-unavailable" });
    expect(job.ackState).toBe("pending");
    await expect(answer(session, job)).resolves.toEqual({ ok: true });
    await expect(answer(session, job)).resolves.toEqual({ ok: false, reason: "not-pending" });
  });

  it("a combined ask + ack is one prompt: ask/answer allow settles both, and ackStore remembers the ack", async () => {
    const { session, kernel } = await open([{ match: { command: ["make", "deploy"] }, why: "deploys are audited" }]);
    const job = call(session, "make deploy");
    await when(() => job.policyResult === "ask", { timeout: TIMEOUT });
    expect([job.ackState, job.needsHuman, job.baseLicenseDetail.decision]).toEqual(["pending", true, null]);
    const pending = (await session.handleRequest("ack/pending", {})) as {
      acks: Array<{ verdict: { tier: string; licensedBy: string } }>;
    };
    expect(pending.acks[0]!.verdict).toMatchObject({ tier: "ask", licensedBy: "pending" });
    await expect(
      session.handleRequest("ask/answer", {
        sessionId: "s1",
        jobId: job.uuid,
        allow: true,
        ackStore: { scope: "global", subject: job.ackOptions[0]!.subject },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect([job.humanApprove, job.ackState]).toEqual([true, "satisfied"]);
    expect(kernel.persistentGrants().map((row) => row.kind)).toEqual(["ack"]);
  });

  it("answering the ack of an ask through ack/answer also settles the ask", async () => {
    const { session } = await open([{ match: { command: ["make", "deploy"] } }]);
    const job = call(session, "make deploy");
    await when(() => job.policyResult === "ask", { timeout: TIMEOUT });
    await expect(answer(session, job)).resolves.toEqual({ ok: true });
    expect([job.humanApprove, job.ackState, job.licenseDecision]).toEqual([true, "satisfied", true]);
  });

  it("a block is never listed or answerable, flagged or not", async () => {
    const { session } = await open([{ match: { command: ["cat"] } }]);
    const job = call(session, "cat .env");
    await when(() => job.policyResult === "block", { timeout: TIMEOUT });
    expect([job.ackState, job.licenseDecision]).toEqual(["none", false]);
    await expect(session.handleRequest("ack/pending", {})).resolves.toEqual({ acks: [] });
    await expect(answer(session, job)).resolves.toEqual({ ok: false, reason: "not-pending" });
  });

  it("settings can store an ack (class subjects are for acks only)", async () => {
    const { session } = await open([]);
    const subject = { kind: "class", class: "publish" } as const;
    await expect(
      session.handleRequest("grant/add", { scope: "global", subject }),
    ).resolves.toEqual({ ok: false, reason: "subject-not-allowed" });
    const added = (await session.handleRequest("ack/add", { scope: "global", subject })) as {
      ok: true;
      row: { kind: string; expiresAtMs: number | null; source: string };
    };
    expect(added.row).toMatchObject({ kind: "ack", expiresAtMs: null, source: "settings" });
    await expect(session.handleRequest("ack/list", {})).resolves.toMatchObject({ rows: [{ kind: "ack" }] });
  });

  it("policy/explain reports the flag and, once acknowledged, the stored ack", async () => {
    const { session } = await open([STATUS]);
    const probe = { probe: { kind: "shell", command: "git status" } } as const;
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({
      tier: "allow",
      outcome: "prompts-you",
      ack: { flags: [{ label: "`git status`" }], satisfiedBy: null },
    });
    await expect(
      session.handleRequest("policy/explain", { ...probe, unattended: true }),
    ).resolves.toMatchObject({ outcome: "denied" });
    await session.handleRequest("ack/add", {
      scope: "session",
      scopeKey: "s1",
      subject: { kind: "command", argv0: "git", spine: ["status"], args: [] },
    });
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({
      outcome: "runs",
      ack: { satisfiedBy: { kind: "ack" } },
    });
  });
});
