/**
 * Permission mode is SessionRoot.permissionMode. needsHuman is the cover predicate, not a license bit.
 * evalSpec is admission, not a per-leaf mode. What licenses a soft-deny or an ask is the resolution
 * table; a block is checked before any human answer; a grant only ever turns an ask into allow.
 */
import { Plexus, resetLocalIDs } from "@here.build/plexus";
import { prompt } from "@inhuman.tools/harness-commons";
import { beforeEach, describe, expect, it } from "vitest";

import { McpToolExpectation } from "../expectations/McpToolExpectation.js";
import { AgentCallbackJob } from "../jobs/AgentCallbackJob.js";
import { AgentCallJob } from "../jobs/AgentCallJob.js";
import { AgentMessageJob } from "../jobs/AgentMessageJob.js";
import { AgentNotifyJob } from "../jobs/AgentNotifyJob.js";
import type { ApprovableJob } from "../jobs/ApprovableJob.js";
import { MCPToolJob } from "../jobs/MCPToolJob.js";
import { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import { SystemToolJob } from "../jobs/SystemToolJob.js";
import { SessionRoot } from "../SessionRoot.js";
import { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import { SessionTurnEvalSpec } from "../turn/eval-spec.js";
import { SessionTurn } from "../turn/session-turn.js";

beforeEach(() => resetLocalIDs());

type Mode = "manual" | "auto" | "yolo";
type Vote = "policyApprove" | "ask" | "deny" | "block";

type Oracle = {
  readonly comm: boolean;
  readonly cover: boolean;
  readonly decision: boolean | null;
  readonly code: string | null;
  readonly pending: boolean;
};

function snap(leaf: ApprovableJob): Oracle {
  return {
    comm: leaf.commFirst,
    cover: leaf.needsHuman,
    decision: leaf.licenseDecision,
    code: leaf.licenseDetail.code,
    pending: leaf.autoClassifierPending,
  };
}

function home(opts: {
  readonly mode?: Mode;
  readonly kind?: "system" | "mcp";
  readonly name?: string;
  readonly args?: Record<string, unknown>;
  readonly serverToolName?: string;
  readonly unattended?: boolean;
  readonly user?: unknown;
  readonly project?: string;
  readonly overlay?: unknown;
}): {
  readonly root: SessionRoot;
  readonly leaf: ApprovableJob;
  [Symbol.dispose](): void;
} {
  const root = new SessionRoot({
    sessionId: "s-lic",
    path: "/tmp/lic",
    standingPermissionMode: opts.mode ?? "manual",
    authorizationUserJson: opts.user === undefined ? "" : JSON.stringify(opts.user),
    authorizationProjectJson: opts.project ?? "",
    authorizationOverlayJson: opts.overlay === undefined ? "" : JSON.stringify(opts.overlay),
  });
  const plexus = Plexus.bootstrap(root);
  const leaf =
    opts.kind === "mcp"
      ? new MCPToolJob({
          name: opts.name ?? "mcp__mail__search",
          connectionKey: "mail",
          serverToolName: opts.serverToolName ?? "get_issue",
          argsJson: JSON.stringify(opts.args ?? {}),
          expectation: new McpToolExpectation({
            connectionId: "mail",
            serverToolName: opts.serverToolName ?? "get_issue",
            argsJson: JSON.stringify(opts.args ?? {}),
          }),
        })
      : new SystemToolJob({
          name: opts.name ?? "shell",
          argsJson: JSON.stringify(opts.args ?? {}),
        });
  const turn = new SessionTurn({
    turnTail: new SessionSystemPrompt(),
    prompt: prompt.user`hi`,
    ...(opts.unattended
      ? {
          evalSpec: new SessionTurnEvalSpec({
            requestId: "req-u",
            permissionMode: opts.mode === "yolo" ? "yolo" : "auto",
          }),
          permissionMode: opts.mode === "yolo" ? "yolo" : "auto",
        }
      : {}),
    queue: [leaf],
  });
  root.head = turn;
  return {
    root,
    leaf,
    [Symbol.dispose]() {
      plexus.destroy();
    },
  };
}

/** Stamp the floor vote the way the scope does. */
function vote(leaf: ApprovableJob, tier: Vote, classes: string[] = [], votes: object[] = []): void {
  leaf.stampPolicy(tier, null, null, {
    classesJson: JSON.stringify(classes),
    votesJson: JSON.stringify(votes.map((v) => ({ disposition: tier, ...v }))),
  });
}

const unit = (argv0: string, spine: string[] = [], familyArgs: string[] = []) => ({
  unit: { argv0, spine, familyArgs },
});

describe("permissionMode overlay", () => {
  it("join follows live-head overlay; unclosed eval stays in work", () => {
    const overlayRoot = new SessionRoot({ sessionId: "s-eval", path: "/tmp/eval" });
    const overlayPlexus = Plexus.bootstrap(overlayRoot);
    const inner = new SystemToolJob({ name: "shell" });
    const program = new ProgrammaticJob({ toolCallId: "program" });
    program.pushInvocation(inner);
    const evalTurn = new SessionTurn({
      turnTail: new SessionSystemPrompt(),
      evalSpec: new SessionTurnEvalSpec({ requestId: "req-owned", permissionMode: "auto" }),
      permissionMode: "auto",
      queue: [program],
      reducerExited: true,
    });
    overlayRoot.head = evalTurn;
    vote(inner, "ask", ["exec-unknown"]);
    const owned = inner.licenseDecision;
    overlayRoot.head = new SessionTurn({ turnTail: evalTurn, prompt: prompt.user`follow-up`, queue: [] });
    overlayRoot.permissionMode = "yolo";
    expect({ owned, policy: overlayRoot.permissionMode, allows: inner.licenseDecision }).toEqual({
      owned: null,
      policy: "yolo",
      allows: true,
    });
    overlayPlexus.destroy();
  });
});

describe("LICENSE WHEN", () => {
  it("spawn, deliver, callback, and notify never cover, even with a leftover vote", () => {
    const root = new SessionRoot({ sessionId: "s-spawn", path: "/tmp/spawn", standingPermissionMode: "manual" });
    const plexus = Plexus.bootstrap(root);
    const leaves = [
      new AgentCallJob({ name: "agent__send", argsJson: '{"spec":"echo","message":"hi"}' }),
      new AgentMessageJob({ name: "agent__message", argsJson: '{"targetName":"echo","message":"hi"}' }),
      new AgentCallbackJob({ name: "agent__respond" }),
      new AgentNotifyJob({ name: "agent__notify" }),
    ];
    for (const leaf of leaves) vote(leaf, "ask");
    root.head = new SessionTurn({ turnTail: new SessionSystemPrompt(), prompt: prompt.user`hi`, queue: leaves });
    for (const tier of ["ask", "block"] as const) {
      for (const leaf of leaves) vote(leaf, tier);
      for (const leaf of leaves) expect(snap(leaf)).toMatchObject({ comm: true, cover: false, decision: true });
    }
    plexus.destroy();
  });

  it("a pending floor waits; approve allows; in-flight fuses", () => {
    using h = home({});
    expect(snap(h.leaf)).toMatchObject({ decision: null, cover: false, pending: false });
    expect(h.leaf.tapeFuse).toBe(true);
    vote(h.leaf, "policyApprove");
    expect(h.leaf.licenseDecision).toBe(true);
  });

  it.each([
    // [mode, tier, expected cover/decision before any answer]
    ["manual", "ask", { cover: true, decision: null }],
    ["manual", "deny", { cover: true, decision: null }],
    ["auto", "ask", { cover: false, decision: null, pending: true }],
    ["auto", "deny", { cover: false, decision: null, pending: true }],
    ["yolo", "ask", { cover: false, decision: true }],
    ["yolo", "deny", { cover: false, decision: true }],
  ] as const)("%s %s without an answer", (mode, tier, want) => {
    using h = home({ mode });
    vote(h.leaf, tier, ["publish"]);
    expect(snap(h.leaf)).toMatchObject(want);
  });

  it("block denies in every mode, with a judge allow, and before a human allow (I1)", () => {
    for (const mode of ["manual", "auto", "yolo"] as const) {
      using h = home({ mode });
      vote(h.leaf, "block", ["credential"]);
      expect(h.leaf.licenseDecision).toBe(false);
      h.leaf.classifierResult = "allow";
      expect(h.leaf.licenseDecision).toBe(false);
      h.leaf.humanApprove = true;
      expect(h.leaf.licenseDecision).toBe(false);
      expect(h.leaf.needsHuman).toBe(false);
    }
  });

  it("a human answer waits for the floor, then allows; a refusal denies without a code", () => {
    using h = home({});
    h.leaf.humanApprove = true;
    expect(h.leaf.licenseDecision).toBeNull();
    vote(h.leaf, "deny", ["privilege"]);
    expect(h.leaf.licenseDecision).toBe(true);
    using r = home({ mode: "yolo" });
    vote(r.leaf, "ask");
    r.leaf.humanApprove = false;
    expect(snap(r.leaf)).toMatchObject({ decision: false, code: null });
  });

  it("completed and cancelled leaves are not the cover's", () => {
    using h = home({});
    vote(h.leaf, "ask");
    h.leaf.cancelled = true;
    expect(h.leaf.needsHuman).toBe(false);
  });
});

describe("auto: the judges", () => {
  it("the ask judge: allow licenses; deny is final; failure falls to a person", () => {
    using h = home({ mode: "auto" });
    vote(h.leaf, "ask", ["exec-unknown"]);
    expect(snap(h.leaf)).toMatchObject({ pending: true, cover: false, decision: null });
    h.leaf.classifierAbstain = "no connection";
    expect(snap(h.leaf)).toMatchObject({ pending: true, cover: true, decision: null });
    h.leaf.classifierResult = "deny";
    expect(snap(h.leaf)).toMatchObject({ pending: false, cover: false, decision: false, code: "policy_denied" });
    h.leaf.classifierResult = "allow";
    expect(h.leaf.licenseDecision).toBe(true);
  });
  it("the soft-deny judge: deny goes to a person; a person can still allow", () => {
    using h = home({ mode: "auto" });
    vote(h.leaf, "deny", ["publish"]);
    expect(h.leaf.judgeKind).toBe("soft-deny");
    h.leaf.classifierResult = "deny";
    expect(snap(h.leaf)).toMatchObject({ cover: true, decision: null });
    h.leaf.humanApprove = true;
    expect(h.leaf.licenseDecision).toBe(true);
  });
  it("credential and control-plane soft-denies go to the judge like any other", () => {
    for (const cls of ["credential", "control-plane"]) {
      using h = home({ mode: "auto" });
      vote(h.leaf, "deny", [cls]);
      expect(h.leaf.judgeKind).toBe("soft-deny");
      expect(h.leaf.autoClassifierPending).toBe(true);
    }
  });
  it("in-workspace writes in auto go to the ask judge", () => {
    using h = home({ mode: "auto", name: "write_file", args: { path: "src/a.ts", content: "x" } });
    vote(h.leaf, "ask", ["workspace-write"], [{ path: { cluster: "write", path: "src/a.ts" } }]);
    expect(h.leaf.judgeKind).toBe("ask");
    expect(h.leaf.autoClassifierPending).toBe(true);
  });
  it("a cell with onFail deny denies after the judge fails for good", () => {
    using h = home({ mode: "auto", user: { auto: { preset: "full" } } });
    vote(h.leaf, "deny", ["publish"]);
    expect(snap(h.leaf)).toMatchObject({ pending: true, decision: null });
    h.leaf.judgeFails = 1;
    expect(h.leaf.licenseDecision).toBeNull();
    h.leaf.judgeFails = 2;
    expect(snap(h.leaf)).toMatchObject({ pending: false, decision: false, code: "policy_denied" });
  });
  it("full-auto never shows a person: a judge deny denies", () => {
    using h = home({ mode: "auto", user: { auto: { preset: "full" } } });
    vote(h.leaf, "deny", ["credential"]);
    h.leaf.classifierResult = "deny";
    expect(snap(h.leaf)).toMatchObject({ cover: false, decision: false });
  });
});

describe("unattended", () => {
  it("whatever needs a person is denied as interaction_required", () => {
    using h = home({ mode: "auto", unattended: true });
    vote(h.leaf, "deny", ["publish"]);
    expect(snap(h.leaf)).toMatchObject({ cover: false, decision: null, pending: true });
    h.leaf.classifierResult = "deny"; // the soft-deny judge said no; onDeny human has no human to go to
    expect(snap(h.leaf)).toMatchObject({ decision: false, code: "interaction_required", cover: false });
  });
  it("a failing judge denies after one retry, as interaction_required", () => {
    using h = home({ mode: "auto", unattended: true });
    vote(h.leaf, "ask", ["exec-unknown"]);
    h.leaf.classifierAbstain = "boom";
    h.leaf.judgeFails = 1;
    expect(h.leaf.licenseDecision).toBeNull();
    h.leaf.judgeFails = 2;
    expect(snap(h.leaf)).toMatchObject({ decision: false, code: "interaction_required", pending: false, cover: false });
  });
  it("the ask judge's deny is a policy denial, not a missing person", () => {
    using h = home({ mode: "auto", unattended: true });
    vote(h.leaf, "ask", ["exec-unknown"]);
    h.leaf.classifierResult = "deny";
    expect(snap(h.leaf)).toMatchObject({ decision: false, code: "policy_denied" });
  });
  it("a manual-table cell is denied outright", () => {
    using h = home({ mode: "auto", unattended: true, user: { unattended: { default: "human" } } });
    vote(h.leaf, "ask", ["network-egress"]);
    expect(snap(h.leaf)).toMatchObject({ decision: false, code: "interaction_required" });
  });
  it("yolo runs soft-deny", () => {
    using h = home({ mode: "yolo", unattended: true });
    vote(h.leaf, "deny", ["publish"]);
    expect(h.leaf.licenseDecision).toBe(true);
  });
});

describe("grants (I2)", () => {
  it("a grant turns an ask into allow in every mode but never a soft-deny or a block", () => {
    for (const mode of ["manual", "auto"] as const) {
      using h = home({ mode });
      vote(h.leaf, "ask", ["remote-write"], [unit("git", ["push"])]);
      h.leaf.grantedBy = "g1";
      expect(snap(h.leaf)).toMatchObject({ decision: true, cover: false, pending: false });
    }
    for (const tier of ["deny", "block"] as const) {
      using h = home({ mode: "manual" });
      vote(h.leaf, tier, ["publish"]);
      h.leaf.grantedBy = "g1";
      expect(h.leaf.licenseDecision).toBe(tier === "deny" ? null : false);
      expect(h.leaf.needsHuman).toBe(tier === "deny");
    }
  });
  it("a stamped grant on a soft-deny is ignored even if the daemon wrongly set it", () => {
    using h = home({ mode: "auto" });
    vote(h.leaf, "deny", ["publish"]);
    h.leaf.grantedBy = "g1";
    expect(h.leaf.grantCovers).toBe(false);
    expect(h.leaf.autoClassifierPending).toBe(true);
  });
  it("prompt options: none for soft-deny, the family for ask", () => {
    using d = home({});
    vote(d.leaf, "deny", ["publish"], [unit("npm", ["publish"])]);
    expect(d.leaf.grantOptions).toEqual([]);
    using a = home({});
    vote(a.leaf, "ask", ["exec-unknown"], [unit("make", [], ["deploy"])]);
    expect(a.leaf.grantOptions.map((o) => o.subject)).toEqual([
      { kind: "command", argv0: "make", spine: [], args: ["deploy"] },
    ]);
  });
  it("a hatch has no options and is never covered", () => {
    using h = home({ args: { command: "npx tsc" } });
    vote(h.leaf, "ask", ["exec-unknown"], [unit("npx")]);
    expect(h.leaf.hatch).toBe(true);
    expect(h.leaf.grantOptions).toEqual([]);
  });
});

describe("MCP", () => {
  it("the account is the connection id and feeds the specific rules", () => {
    using h = home({
      kind: "mcp",
      serverToolName: "send_email",
      user: {
        rules: [
          { match: { mcp: "mail", account: "mail", tool: "send_email" }, resolve: { yolo: "deny", manual: "deny" } },
        ],
      },
    });
    vote(h.leaf, "ask", ["mcp-action"]);
    expect(h.leaf.callSubject).toMatchObject({ mcp: { server: "mail", account: "mail", tool: "send_email" } });
    expect(snap(h.leaf)).toMatchObject({ decision: false, code: "policy_denied" });
  });
  it("offers the {server, account, tool} grant for an ask", () => {
    using h = home({ kind: "mcp", serverToolName: "get_issue" });
    vote(h.leaf, "ask", ["mcp-lookup"]);
    expect(h.leaf.grantOptions.map((o) => o.subject)).toEqual([
      { kind: "mcp", server: "mail", account: "mail", tool: "get_issue" },
    ]);
  });
});

describe("table from the session's layers", () => {
  it("the user layer loosens; the project layer cannot; the session overlay is capped by the project", () => {
    using user = home({ user: { manual: { classes: { publish: "allow" } } } });
    vote(user.leaf, "deny", ["publish"]);
    expect(user.leaf.licenseDecision).toBe(true);
    using project = home({ project: JSON.stringify({ manual: { default: "allow" } }) });
    vote(project.leaf, "deny", ["publish"]);
    expect(project.leaf.licenseDecision).toBeNull();
    using capped = home({
      project: JSON.stringify({ manual: { classes: { publish: "deny" } } }),
      overlay: { manual: { default: "allow" } },
    });
    vote(capped.leaf, "deny", ["publish"]);
    expect(capped.leaf.licenseDecision).toBe(false);
  });
  it("tightening mid-session applies to the next read", () => {
    using h = home({ mode: "yolo" });
    vote(h.leaf, "ask", ["publish"]);
    expect(h.leaf.licenseDecision).toBe(true);
    h.root.authorizationProjectJson = JSON.stringify({ yolo: { classes: { publish: "deny" } } });
    expect(h.leaf.licenseDecision).toBe(false);
  });
});
