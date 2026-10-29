/**
 * needsAcknowledgement: a flag, not a tier. It forces a human "yes, I know" when the verdict is allow
 * (floor approve, resolver allow, yolo, full-auto), is satisfied by a stored ack at any scope until its
 * TTL, never lifts a block or a denial, and in an unattended run denies as `interaction_required`,
 * tells the user and lets the run continue without counting it as a bypass attempt.
 */
import {
  ACKED_ONCE,
  type GrantRow,
  MCPToolJob,
  McpToolExpectation,
  refusalReasonOf,
} from "@inhuman.tools/harness-model";
import { when } from "mobx";
import { describe, expect, it } from "vitest";

import { scopes } from "../scope.js";
import { ledgerFor } from "../unattended-guard.js";
import { settled, shell, TIMEOUT } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = `{"read_file":["."],"write_file":["."],"bash":{"policy":"ask","subcommands":{"rm":"deny","ls":"approve","curl":"ask","blocked":"block"}}}`;

const email = (id = "mail-1") =>
  new MCPToolJob({
    toolCallId: id,
    name: "mcp__gmail__send_email",
    connectionKey: "gmail",
    serverToolName: "send_email",
    argsJson: JSON.stringify({ to: "boss@corp.example" }),
    expectation: new McpToolExpectation({ connectionId: "gmail", serverToolName: "send_email", argsJson: "{}" }),
  });

const MAIL_FLAG = { match: { mcp: "gmail", tool: "send_email" }, why: "emails leave the company" };
const ack = (over: Partial<GrantRow> = {}): GrantRow => ({
  id: "a1",
  kind: "ack",
  scope: "session",
  scopeKey: "s-lic",
  subject: { kind: "mcp", server: "gmail", tool: "send_email" },
  createdAtMs: 0,
  expiresAtMs: null,
  source: "prompt",
  label: "gmail · send_email",
  ...over,
});
/** Everything the table can allow is allowed, so only the flag stands in the way. */
const ALLOW_ALL = { default: { ask: "allow", "soft-deny": "allow" } } as const;

describe("an acknowledgement is forced on allow", () => {
  it("on a floor approve: the call waits for a person", async () => {
    using bag = setup({
      policy: "manual",
      policyProgram: FLOOR,
      user: { acknowledge: [{ match: { command: ["ls"] }, why: "listing is audited" }] },
    });
    const ls = shell("ls -la");
    bag.enqueue(ls);
    await when(() => ls.policyResult !== null, { timeout: TIMEOUT });
    expect({
      tier: ls.policyResult,
      ackState: ls.ackState,
      decision: ls.licenseDecision,
      needsHuman: ls.needsHuman,
      flag: ls.ackFlags.map((flag) => [flag.label, flag.why, flag.layer]),
    }).toEqual({
      tier: "policyApprove",
      ackState: "pending",
      decision: null,
      needsHuman: true,
      flag: [["`ls`", "listing is audited", "user"]],
    });
    expect(ls.orchestrated).toBe(false);
    // The person acknowledges: the call runs.
    ls.stampAck("satisfied", ACKED_ONCE);
    await settled(ls);
    expect(ls.orchestrationResult).toBe(true);
  });

  it("an unflagged call is untouched", async () => {
    using bag = setup({
      policy: "manual",
      policyProgram: FLOOR,
      user: { acknowledge: [{ match: { command: ["ls"] } }] },
    });
    const pwd = shell("ls");
    const other = shell("curl x");
    bag.enqueue(pwd);
    bag.enqueue(other);
    await when(() => other.policyResult !== null && pwd.policyResult !== null, { timeout: TIMEOUT });
    expect([other.ackState, other.ackFlags.length]).toEqual(["none", 0]);
  });

  it("on a resolver allow and a judge-free ask: the flag is the only thing left", async () => {
    using bag = setup({
      policy: "auto",
      unattended: false,
      policyProgram: FLOOR,
      user: { auto: ALLOW_ALL, acknowledge: [{ match: { command: ["curl"] } }] },
    });
    const curl = shell("curl x");
    bag.enqueue(curl);
    await when(() => curl.policyResult !== null, { timeout: TIMEOUT });
    expect([curl.policyResult, curl.ackState, curl.licenseDecision, curl.needsHuman]).toEqual([
      "ask",
      "pending",
      null,
      true,
    ]);
  });

  it("still prompts in yolo", async () => {
    using bag = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [MAIL_FLAG] } });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect([mail.ackState, mail.licenseDecision, mail.needsHuman]).toEqual(["pending", null, true]);
  });

  it("still prompts under the full-auto preset", async () => {
    using bag = setup({
      policy: "auto",
      unattended: false,
      policyProgram: FLOOR,
      user: { auto: { preset: "full", ...ALLOW_ALL }, acknowledge: [MAIL_FLAG] },
    });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect([mail.ackState, mail.licenseDecision, mail.needsHuman]).toEqual(["pending", null, true]);
  });

  it("a flag's modes filter: a flag for manual and auto does not prompt in yolo", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: { acknowledge: [{ ...MAIL_FLAG, modes: ["manual", "auto"] }] },
    });
    const mail = email();
    bag.enqueue(mail);
    await settled(mail);
    expect([mail.ackState, mail.orchestrationResult]).toEqual(["none", true]);
  });

  it("a flag on a class matches calls the floor voted that class", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: { acknowledge: [{ match: { class: "exec-unknown" } }] },
    });
    const curl = shell("curl x");
    bag.enqueue(curl);
    await when(() => curl.policyResult !== null, { timeout: TIMEOUT });
    expect([curl.policyClasses, curl.ackState]).toEqual([["exec-unknown"], "pending"]);
  });

  it("a rule's needsAcknowledgement is the same flag", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: {
        rules: [{ match: { mcp: "gmail", tool: "send_email" }, needsAcknowledgement: true, note: "send = outbound" }],
      },
    });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect([mail.ackState, mail.ackFlags[0]?.why]).toEqual(["pending", "send = outbound"]);
  });
});

describe("a stored ack suppresses the prompt at each scope, until its TTL", () => {
  const cases: Array<[string, Partial<GrantRow>, "session" | "persistent"]> = [
    ["session", {}, "session"],
    ["project", { scope: "project", scopeKey: "/tmp/lic" }, "persistent"],
    ["bot", { scope: "bot", scopeKey: "scribe" }, "persistent"],
    ["global", { scope: "global", scopeKey: "" }, "persistent"],
  ];
  for (const [name, over, where] of cases) {
    it(`${name}: satisfied while live, pending after expiry and after revoke`, async () => {
      using bag = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [MAIL_FLAG] } });
      const scope = scopes.get(bag.root);
      scope.botName = () => "scribe";
      let rows: GrantRow[] = [ack({ ...over, expiresAtMs: 100 })];
      const sync = () => {
        if (where === "session") bag.root.replaceGrantsJson(rows.length === 0 ? "" : JSON.stringify(rows));
        else scope.persistentGrants = () => rows;
        scope.reconcileGrants();
      };
      scope.now = () => 10;
      sync();
      const live = email("live");
      bag.enqueue(live);
      await settled(live);
      expect([live.ackState, live.ackedBy, live.orchestrationResult]).toEqual(["satisfied", "a1", true]);

      // The same row past its TTL no longer covers the next call.
      scope.now = () => 500;
      const late = email("late");
      bag.enqueue(late);
      await when(() => late.policyResult !== null, { timeout: TIMEOUT });
      expect([late.ackState, late.licenseDecision]).toEqual(["pending", null]);

      // Back in time and reconciled, then revoked while the call still waits.
      scope.now = () => 10;
      sync();
      expect(late.ackState).toBe("satisfied");
      rows = [];
      sync();
      expect(late.ackState).toBe("pending");
    });
  }

  it("a row for another session, project or bot does not count; a grant is not an ack", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: { acknowledge: [MAIL_FLAG] },
      grants: [
        ack({ scopeKey: "other-session" }),
        ack({ id: "a2", scope: "project", scopeKey: "/elsewhere" }),
        { ...ack({ id: "g1" }), kind: "grant" },
        { ...ack({ id: "g2" }), kind: undefined },
      ],
    });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect(mail.ackState).toBe("pending");
  });

  it("an ack narrower than the flag satisfies it for that call; a broader one does not", async () => {
    using bag = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [{ match: { mcp: "gmail" } }] } });
    const scope = scopes.get(bag.root);
    scope.now = () => 1;
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect(mail.ackState).toBe("pending");
    bag.root.replaceGrantsJson(JSON.stringify([ack()]));
    scope.reconcileGrants();
    expect(mail.ackState).toBe("satisfied");

    using narrow = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [MAIL_FLAG] } });
    narrow.root.replaceGrantsJson(JSON.stringify([ack({ subject: { kind: "mcp", server: "gmail" } })]));
    const again = email("again");
    narrow.enqueue(again);
    await when(() => again.policyResult !== null, { timeout: TIMEOUT });
    // A server-wide ack is broader than a tool-level flag: it does not stand in for it.
    expect(again.ackState).toBe("pending");
  });
});

describe("the project layer can add a flag but never remove one", () => {
  it("a project removal of a user flag is ignored; a project flag adds", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: { acknowledge: [MAIL_FLAG] },
      project: JSON.stringify({ acknowledge: [{ match: { mcp: "gmail", tool: "send_email" }, remove: true }] }),
    });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    expect(mail.ackState).toBe("pending");

    using added = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      project: JSON.stringify({ acknowledge: [{ match: { command: ["curl"] } }] }),
    });
    const curl = shell("curl x");
    added.enqueue(curl);
    await when(() => curl.policyResult !== null, { timeout: TIMEOUT });
    expect([curl.ackState, curl.ackFlags[0]?.layer]).toEqual(["pending", "project"]);
  });

  it("a session overlay may cancel the user's flag it lists as removed, a project cannot override that", async () => {
    using bag = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [MAIL_FLAG] } });
    bag.root.replaceAuthorizationOverlay(JSON.stringify({ acknowledge: [{ match: MAIL_FLAG.match, remove: true }] }));
    const mail = email();
    bag.enqueue(mail);
    await settled(mail);
    expect(mail.ackState).toBe("none");
  });
});

describe("block and denials are never lifted or acknowledged", () => {
  it("a block stays a block with no ack state", async () => {
    using bag = setup({
      policy: "yolo",
      policyProgram: FLOOR,
      user: { acknowledge: [{ match: { command: ["blocked"] } }] },
    });
    const blocked = shell("blocked now");
    bag.enqueue(blocked);
    await settled(blocked);
    expect([blocked.policyResult, blocked.ackState, blocked.licenseDecision, blocked.needsHuman]).toEqual([
      "block",
      "none",
      false,
      false,
    ]);
  });

  it("a denial stays a denial (the table says deny), the flag adds nothing", async () => {
    using bag = setup({
      policy: "manual",
      policyProgram: FLOOR,
      user: { manual: { default: { ask: "deny" } }, acknowledge: [{ match: { command: ["curl"] } }] },
    });
    const curl = shell("curl x");
    bag.enqueue(curl);
    await settled(curl);
    expect([curl.ackState, curl.licenseDecision, curl.licenseDetail.code]).toEqual(["pending", false, "policy_denied"]);
    expect(curl.needsHuman).toBe(false);
  });

  it("a person refusing the prompt denies the call as a human refusal", async () => {
    using bag = setup({ policy: "yolo", policyProgram: FLOOR, user: { acknowledge: [MAIL_FLAG] } });
    const mail = email();
    bag.enqueue(mail);
    await when(() => mail.policyResult !== null, { timeout: TIMEOUT });
    mail.stampAck("refused", null);
    mail.humanApprove = false;
    await settled(mail);
    expect([mail.orchestrationResult, mail.licenseDetail.code]).toEqual([false, null]);
  });
});

describe("unattended: a missing ack is interaction_required, reported, not counted; the run continues", () => {
  it("denies the flagged call, notifies, and runs the next call", async () => {
    using bag = setup({
      policy: "auto",
      unattended: true,
      policyProgram: FLOOR,
      user: { auto: ALLOW_ALL, acknowledge: [MAIL_FLAG] },
    });
    const scope = scopes.get(bag.root);
    const notices: string[] = [];
    scope.onRunNotice = (notice) => notices.push(notice.text);
    const mail = email();
    const ls = shell("ls");
    bag.enqueue(mail);
    bag.enqueue(ls);
    await settled(mail);
    await settled(ls);
    expect({
      mail: [mail.orchestrationResult, mail.licenseDetail.code, mail.needsHuman],
      ls: ls.orchestrationResult,
    }).toEqual({ mail: [false, "interaction_required", false], ls: true });
    expect(refusalReasonOf(mail)).toContain("Needs acknowledgement: gmail · send_email");
    expect(notices.join("\n")).toContain("needs an acknowledgement: gmail · send_email");
    const ledger = ledgerFor(scope, bag.turn);
    expect([ledger.total, ledger.consecutive, ledger.stopped]).toEqual([0, 0, false]);
  });

  it("a stored ack lets the unattended call run", async () => {
    using bag = setup({
      policy: "auto",
      unattended: true,
      policyProgram: FLOOR,
      user: { auto: ALLOW_ALL, acknowledge: [MAIL_FLAG] },
      grants: [ack()],
    });
    const mail = email();
    bag.enqueue(mail);
    await settled(mail);
    expect([mail.ackState, mail.orchestrationResult]).toEqual(["satisfied", true]);
  });

  it("many missing acks never trip the denial counters", async () => {
    using bag = setup({
      policy: "auto",
      unattended: true,
      policyProgram: FLOOR,
      user: {
        auto: ALLOW_ALL,
        acknowledge: [MAIL_FLAG],
        escalate: { consecutiveDenials: 1, totalDenials: 1, hardStopTotal: 2 },
      },
    });
    const scope = scopes.get(bag.root);
    scope.onRunNotice = () => {};
    const jobs = Array.from({ length: 6 }, (_, i) => email(`m${i}`));
    for (const job of jobs) bag.enqueue(job);
    for (const job of jobs) await settled(job);
    const ledger = ledgerFor(scope, bag.turn);
    expect([ledger.total, ledger.stopped, bag.turn.cancelRequested]).toEqual([0, false, false]);
  });
});
