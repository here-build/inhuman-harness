/**
 * Policy v2 over the daemon: `policy/explain`, `policy/overlay`, `policy/config-get`, `ask/answer` with
 * `store`, grants across scopes, the project layer, and a bot's permission mode.
 */
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { parseGrantRows, SessionSystemPrompt, SessionTurn, SystemToolJob } from "@inhuman.tools/harness-model";
import { runInAction, when } from "mobx";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { botPermissionMode } from "../daemon/bots/bot-mode.js";
import { KernelDaemon } from "../daemon/kernel/KernelDaemon.js";
import { ProjectDaemon } from "../daemon/project/ProjectDaemon.js";
import { readProjectAuthorization } from "../daemon/session/project-authorization.js";
import type { SessionDaemon } from "../daemon/session/SessionDaemon.js";

const TIMEOUT = 8_000;

async function open(): Promise<{ session: SessionDaemon; kernel: KernelDaemon; project: ProjectDaemon; path: string }> {
  const kernel = new KernelDaemon(await realpath(await mkdtemp(join(tmpdir(), "harness-pol-k-"))));
  await kernel.ready;
  const path = await realpath(await mkdtemp(join(tmpdir(), "harness-pol-p-")));
  const project = new ProjectDaemon(kernel, path);
  await project.ready;
  const session = await project.session("s1");
  onTestFinished(() => {
    session[Symbol.dispose]();
    project[Symbol.dispose]();
    kernel[Symbol.dispose]();
  });
  return { session, kernel, project, path };
}

function ask(session: SessionDaemon, command: string, id = "c1"): SystemToolJob {
  const job = new SystemToolJob({ toolCallId: id, name: "shell", argsJson: JSON.stringify({ command }) });
  session.root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [job] });
  return job;
}

describe("policy v2 over the daemon", () => {
  beforeEach(() => resetLocalIDs());

  it("policy/explain answers tier, class, resolver and outcome without running anything", async () => {
    const { session } = await open();
    const publish = (await session.handleRequest("policy/explain", {
      probe: { kind: "shell", command: "npm publish" },
    })) as {
      tier: string;
      outcome: string;
      classes: Array<{ id: string }>;
      resolver: { kind: string; layer: string } | null;
      grantable: unknown[];
    };
    expect(publish).toMatchObject({
      tier: "soft-deny",
      outcome: "prompts-you",
      resolver: { kind: "human", layer: "dist" },
      grantable: [],
    });
    expect(publish.classes.map((c) => c.id)).toEqual(["publish"]);
    const auto = await session.handleRequest("policy/explain", {
      probe: { kind: "shell", command: "npm publish" },
      mode: "auto",
    });
    expect(auto).toMatchObject({ outcome: "judge-soft-deny" });
    const unattended = await session.handleRequest("policy/explain", {
      probe: { kind: "shell", command: "make deploy" },
      mode: "auto",
      unattended: true,
    });
    expect(unattended).toMatchObject({ tier: "ask", outcome: "judge-ask" });
    const blocked = await session.handleRequest("policy/explain", {
      probe: { kind: "shell", command: "cat .e{nv,x}" },
      mode: "yolo",
    });
    expect(blocked).toMatchObject({ tier: "block", outcome: "blocked", resolver: null });
  });

  it("explain matches the real leaf: block, soft-deny and ask each end where explain said", async () => {
    const { session } = await open();
    const job = ask(session, "make deploy");
    await when(() => job.policyResult !== null, { timeout: TIMEOUT });
    const explained = (await session.handleRequest("policy/explain", {
      probe: { kind: "shell", command: "make deploy" },
    })) as {
      tier: string;
      outcome: string;
      grantable: unknown[];
    };
    expect(explained).toMatchObject({ tier: "ask", outcome: "prompts-you" });
    expect(job.needsHuman).toBe(true);
    expect(explained.grantable).toEqual(job.grantOptions.map((option) => option.subject));
  });

  it("ask/answer with store keeps a session grant that covers the next ask, and revoke re-asks", async () => {
    const { session, kernel } = await open();
    const first = ask(session, "make deploy", "m1");
    await when(() => first.policyResult === "ask", { timeout: TIMEOUT });
    const subject = first.grantOptions[0]!.subject;
    const answered = await session.handleRequest("ask/answer", {
      sessionId: "s1",
      jobId: first.uuid,
      allow: true,
      store: { scope: "session", subject },
    });
    expect(answered).toMatchObject({
      ok: true,
      grant: { scope: "session", scopeKey: "s1", expiresAtMs: null, source: "prompt" },
    });
    const grant = (answered as { grant: { id: string } }).grant;
    expect(parseGrantRows(session.root.grantsJson).map((row) => row.id)).toEqual([grant.id]);
    // the next ask of the same family is covered at floor time
    const second = ask(session, "make deploy --dry-run", "m2");
    await when(() => second.policyResult === "ask", { timeout: TIMEOUT });
    expect([second.grantedBy, second.licenseDecision]).toEqual([grant.id, true]);
    // a different family and a lifted ask are not covered; they wait for a person
    const other = ask(session, "make test", "m3");
    await when(() => other.policyResult === "ask", { timeout: TIMEOUT });
    expect([other.grantedBy, other.needsHuman]).toEqual([null, true]);
    const lifted = ask(session, "FOO=1 make deploy", "m4");
    await when(() => lifted.policyResult === "ask", { timeout: TIMEOUT });
    expect([lifted.grantedBy, lifted.needsHuman]).toEqual([null, true]);
    // revoke: the family is asked again
    await expect(session.handleRequest("grant/revoke", { id: grant.id })).resolves.toEqual({ ok: true });
    expect(session.root.grantsJson).toBe("[]");
    const again = ask(session, "make deploy", "m5");
    await when(() => again.policyResult === "ask", { timeout: TIMEOUT });
    expect([again.grantedBy, again.needsHuman]).toEqual([null, true]);
    void kernel;
  });

  it("ask/answer refuses to store a soft-deny, a subject it did not offer, and an answer to a block", async () => {
    const { session } = await open();
    const soft = ask(session, "npm publish", "p1");
    await when(() => soft.policyResult === "deny", { timeout: TIMEOUT });
    const subject = { kind: "command", argv0: "npm", spine: ["publish"], args: [] } as const;
    await expect(
      session.handleRequest("ask/answer", {
        sessionId: "s1",
        jobId: soft.uuid,
        allow: true,
        store: { scope: "session", subject },
      }),
    ).resolves.toEqual({ ok: false, reason: "soft-deny-not-storable" });
    expect(soft.humanApprove).toBeNull();
    // allow once is fine and stores nothing
    await expect(
      session.handleRequest("ask/answer", { sessionId: "s1", jobId: soft.uuid, allow: true }),
    ).resolves.toEqual({ ok: true });
    expect([soft.humanApprove, session.root.grantsJson]).toEqual([true, ""]);

    const asked = ask(session, "make deploy", "p2");
    await when(() => asked.policyResult === "ask", { timeout: TIMEOUT });
    await expect(
      session.handleRequest("ask/answer", {
        sessionId: "s1",
        jobId: asked.uuid,
        allow: true,
        store: { scope: "session", subject: { kind: "command", argv0: "make", spine: [], args: [] } },
      }),
    ).resolves.toEqual({ ok: false, reason: "subject-not-offered" });

    // a block is never an approval head: there is nothing live to answer
    const blocked = ask(session, "cat .env", "p3");
    await when(() => blocked.policyResult === "block", { timeout: TIMEOUT });
    await expect(
      session.handleRequest("ask/answer", { sessionId: "s1", jobId: blocked.uuid, allow: true }),
    ).resolves.toEqual({
      ok: false,
      reason: "not-pending",
    });
    expect([blocked.humanApprove, blocked.licenseDecision]).toEqual([null, false]);
  });

  it("a project or global store goes to the kernel file with the seven-day default; a session one does not expire", async () => {
    const { session, kernel } = await open();
    const asked = ask(session, "make deploy", "g1");
    await when(() => asked.policyResult === "ask", { timeout: TIMEOUT });
    const subject = asked.grantOptions[0]!.subject;
    const before = Date.now();
    const answered = (await session.handleRequest("ask/answer", {
      sessionId: "s1",
      jobId: asked.uuid,
      allow: true,
      store: { scope: "project", subject },
    })) as { ok: true; grant: { expiresAtMs: number; scope: string; scopeKey: string } };
    expect(answered.grant.scope).toBe("project");
    expect(answered.grant.scopeKey).toBe(session.root.path);
    expect(answered.grant.expiresAtMs).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
    expect(answered.grant.expiresAtMs).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    expect(kernel.persistentGrants()).toHaveLength(1);
    // another session of the same project sees it; the grant file survives a re-reflect
    const next = ask(session, "make deploy", "g2");
    await when(() => next.policyResult === "ask", { timeout: TIMEOUT });
    expect(next.grantedBy).toBe((answered.grant as unknown as { id: string }).id);
  });

  it("the user config sets the prompt TTL", async () => {
    const { session, kernel } = await open();
    kernel.adjustConfig((config) => {
      config.authorization = { grants: { promptTtl: { global: "1h" } } };
    });
    await when(() => session.root.authorizationUserJson !== "", { timeout: TIMEOUT });
    const asked = ask(session, "make deploy", "t1");
    await when(() => asked.policyResult === "ask", { timeout: TIMEOUT });
    const answered = (await session.handleRequest("ask/answer", {
      sessionId: "s1",
      jobId: asked.uuid,
      allow: true,
      store: { scope: "global", subject: asked.grantOptions[0]!.subject, ttlMs: undefined },
    })) as { grant: { createdAtMs: number; expiresAtMs: number } };
    expect(answered.grant.expiresAtMs - answered.grant.createdAtMs).toBe(3_600_000);
  });

  it("the session overlay loosens by human RPC and the project file caps it", async () => {
    const { session, path } = await open();
    const probe = { probe: { kind: "shell", command: "make deploy" } } as const;
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({ outcome: "prompts-you" });
    await expect(
      session.handleRequest("policy/overlay", { overlay: { manual: { default: "allow" } } }),
    ).resolves.toEqual({
      ok: true,
      errors: [],
    });
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({
      outcome: "runs",
      resolver: { kind: "allow", layer: "session" },
    });
    // a layer that does not parse is refused and changes nothing
    const bad = (await session.handleRequest("policy/overlay", { overlay: { manual: { risky: "allow" } } })) as {
      ok: boolean;
      errors: string[];
    };
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({ outcome: "runs" });
    // the project file can only tighten, and it caps the overlay
    await mkdir(join(path, ".inhuman"), { recursive: true });
    await writeFile(
      join(path, ".inhuman", "authorization.json"),
      JSON.stringify({ manual: { classes: { "exec-unknown": "deny" } } }),
    );
    runInAction(() => {
      session.root.authorizationProjectJson = readProjectAuthorization(path);
    });
    await expect(session.handleRequest("policy/explain", probe)).resolves.toMatchObject({
      outcome: "denied",
      resolver: { kind: "deny", layer: "project" },
    });
    await expect(session.handleRequest("policy/overlay", { overlay: null })).resolves.toEqual({ ok: true, errors: [] });
    expect(session.root.authorizationOverlayJson).toBe("");
    const config = (await session.handleRequest("policy/config-get", {})) as {
      layers: { project: string };
      warnings: string[];
    };
    expect(config.layers.project).toContain("exec-unknown");
    expect(config.warnings).toEqual([]);
  });

  it("an unparseable project file tightens every cell to a person and is reported", async () => {
    const { session, path } = await open();
    await mkdir(join(path, ".inhuman"), { recursive: true });
    await writeFile(join(path, ".inhuman", "authorization.json"), "{ not json");
    runInAction(() => {
      session.root.authorizationProjectJson = readProjectAuthorization(path);
      session.root.replaceAuthorizationOverlay(JSON.stringify({ manual: { default: "allow" } }));
    });
    await expect(
      session.handleRequest("policy/explain", { probe: { kind: "shell", command: "make deploy" } }),
    ).resolves.toMatchObject({ outcome: "prompts-you", resolver: { kind: "human", layer: "project" } });
    const config = (await session.handleRequest("policy/config-get", {})) as { warnings: string[] };
    expect(config.warnings.join(" ")).toContain("project layer");
  });

  it("the project file reader: missing is none, unreadable is a tightening", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-pol-file-"));
    expect(readProjectAuthorization(dir)).toBe("");
    await mkdir(join(dir, ".inhuman", "authorization.json"), { recursive: true });
    expect(readProjectAuthorization(dir)).toBe("\0unreadable");
  });

  it("a bot runs in the kernel default mode unless the user pinned one for it", () => {
    const kernel = { defaultPermissionMode: "auto", authorizationJson: "" } as const;
    expect(botPermissionMode(kernel, "helper")).toBe("auto");
    const pinned = {
      defaultPermissionMode: "manual",
      authorizationJson: JSON.stringify({ botModes: { helper: "yolo" } }),
    } as const;
    expect(botPermissionMode(pinned, "helper")).toBe("yolo");
    expect(botPermissionMode(pinned, "other")).toBe("manual");
    // a layer that does not parse pins nothing
    expect(botPermissionMode({ defaultPermissionMode: "manual", authorizationJson: "{ nope" }, "helper")).toBe(
      "manual",
    );
  });
});
