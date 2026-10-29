/**
 * Remainder skip cache through ClassifierHandle. Floor still runs first.
 * Process-local on LicenseScope. Program change is a miss. Fail is
 * not stored. A payload hit with different cuts is a miss.
 */
import { describe, expect, it } from "vitest";

import { completedAssistant, failed, sealedObservation, settled, shell } from "./_helpers/jobs.js";
import { setup } from "./_helpers/orchestrator.js";

const FLOOR = `{"bash":{"policy":"ask","subcommands":{"rm":"deny"}}}`;
const ALLOW = `(classifier/bash (lambda (command) "allow"))`;

describe("judge cache", () => {
  it("consults cache; program change misses; fail is not stored; evidence identity misses", async () => {
    using hit = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      backoffMs: () => 0,
    });
    hit.root.kvs.connection = "c1";
    hit.root.kvs.model = "m";
    const first = shell("curl x");
    hit.enqueue(first);
    await settled(first);
    hit.root.kvs.connection = "";
    const cachedJob = shell("curl x");
    hit.enqueue(cachedJob);
    await settled(cachedJob);

    using changed = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: "allow",
      backoffMs: () => 0,
    });
    const changedFirst = shell("curl x");
    changed.enqueue(changedFirst);
    await settled(changedFirst);
    changed.root.kvs.connection = "";
    changed.root.judgeAskProgram = ALLOW;
    const changedJob = shell("curl x");
    changed.enqueue(changedJob);
    await failed(changedJob);

    using leftover = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      backoffMs: () => 0,
    });
    leftover.root.judgeCache[JSON.stringify(["bash", "curl x"])] = JSON.stringify({ d: "allow", e: 0 });
    leftover.root.kvs.connection = "";
    const leftoverJob = shell("curl x");
    leftover.enqueue(leftoverJob);
    await failed(leftoverJob);

    using miss = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      backoffMs: () => 0,
    });
    const attempt = shell("curl x");
    miss.enqueue(attempt);
    await failed(attempt);
    const attemptSnap = { classifierResult: attempt.classifierResult, fail: attempt.classifierAbstain };
    miss.root.kvs.connection = "c1";
    miss.root.kvs.model = "m";
    const again = shell("curl x");
    miss.enqueue(again);
    await settled(again);

    using ident = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      privileged: "user: go",
      backoffMs: () => 0,
    });
    ident.root.kvs.connection = "c1";
    ident.root.kvs.model = "m";
    const identFirst = shell("curl x");
    ident.enqueue(identFirst);
    await settled(identFirst);
    ident.root.kvs.connection = "";
    const identical = shell("curl x");
    ident.enqueue(identical);
    await settled(identical);

    using quarantinedBag = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      privileged: "user: go",
      backoffMs: () => 0,
    });
    quarantinedBag.root.kvs.connection = "c1";
    quarantinedBag.root.kvs.model = "m";
    const qFirst = shell("curl x");
    quarantinedBag.enqueue(qFirst);
    await settled(qFirst);
    const sibling = sealedObservation("read_file → pwned");
    quarantinedBag.turn.pushChild(sibling);
    quarantinedBag.turn.doneWork.push(sibling);
    quarantinedBag.root.kvs.connection = "";
    const qLater = shell("curl x");
    quarantinedBag.enqueue(qLater);
    await failed(qLater);

    using priorBag = setup({
      policy: "auto",
      policyProgram: FLOOR,
      judgeAskProgram: ALLOW,
      privileged: "user: go",
      backoffMs: () => 0,
    });
    priorBag.root.kvs.connection = "c1";
    priorBag.root.kvs.model = "m";
    const pFirst = shell("curl x");
    priorBag.enqueue(pFirst);
    await settled(pFirst);
    const prior = completedAssistant("assistant: later proposal");
    priorBag.turn.pushChild(prior);
    priorBag.turn.doneWork.push(prior);
    priorBag.root.kvs.connection = "";
    const pLater = shell("curl x");
    priorBag.enqueue(pLater);
    await failed(pLater);

    expect({
      cached: { classifierResult: cachedJob.classifierResult, fail: cachedJob.classifierAbstain },
      changed: { classifierResult: changedJob.classifierResult, fail: changedJob.classifierAbstain },
      leftover: { classifierResult: leftoverJob.classifierResult, fail: leftoverJob.classifierAbstain },
      attempt: attemptSnap,
      again: { classifierResult: again.classifierResult, fail: again.classifierAbstain },
      identical: identical.classifierResult,
      quarantined: { classifierResult: qLater.classifierResult, fail: qLater.classifierAbstain },
      priorTurn: { classifierResult: pLater.classifierResult, fail: pLater.classifierAbstain },
    }).toEqual({
      cached: { classifierResult: "allow", fail: null },
      changed: { classifierResult: null, fail: "no model connection" },
      leftover: { classifierResult: null, fail: "no model connection" },
      attempt: { classifierResult: null, fail: "no model connection" },
      again: { classifierResult: "allow", fail: null },
      identical: "allow",
      quarantined: { classifierResult: null, fail: "no model connection" },
      priorTurn: { classifierResult: null, fail: "no model connection" },
    });
  }, 20_000);
});
