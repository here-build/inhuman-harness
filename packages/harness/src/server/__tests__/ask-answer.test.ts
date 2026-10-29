/**
 * A human answer, applied: a block is never lifted, a soft-deny is never stored, an ask is stored only
 * as an offered family, a comment stores nothing, a folder is a session read root.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  type GrantRow,
  parseGrantRows,
  SessionRoot,
  SessionSystemPrompt,
  SessionTurn,
  SystemToolJob,
} from "@inhuman.tools/harness-model";
import { beforeEach, describe, expect, it } from "vitest";

import { applyAskAnswer, type AnswerEnv } from "../ask-answer.js";

const votes = (tier: "ask" | "deny", path = "src/a.ts") =>
  JSON.stringify([{ disposition: tier, class: "workspace-write", ruleId: "w", path: { cluster: "write", path } }]);

function home(tier: "ask" | "deny" | "block", name = "write_file", args: object = { path: "src/a.ts", content: "x" }) {
  const root = new SessionRoot({ sessionId: "s", path: "/w/proj" });
  const plexus = Plexus.bootstrap(root);
  const leaf = new SystemToolJob({ toolCallId: "c", name, argsJson: JSON.stringify(args) });
  root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`go`, queue: [leaf] });
  leaf.stampPolicy(tier, null, null, {
    classesJson: '["workspace-write"]',
    votesJson: tier === "block" ? "[]" : votes(tier),
  });
  return { root, leaf, [Symbol.dispose]: () => plexus.destroy() };
}

const persisted: GrantRow[] = [];
const env: AnswerEnv = {
  now: () => 1_000,
  newId: () => `g${persisted.length + 1}`,
  persist: (row) => persisted.push(row),
  bot: "helper",
};
const subject = { kind: "path", cluster: "write", path: "src/a.ts", depth: "exact" } as const;

describe("applyAskAnswer", () => {
  beforeEach(() => {
    resetLocalIDs();
    persisted.length = 0;
  });

  it("a block is never lifted, by allow or by store", () => {
    using h = home("block");
    expect(applyAskAnswer(h.root, h.leaf, { allow: true }, env)).toEqual({ ok: false, reason: "block" });
    expect(applyAskAnswer(h.root, h.leaf, { allow: true, store: { scope: "session", subject } }, env)).toEqual({
      ok: false,
      reason: "block",
    });
    expect([h.leaf.humanApprove, h.leaf.licenseDecision, h.root.grantsJson]).toEqual([null, false, ""]);
  });

  it("a soft-deny can be allowed once and never stored", () => {
    using h = home("deny");
    expect(applyAskAnswer(h.root, h.leaf, { allow: true, store: { scope: "session", subject } }, env)).toEqual({
      ok: false,
      reason: "soft-deny-not-storable",
    });
    expect(h.leaf.humanApprove).toBeNull();
    expect(applyAskAnswer(h.root, h.leaf, { allow: true }, env)).toEqual({ ok: true });
    expect([h.leaf.humanApprove, h.root.grantsJson, persisted]).toEqual([true, "", []]);
  });

  it("an ask is stored as an offered family with the scope's TTL", () => {
    for (const [scope, key, ttl] of [
      ["session", "s", null],
      ["project", "/w/proj", 7 * 86_400_000],
      ["bot", "helper", 7 * 86_400_000],
      ["global", "", 7 * 86_400_000],
    ] as const) {
      using h = home("ask");
      const result = applyAskAnswer(h.root, h.leaf, { allow: true, store: { scope, subject } }, env);
      expect(result).toMatchObject({ ok: true, grant: { scope, scopeKey: key, source: "prompt", createdAtMs: 1_000 } });
      expect((result as { grant: GrantRow }).grant.expiresAtMs).toBe(ttl === null ? null : 1_000 + ttl);
      expect(h.leaf.humanApprove).toBe(true);
      expect(parseGrantRows(h.root.grantsJson)).toHaveLength(scope === "session" ? 1 : 0);
    }
    expect(persisted.map((row) => row.scope)).toEqual(["project", "bot", "global"]);
  });

  it("the configured TTL wins; an explicit null is no expiry; an explicit number is that long", () => {
    using a = home("ask");
    const configured = applyAskAnswer(
      a.root,
      a.leaf,
      { allow: true, store: { scope: "global", subject } },
      { ...env, promptTtl: { global: "2h" } },
    );
    expect((configured as { grant: GrantRow }).grant.expiresAtMs).toBe(1_000 + 7_200_000);
    using b = home("ask");
    const never = applyAskAnswer(
      b.root,
      b.leaf,
      { allow: true, store: { scope: "global", subject, ttlMs: null } },
      env,
    );
    expect((never as { grant: GrantRow }).grant.expiresAtMs).toBeNull();
    using c = home("ask");
    const short = applyAskAnswer(
      c.root,
      c.leaf,
      { allow: true, store: { scope: "project", subject, ttlMs: 60_000 } },
      env,
    );
    expect((short as { grant: GrantRow }).grant.expiresAtMs).toBe(61_000);
  });

  it("a subject the daemon did not offer, or a scope it cannot hold, stores nothing and answers nothing", () => {
    using h = home("ask");
    expect(
      applyAskAnswer(
        h.root,
        h.leaf,
        { allow: true, store: { scope: "session", subject: { ...subject, path: "src/other.ts" } } },
        env,
      ),
    ).toEqual({ ok: false, reason: "subject-not-offered" });
    expect(
      applyAskAnswer(
        h.root,
        h.leaf,
        { allow: true, store: { scope: "session", subject: { ...subject, depth: "subtree" } } },
        env,
      ),
    ).toEqual({ ok: false, reason: "subject-not-offered" });
    expect(
      applyAskAnswer(
        h.root,
        h.leaf,
        { allow: true, store: { scope: "project", subject } },
        { now: env.now, newId: env.newId },
      ),
    ).toEqual({
      ok: false,
      reason: "scope-unavailable",
    });
    expect(
      applyAskAnswer(h.root, h.leaf, { allow: true, store: { scope: "bot", subject } }, { ...env, bot: undefined }),
    ).toEqual({
      ok: false,
      reason: "scope-unavailable",
    });
    expect([h.leaf.humanApprove, h.root.grantsJson]).toEqual([null, ""]);
  });

  it("a refusal and a comment store nothing", () => {
    using refused = home("ask");
    expect(
      applyAskAnswer(refused.root, refused.leaf, { allow: false, store: { scope: "session", subject } }, env),
    ).toEqual({ ok: true });
    expect([refused.leaf.humanApprove, refused.root.grantsJson]).toEqual([false, ""]);
    using commented = home("ask");
    expect(
      applyAskAnswer(
        commented.root,
        commented.leaf,
        { allow: true, comment: "because", store: { scope: "session", subject } },
        env,
      ),
    ).toEqual({ ok: true });
    expect([commented.leaf.humanApprove, commented.leaf.approvalComment, commented.root.grantsJson]).toEqual([
      true,
      "because",
      "",
    ]);
  });

  it("widen says yes to the folder question: a session root, only for a deep absolute folder, never with a comment", () => {
    using ok = home("deny", "read_file", { path: "/opt/shared/a.txt" });
    expect(applyAskAnswer(ok.root, ok.leaf, { allow: true, widen: "/opt/shared" }, env)).toEqual({ ok: true });
    expect(Object.keys(ok.root.readRoots)).toEqual(["/opt/shared"]);
    using fenced = home("deny", "read_file", { path: "/etc/hosts" });
    expect(applyAskAnswer(fenced.root, fenced.leaf, { allow: true, widen: "/etc" }, env)).toEqual({
      ok: false,
      reason: "folder-not-allowed",
    });
    expect(fenced.leaf.humanApprove).toBeNull();
    using commented = home("deny", "read_file", { path: "/opt/shared/a.txt" });
    applyAskAnswer(commented.root, commented.leaf, { allow: true, widen: "/opt/shared", comment: "ok" }, env);
    expect(Object.keys(commented.root.readRoots)).toEqual([]);
    using refused = home("deny", "read_file", { path: "/opt/shared/a.txt" });
    applyAskAnswer(refused.root, refused.leaf, { allow: false, widen: "/opt/shared" }, env);
    expect(Object.keys(refused.root.readRoots)).toEqual([]);
  });
});
