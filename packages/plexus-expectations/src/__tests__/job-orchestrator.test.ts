import { configure } from "mobx";
import { afterEach, describe, expect, it } from "vitest";

import { PewJudge, StoredJob } from "./_helpers/test-jobs.js";
import { makeJobHost } from "./_helpers/test-job-orchestrator.js";

function settled(): Promise<void> {
  return Promise.resolve();
}

async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > 5000) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Orchestrator jobs", () => {
  afterEach(() => {
    configure({ disableErrorBoundaries: false });
  });

  it("constructor and registerExecutor do not honor until activate", async () => {
    configure({ disableErrorBoundaries: true });
    const pew = new PewJudge({ connectionId: "c1" });
    using bag = makeJobHost([pew], { activate: false });
    bag.host.registerExecutor(StoredJob, () => true, async () => {});
    const stored = new StoredJob();
    bag.sessionRoot.declared.push(stored);
    await settled();
    expect({ activated: bag.host.activated, orchestrated: stored.orchestrated, declared: bag.sessionRoot.declared }).toEqual({
      activated: false,
      orchestrated: false,
      declared: [pew, stored],
    });
    expect(() => bag.host.activate()).not.toThrow();
    expect(stored.orchestrated).toBe(true);
    await waitUntil(() => stored.completed, "claimed after activate");
  });

  it("dispose stops claiming new jobs", async () => {
    using bag = makeJobHost();
    bag.host.registerExecutor(StoredJob, () => true, async () => {});
    const first = new StoredJob();
    bag.sessionRoot.declared.push(first);
    await waitUntil(() => first.completed, "first claimed");
    bag.host[Symbol.dispose]();
    const second = new StoredJob();
    bag.sessionRoot.declared.push(second);
    await settled();
    expect(second.orchestrated).toBe(false);
  });

  it("seal:false does not invent completed when execute returns", async () => {
    using bag = makeJobHost();
    bag.host.registerExecutor(StoredJob, () => true, async () => {}, { seal: false });
    const sitting = new StoredJob();
    bag.sessionRoot.declared.push(sitting);
    await waitUntil(() => sitting.orchestrated, "claimed");
    await settled();
    expect({ orchestrated: sitting.orchestrated, completed: sitting.completed }).toEqual({
      orchestrated: true,
      completed: false,
    });
  });

  it("registerExecutor throws if the class is already registered", () => {
    using bag = makeJobHost();
    bag.host.registerExecutor(StoredJob, () => true, async () => {});
    expect(() => bag.host.registerExecutor(StoredJob, () => true, async () => {})).toThrow(
      /executor already registered for StoredJob/,
    );
  });

  it("late registerExecutor claims already-reachable jobs of that class", async () => {
    using bag = makeJobHost();
    const stored = new StoredJob();
    bag.sessionRoot.declared.push(stored);
    expect(stored.orchestrated).toBe(false);
    bag.host.registerExecutor(StoredJob, () => true, async () => {});
    expect(stored.orchestrated).toBe(true);
    await waitUntil(() => stored.completed, "late claim");
  });

  it("a throwing execute still completes; later jobs of that class still run", async () => {
    using bag = makeJobHost();
    let threw = false;
    bag.host.registerExecutor(
      StoredJob,
      () => true,
      () => {
        if (!threw) {
          threw = true;
          throw new Error("boom");
        }
        return Promise.resolve();
      },
    );
    const thrown = new StoredJob();
    bag.sessionRoot.declared.push(thrown);
    await waitUntil(() => thrown.completed, "thrown completed");
    expect(thrown.completed).toBe(true);

    const later = new StoredJob();
    bag.sessionRoot.declared.push(later);
    await waitUntil(() => later.completed, "later completed");
    expect(later.completed).toBe(true);
  });

  describe("crash ending", () => {
    it("a license that throws synchronously denies the job with a crash fact", async () => {
      using bag = makeJobHost();
      bag.host.registerExecutor(
        StoredJob,
        () => {
          throw new Error("guard exploded");
        },
        async () => {
          throw new Error("body must not run");
        },
      );
      const job = new StoredJob();
      bag.sessionRoot.declared.push(job);
      await waitUntil(() => job.completed, "crashed guard completes");
      expect({ result: job.orchestrationResult, crash: job.crash, started: job.startedAtMs }).toEqual({
        result: false,
        crash: "license: guard exploded",
        started: null,
      });
    });

    it("a license that rejects denies the job with a crash fact", async () => {
      using bag = makeJobHost();
      bag.host.registerExecutor(
        StoredJob,
        () => Promise.reject(new Error("guard rejected")),
        async () => {},
      );
      const job = new StoredJob();
      bag.sessionRoot.declared.push(job);
      await waitUntil(() => job.completed, "rejected guard completes");
      expect({ result: job.orchestrationResult, crash: job.crash }).toEqual({
        result: false,
        crash: "license: guard rejected",
      });
    });

    it("a seal:false body that throws completes with a crash fact and the host stamps the receipt", async () => {
      const stamped: string[] = [];
      using bag = makeJobHost();
      (bag.host as unknown as { stampCrash(job: unknown, phase: string, detail: string): void }).stampCrash = (
        _job,
        phase,
        detail,
      ) => {
        stamped.push(`${phase}:${detail}`);
      };
      bag.host.registerExecutor(
        StoredJob,
        () => true,
        () => {
          throw new Error("body exploded");
        },
        { seal: false },
      );
      const job = new StoredJob();
      bag.sessionRoot.declared.push(job);
      await waitUntil(() => job.completed, "crashed body completes");
      expect({ crash: job.crash, stamped }).toEqual({ crash: "body: body exploded", stamped: ["body:body exploded"] });
    });

    it("an aborted body is not a crash", async () => {
      using bag = makeJobHost();
      bag.host.registerExecutor(
        StoredJob,
        () => true,
        (_job, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        { seal: false },
      );
      const job = new StoredJob();
      bag.sessionRoot.declared.push(job);
      await waitUntil(() => job.orchestrated && job.startedAtMs != null, "started");
      bag.host.abortJob(job, "park");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect({ crash: job.crash, completed: job.completed }).toEqual({ crash: "", completed: false });
    });
  });

  it("false guard skips execute and completes", async () => {
    using bag = makeJobHost();
    let executed = 0;
    bag.host.registerExecutor(
      StoredJob,
      () => false,
      async () => {
        executed += 1;
      },
    );
    const denied = new StoredJob();
    bag.sessionRoot.declared.push(denied);
    await waitUntil(() => denied.completed, "denied completed");
    expect({ result: denied.orchestrationResult, executed }).toEqual({ result: false, executed: 0 });
    expect({ started: denied.startedAtMs, ended: denied.endedAtMs != null, duration: denied.durationMs() }).toEqual({
      started: null,
      ended: true,
      duration: null,
    });
  });

  it("BODY start stamps startedAt; complete stamps endedAt", async () => {
    using bag = makeJobHost();
    bag.host.registerExecutor(StoredJob, () => true, async () => {});
    const job = new StoredJob();
    bag.sessionRoot.declared.push(job);
    await waitUntil(() => job.completed, "BODY completed");
    expect(job.startedAtMs).toEqual(expect.any(Number));
    expect(job.endedAtMs).toEqual(expect.any(Number));
    expect(job.endedAtMs!).toBeGreaterThanOrEqual(job.startedAtMs!);
    expect(job.durationMs()).toBe(job.endedAtMs! - job.startedAtMs!);
  });

  it("bootstrap orchestrated && !completed skips guard and runs execute", async () => {
    using bag = makeJobHost();
    let guarded = 0;
    let executed = 0;
    const sitting = new StoredJob();
    sitting.orchestrationResult = true;
    bag.sessionRoot.declared.push(sitting);
    bag.host.registerExecutor(
      StoredJob,
      () => {
        guarded += 1;
        return true;
      },
      async () => {
        executed += 1;
      },
      { seal: false },
    );
    await waitUntil(() => executed === 1, "execute without guard");
    expect(guarded).toBe(0);
    expect(sitting.completed).toBe(false);
    await settled();
    expect(executed).toBe(1);
  });

  it("executor signal aborts when the job leaves the graph and when the host disposes", async () => {
    using bag = makeJobHost();
    const signals: AbortSignal[] = [];
    bag.host.registerExecutor(
      StoredJob,
      () => true,
      (_job, signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    );

    const abandoned = new StoredJob();
    bag.sessionRoot.declared.push(abandoned);
    await waitUntil(() => signals.length === 1, "abandoned claimed");
    expect(signals[0]!.aborted).toBe(false);
    bag.sessionRoot.declared.splice(bag.sessionRoot.declared.indexOf(abandoned), 1);
    await waitUntil(() => signals[0]!.aborted, "abandoned aborted");
    await waitUntil(() => abandoned.completed, "abandoned completed");

    const inFlight = new StoredJob();
    bag.sessionRoot.declared.push(inFlight);
    await waitUntil(() => signals.length === 2, "in-flight claimed");
    expect(signals[1]!.aborted).toBe(false);
    bag.host[Symbol.dispose]();
    await waitUntil(() => signals[1]!.aborted, "dispose aborted");
    await waitUntil(() => inFlight.completed, "in-flight completed");
  });
  describe("after", () => {
    function gated() {
      const bag = makeJobHost();
      const started: StoredJob[] = [];
      const finish = new Map<StoredJob, () => void>();
      bag.host.registerExecutor(
        StoredJob,
        () => true,
        (job) => {
          started.push(job);
          return new Promise<void>((resolve) => finish.set(job, resolve));
        },
      );
      return { bag, started, finish };
    }

    it("claims a job only after every predecessor is released", async () => {
      const { bag, started, finish } = gated();
      using _bag = bag;
      const first = new StoredJob();
      const second = new StoredJob();
      const third = new StoredJob();
      second.stampAfter([first]);
      third.stampAfter([first, second]);
      bag.sessionRoot.declared.push(first, second, third);
      await waitUntil(() => started.length === 1, "first claimed");
      await settled();
      expect({ started: started.length, second: second.orchestrated, third: third.orchestrated }).toEqual({
        started: 1,
        second: false,
        third: false,
      });
      finish.get(first)!();
      await waitUntil(() => started.length === 2, "second claimed");
      expect(third.orchestrated).toBe(false);
      finish.get(second)!();
      await waitUntil(() => started.length === 3, "third claimed");
      expect(started).toEqual([first, second, third]);
    });

    it("a job with no predecessors, or siblings only, starts at once", async () => {
      const { bag, started } = gated();
      using _bag = bag;
      const a = new StoredJob();
      const b = new StoredJob();
      bag.sessionRoot.declared.push(a, b);
      await waitUntil(() => started.length === 2, "both claimed");
    });

    it("a denied predecessor releases its successor", async () => {
      using bag = makeJobHost();
      const order: string[] = [];
      const first = new StoredJob();
      const second = new StoredJob();
      second.stampAfter([first]);
      bag.host.registerExecutor(
        StoredJob,
        (job) => job !== first,
        (job) => {
          order.push(job === first ? "first" : "second");
        },
      );
      bag.sessionRoot.declared.push(first, second);
      await waitUntil(() => second.completed, "second ran");
      expect({ first: first.orchestrationResult, order }).toEqual({ first: false, order: ["second"] });
    });

    it("a started background predecessor releases its successor", async () => {
      const { bag, started } = gated();
      using _bag = bag;
      const first = new StoredJob();
      first.background = true;
      const second = new StoredJob();
      second.stampAfter([first]);
      bag.sessionRoot.declared.push(first, second);
      await waitUntil(() => started.length === 2, "second claimed beside the running background job");
    });

    it("holds across a new orchestrator: after is a synced fact, not scheduler state", async () => {
      const first = new StoredJob();
      const second = new StoredJob();
      second.stampAfter([first]);
      using bag = makeJobHost([first, second], { activate: false });
      const started: StoredJob[] = [];
      bag.host.registerExecutor(
        StoredJob,
        () => true,
        (job) => {
          started.push(job);
          return new Promise<void>(() => {});
        },
      );
      bag.host.activate();
      await waitUntil(() => started.length === 1, "first claimed");
      await settled();
      expect(started).toEqual([first]);
    });
  });
});
