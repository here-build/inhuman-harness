import { describe, expect, it } from "vitest";

import {
  ackOptionsFor,
  activeAcks,
  collectAckFlags,
  matchAckFlags,
  resolveAcks,
  type AckCall,
} from "../acks.js";
import { parseAuthorizationConfig, type AuthorizationConfig } from "../config.js";
import type { GrantRow } from "../grants.js";
import { layersOf } from "../layers.js";

const parse = (value: unknown): AuthorizationConfig => {
  const parsed = parseAuthorizationConfig(value);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.config;
};
const MAIL = { mcp: "gmail", tool: "send_email" } as const;
const call: AckCall = {
  classes: ["mcp-action"],
  mcp: { server: "gmail", account: "work", tool: "send_email" },
  tool: "mcp__gmail__send_email",
  units: [{ argv0: "git", spine: ["push"], familyArgs: ["origin"] }],
};
const row = (subject: GrantRow["subject"], id = "a1"): GrantRow => ({
  id,
  kind: "ack",
  scope: "project",
  scopeKey: "/p",
  subject,
  createdAtMs: 0,
  expiresAtMs: null,
  source: "prompt",
  label: id,
});

describe("acknowledge config", () => {
  it("parses the four match forms, why, modes and a rule's needsAcknowledgement", () => {
    const config = parse({
      acknowledge: [
        { match: { class: "publish" }, why: "ships to the world" },
        { match: MAIL, modes: ["manual", "auto"] },
        { match: { tool: "web_extract" } },
        { match: { command: ["git", "push"] } },
      ],
      rules: [{ match: { mcp: "slack" }, needsAcknowledgement: true }],
    });
    expect(config.acknowledge).toHaveLength(4);
  });

  it("refuses an unknown class, an empty command, a stray key, and an ack on a path rule", () => {
    expect(parseAuthorizationConfig({ acknowledge: [{ match: { class: "risky" } }] }).ok).toBe(false);
    expect(parseAuthorizationConfig({ acknowledge: [{ match: { command: [] } }] }).ok).toBe(false);
    expect(parseAuthorizationConfig({ acknowledge: [{ match: MAIL, tier: "ask" }] }).ok).toBe(false);
    expect(parseAuthorizationConfig({ acknowledge: [{ match: MAIL, modes: ["full"] }] }).ok).toBe(false);
    expect(
      parseAuthorizationConfig({ rules: [{ match: { path: "x", cluster: "write" }, needsAcknowledgement: true }] }).ok,
    ).toBe(false);
  });
});

describe("flags across layers", () => {
  const layers = (texts: { user?: unknown; project?: unknown; session?: unknown }) =>
    layersOf({
      user: texts.user === undefined ? "" : JSON.stringify(texts.user),
      project: texts.project === undefined ? "" : JSON.stringify(texts.project),
      session: texts.session === undefined ? "" : JSON.stringify(texts.session),
    });

  it("is a union: project adds, and its removal of a user flag does nothing", () => {
    const flags = collectAckFlags(
      layers({
        user: { acknowledge: [{ match: MAIL }] },
        project: { acknowledge: [{ match: { tool: "x" } }, { match: MAIL, remove: true }] },
      }),
    );
    expect(flags.map((flag) => [flag.layer, JSON.stringify(flag.match)])).toEqual([
      ["user", JSON.stringify(MAIL)],
      ["project", JSON.stringify({ tool: "x" })],
    ]);
  });

  it("a session (or user) removal cancels a weaker layer's identical flag, never a project flag", () => {
    const flags = collectAckFlags(
      layers({
        user: { acknowledge: [{ match: MAIL }] },
        session: { acknowledge: [{ match: MAIL, remove: true }] },
        project: { acknowledge: [{ match: MAIL }] },
      }),
    );
    expect(flags.map((flag) => flag.layer)).toEqual(["project"]);
    expect(collectAckFlags(layers({ user: { acknowledge: [{ match: MAIL }, { match: MAIL, remove: true }] } }))).toHaveLength(1);
  });
});

describe("matching and stored acks", () => {
  const flags = (...matches: unknown[]) =>
    collectAckFlags(layersOf({ user: JSON.stringify({ acknowledge: matches.map((match) => ({ match })) }), project: "", session: "" }));

  it("matches class, mcp (server, account, tool), tool name and a command family on the shell unit", () => {
    const matched = matchAckFlags(
      flags(
        { class: "mcp-action" },
        MAIL,
        { mcp: "gmail", account: "personal" },
        { tool: "mcp__gmail__send_email" },
        { command: ["git", "push"] },
        { command: ["git", "commit"] },
      ),
      call,
    );
    expect(matched.map((m) => m.label)).toEqual([
      "any mcp-action call",
      "gmail · send_email",
      "mcp__gmail__send_email".replace(/^/, "tool "),
      "`git push`",
    ]);
    expect(matched.at(-1)?.unit).toEqual({ argv0: "git", spine: ["push"], familyArgs: ["origin"] });
  });

  it("modes: a flag without modes prompts everywhere; one with modes only there", () => {
    const [plain, scoped] = matchAckFlags(
      collectAckFlags(
        layersOf({
          user: JSON.stringify({ acknowledge: [{ match: MAIL }, { match: { class: "mcp-action" }, modes: ["manual"] }] }),
          project: "",
          session: "",
        }),
      ),
      call,
    );
    expect([activeAcks([plain!, scoped!], "yolo").length, activeAcks([plain!, scoped!], "manual").length]).toEqual([1, 2]);
  });

  it("a stored ack satisfies a flag when it covers the call and is no broader than the flag", () => {
    const [flag] = matchAckFlags(flags(MAIL), call);
    const [broad] = matchAckFlags(flags({ mcp: "gmail" }), call);
    const exact = row({ kind: "mcp", server: "gmail", tool: "send_email" });
    const server = row({ kind: "mcp", server: "gmail" }, "a2");
    const otherAccount = row({ kind: "mcp", server: "gmail", account: "personal", tool: "send_email" }, "a3");
    const grantRow: GrantRow = { ...exact, kind: "grant", id: "g1" };
    expect(resolveAcks([flag!], [exact], call)).toEqual({ state: "satisfied", ackedBy: ["a1"] });
    expect(resolveAcks([flag!], [server], call).state).toBe("pending");
    expect(resolveAcks([broad!], [server], call).state).toBe("satisfied");
    expect(resolveAcks([broad!], [exact], call).state).toBe("satisfied");
    expect(resolveAcks([flag!], [otherAccount], call).state).toBe("pending");
    expect(resolveAcks([flag!], [grantRow], call).state).toBe("pending");
    expect(resolveAcks([], [], call).state).toBe("none");
  });

  it("offers the flag's own subject and a narrower one for this call", () => {
    const active = matchAckFlags(flags({ mcp: "gmail" }, { command: ["git"] }), call);
    const options = ackOptionsFor(active, call).map((option) => option.subject);
    expect(options).toContainEqual({ kind: "mcp", server: "gmail" });
    expect(options).toContainEqual({ kind: "mcp", server: "gmail", account: "work", tool: "send_email" });
    expect(options).toContainEqual({ kind: "command", argv0: "git", spine: [], args: [] });
    expect(options).toContainEqual({ kind: "command", argv0: "git", spine: ["push"], args: ["origin"] });
  });
});
