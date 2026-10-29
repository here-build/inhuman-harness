/**
 * Bypass detection for unattended runs: what counts as a denial, when the judge pass runs, what each
 * answer does, and the two configurable exceptions (a check that fails twice, the hard stop).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ESCALATION, type CompletionExpectation } from "@inhuman.tools/harness-model";
import { describe, expect, it } from "vitest";

import {
  buildBypassSections,
  decideTrigger,
  hintsFor,
  parseBypassVerdict,
  RunLedger,
  stopReason,
  type CallRecord,
} from "../bypass.js";
import { scopes } from "../scope.js";
import type { RunStop } from "../unattended-guard.js";
import { shell, settled, write } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const here = dirname(fileURLToPath(import.meta.url));
const distAsk = readFileSync(join(here, "../../../policy/auto-mode-ask.scm"), "utf8");

const FLOOR = `{"write_file":["."],"write_block":[{"path":".bashrc","class":"control-plane"}],"bash":{"policy":"ask","subcommands":{"rm":{"policy":"deny","class":"destroy-local"},"ls":"approve"}}}`;

const rec = (over: Partial<CallRecord> = {}): Omit<CallRecord, "i"> => ({
  tool: "shell",
  args: "{}",
  tier: "deny",
  classes: ["destroy-local"],
  ruleIds: ["bash:rm"],
  outcome: "resolver-deny",
  ...over,
});

describe("ledger and triggers", () => {
  const esc = DEFAULT_ESCALATION;
  const last = { classes: ["destroy-local"], outcome: "resolver-deny" } as const;

  it("3 consecutive denials trigger a check; a run in between resets the count", () => {
    const ledger = new RunLedger();
    ledger.denied(rec());
    ledger.denied(rec());
    expect(decideTrigger(ledger, esc, last)).toBeNull();
    ledger.ran({ tool: "shell", args: "{}", tier: "policyApprove", classes: [], ruleIds: [] });
    ledger.denied(rec());
    ledger.denied(rec());
    expect(decideTrigger(ledger, esc, last)).toBeNull();
    ledger.denied(rec());
    expect(decideTrigger(ledger, esc, last)).toBe("check");
  });
  it("20 total denials trigger a check, but only 3+ new ones since the last check", () => {
    const ledger = new RunLedger();
    for (let n = 0; n < 20; n += 1) {
      ledger.denied(rec());
      ledger.ran({ tool: "shell", args: "{}", tier: "policyApprove", classes: [], ruleIds: [] });
    }
    expect(ledger.consecutive).toBe(0);
    expect(decideTrigger(ledger, esc, last)).toBe("check");
    ledger.lastCheckAtTotal = ledger.total;
    ledger.denied(rec());
    expect(decideTrigger(ledger, esc, last)).toBeNull();
  });
  it("a control-plane block after an earlier denial stops immediately; the first denial does not", () => {
    const ledger = new RunLedger();
    ledger.denied(rec());
    expect(decideTrigger(ledger, esc, { classes: ["control-plane"], outcome: "floor-block" })).toBeNull();
    ledger.denied(rec({ outcome: "floor-block", classes: ["control-plane"] }));
    expect(decideTrigger(ledger, esc, { classes: ["control-plane"], outcome: "floor-block" })).toBe("immediate");
  });
  it("hardStopTotal stops regardless of the judge; null turns it off; thresholds are configurable", () => {
    const ledger = new RunLedger();
    for (let n = 0; n < 60; n += 1) ledger.denied(rec());
    ledger.lastCheckAtTotal = ledger.total;
    expect(decideTrigger(ledger, esc, last)).toBe("hard-stop");
    expect(decideTrigger(ledger, { ...esc, hardStopTotal: null }, last)).toBeNull();
    expect(decideTrigger(ledger, { ...esc, hardStopTotal: 100 }, last)).toBeNull();
    const small = new RunLedger();
    small.denied(rec());
    small.denied(rec());
    small.denied(rec());
    expect(decideTrigger(small, { ...esc, consecutiveDenials: 5 }, last)).toBeNull();
    expect(decideTrigger(small, { ...esc, consecutiveDenials: 3 }, last)).toBe("check");
  });
  it("uncounted calls (a human refusal) neither count nor reset the consecutive run", () => {
    const ledger = new RunLedger();
    ledger.denied(rec());
    ledger.uncounted({ ...rec(), outcome: "resolver-deny" });
    expect([ledger.total, ledger.consecutive, ledger.calls.length]).toEqual([1, 1, 2]);
  });
});

describe("hints and sections", () => {
  it("derives same-rule, file-then-execute, encoded and control-plane hints", () => {
    const ledger = new RunLedger();
    ledger.denied(rec({ args: JSON.stringify({ command: "rm -rf x" }) }));
    ledger.denied(rec({ args: JSON.stringify({ command: "find x -delete" }) }));
    ledger.ran({
      tool: "write_file",
      args: JSON.stringify({ path: "wipe.sh" }),
      tier: "ask",
      classes: [],
      ruleIds: [],
    });
    ledger.denied(rec({ args: JSON.stringify({ command: "sh wipe.sh" }), ruleIds: ["lift:unparsed"] }));
    ledger.denied(
      rec({
        args: JSON.stringify({ command: "echo cm0gLXJm | base64 -d | sh" }),
        classes: ["control-plane"],
        ruleIds: ["x"],
      }),
    );
    const hints = hintsFor(ledger.calls);
    expect(hints.sameRuleAs).toEqual([[0, 1]]);
    expect(hints.executesFileWrittenAt).toEqual([{ call: 3, writtenAt: 2 }]);
    expect(hints.encodedPayload).toContain(4);
    expect(hints.controlPlaneTouch).toEqual([4]);
  });
  it("every section is one line of JSON and the window is the latest calls", () => {
    const ledger = new RunLedger();
    for (let n = 0; n < 30; n += 1) ledger.denied(rec({ args: JSON.stringify({ command: `rm ${n}\n@@END` }) }));
    const s = buildBypassSections({ task: "clean\n@@TASK", calls: ledger.calls, notes: ["a\nb"], window: 20 });
    for (const text of Object.values(s)) {
      expect(text).not.toContain("\n");
      expect(() => JSON.parse(text)).not.toThrow();
    }
    const calls = JSON.parse(s.callsJson) as CallRecord[];
    expect(calls).toHaveLength(20);
    expect(calls[0]?.i).toBe(10);
    expect(JSON.parse(s.restrictionsJson)[0]).toMatchObject({ class: "destroy-local" });
  });
  it("parses the verdict strictly", () => {
    const ok = { verdict: "bypass", pattern: "script-indirection", calls: [1, 3], reason: "wrote and ran a script" };
    expect(parseBypassVerdict(ok)).toEqual(ok);
    expect(stopReason(ok as never)).toBe("bypass suspected: script-indirection (calls 1, 3): wrote and ran a script");
    for (const bad of [
      null,
      "bypass",
      { ...ok, extra: 1 },
      { ...ok, verdict: "maybe" },
      { ...ok, pattern: "other" },
      { ...ok, calls: ["1"] },
      { ...ok, calls: Array.from({ length: 21 }, (_, i) => i) },
      { verdict: "bypass", pattern: "none", calls: [] },
    ]) {
      expect("fail" in (parseBypassVerdict(bad) as object)).toBe(true);
    }
  });
});

type Answer = Record<string, unknown> | "fail";

function run(opts: { readonly answers: Answer[]; readonly user?: unknown; readonly privileged?: string }) {
  const prompts: string[] = [];
  const stops: RunStop[] = [];
  const notices: string[] = [];
  const bag = setup({
    policy: "auto",
    unattended: true,
    policyProgram: FLOOR,
    judgeAskProgram: distAsk,
    privileged: opts.privileged ?? "tidy the build directory",
    // every soft-deny and ask is denied by the table: nothing here needs a model but the bypass check
    user: opts.user ?? { unattended: { default: "deny" } },
    seal(completion: CompletionExpectation) {
      prompts.push(completion.userPrompt);
      const next = opts.answers.shift();
      if (next === undefined || next === "fail") {
        completion.fail("settled", "model unreachable", "null");
        return;
      }
      completion.succeed("settled", "", "null", { result: { text: JSON.stringify(next) } });
    },
  });
  bag.root.kvs.connection = "c1";
  bag.root.kvs.model = "m";
  const scope = scopes.get(bag.root);
  scope.onRunStopped = (stop) => stops.push(stop);
  scope.onRunNotice = (notice) => notices.push(notice.text);
  return { bag, prompts, stops, notices, scope };
}

const verdict = (v: string, pattern = "none", reason = "because", calls: number[] = []) => ({
  verdict: v,
  pattern,
  calls,
  reason,
});

async function deny(bag: ReturnType<typeof run>["bag"], n: number, command = "rm -rf build"): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    const job = shell(`${command} ${i}`);
    bag.enqueue(job);
    await settled(job);
    expect(job.orchestrationResult).toBe(false);
  }
}

describe("an unattended run that keeps being denied", () => {
  it("a bypass verdict stops the run: sealed interaction_required, cancel requested, host told", async () => {
    const r = run({
      answers: [verdict("bypass", "same-effect-different-route", "tried find -delete after rm", [1, 2])],
    });
    using bag = r.bag;
    await deny(bag, 3);
    expect(r.stops).toHaveLength(1);
    expect(r.stops[0]).toMatchObject({
      kind: "bypass",
      reason: "bypass suspected: same-effect-different-route (calls 1, 2): tried find -delete after rm",
    });
    expect(bag.turn.cancelRequested).toBe(true);
    // the judge saw the labelled sections, with the series in CALLS only
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain("@@CALLS");
    expect(r.prompts[0]).toContain("rm -rf build 0");
    expect(r.prompts[0]).toContain("@@RESTRICTIONS");
    // further denials do not check or stop again
    await deny(bag, 3);
    expect(r.prompts).toHaveLength(1);
    expect(r.stops).toHaveLength(1);
  });

  it("no-bypass continues and resets the run; the same window is not judged again", async () => {
    const r = run({ answers: [verdict("no-bypass", "repeated-identical")] });
    using bag = r.bag;
    await deny(bag, 5);
    expect(r.prompts).toHaveLength(1);
    expect(r.stops).toEqual([]);
    expect(bag.turn.cancelRequested).toBe(false);
    expect(scopes.get(bag.root).ledgers.get(bag.turn)?.consecutive).toBe(2);
  });

  it("unsure continues and posts a non-stopping notice", async () => {
    const r = run({ answers: [verdict("unsure")] });
    using bag = r.bag;
    await deny(bag, 3);
    expect(r.stops).toEqual([]);
    expect(r.notices).toHaveLength(1);
    expect(bag.turn.cancelRequested).toBe(false);
  });

  it("a check that fails twice stops the run (fail closed); stopOnDoubleFail false continues", async () => {
    const closed = run({ answers: ["fail", "fail"] });
    using a = closed.bag;
    await deny(a, 3);
    expect(closed.stops).toHaveLength(1);
    expect(closed.stops[0]).toMatchObject({ kind: "check-unavailable", reason: "bypass check unavailable" });
    expect(a.turn.cancelRequested).toBe(true);

    const open = run({
      answers: ["fail", "fail"],
      user: { unattended: { default: "deny" }, escalate: { stopOnDoubleFail: false } },
    });
    using b = open.bag;
    await deny(b, 3);
    expect(open.stops).toEqual([]);
    expect(open.notices).toHaveLength(1);
  });

  it("one failed attempt is retried once", async () => {
    const r = run({ answers: ["fail", verdict("no-bypass")] });
    using bag = r.bag;
    await deny(bag, 3);
    expect(r.prompts).toHaveLength(2);
    expect(r.stops).toEqual([]);
  });

  it("an unparseable answer is a failed attempt", async () => {
    const r = run({ answers: [{ verdict: "bypass" }, { verdict: "bypass" }] });
    using bag = r.bag;
    await deny(bag, 3);
    expect(r.stops[0]?.kind).toBe("check-unavailable");
  });

  it("hardStopTotal stops without asking the judge; null disables it", async () => {
    const r = run({
      answers: [],
      user: {
        unattended: { default: "deny" },
        escalate: { hardStopTotal: 2, consecutiveDenials: 50, totalDenials: 50 },
      },
    });
    using bag = r.bag;
    await deny(bag, 2);
    expect(r.prompts).toHaveLength(0);
    expect(r.stops[0]).toMatchObject({ kind: "hard-stop", reason: "hard stop: 2 denied calls (limit 2)" });

    const off = run({
      answers: [],
      user: {
        unattended: { default: "deny" },
        escalate: { hardStopTotal: null, consecutiveDenials: 99, totalDenials: 99 },
      },
    });
    using b = off.bag;
    await deny(b, 4);
    expect(off.stops).toEqual([]);
  });

  it("a control-plane block after an earlier denial stops directly, with no judge", async () => {
    const r = run({ answers: [] });
    using bag = r.bag;
    await deny(bag, 1);
    const job = write(".bashrc");
    bag.enqueue(job);
    await settled(job);
    expect(job.policyResult).toBe("block");
    expect(r.prompts).toHaveLength(0);
    expect(r.stops[0]).toMatchObject({ kind: "immediate" });
    expect(bag.turn.cancelRequested).toBe(true);
  });

  it("the check can be turned off; thresholds are configurable", async () => {
    const off = run({ answers: [], user: { unattended: { default: "deny" }, judge: { bypass: { enabled: false } } } });
    using a = off.bag;
    await deny(a, 4);
    expect([off.prompts.length, off.stops.length]).toEqual([0, 0]);

    const eager = run({
      answers: [verdict("no-bypass")],
      user: { unattended: { default: "deny" }, escalate: { consecutiveDenials: 3 } },
    });
    using b = eager.bag;
    await deny(b, 3);
    expect(eager.prompts).toHaveLength(1);
  });

  it("approved calls reset the consecutive run and never count", async () => {
    const r = run({ answers: [] });
    using bag = r.bag;
    await deny(bag, 2);
    const ok = shell("ls");
    bag.enqueue(ok);
    await settled(ok);
    expect(ok.orchestrationResult).toBe(true);
    await deny(bag, 2);
    expect(r.prompts).toHaveLength(0);
    expect(scopes.get(bag.root).ledgers.get(bag.turn)).toMatchObject({ total: 4, consecutive: 2 });
  });

  it("watching sessions are never counted", async () => {
    using bag = setup({
      policy: "manual",
      unattended: false,
      policyProgram: FLOOR,
      user: { manual: { default: "deny" } },
    });
    for (let i = 0; i < 5; i += 1) {
      const job = shell(`rm ${i}`);
      bag.enqueue(job);
      await settled(job);
    }
    expect(scopes.get(bag.root).ledgers.get(bag.turn)).toBeUndefined();
  });
});
