import { DefaultedMap } from "@here.build/collections";
import { action, autorun, comparer, computed, observable, type IReactionDisposer, reaction, toJS } from "mobx";
import invariant from "tiny-invariant";

import {
  acquireConnection,
  releaseConnection,
} from "./kernel-intern.js";
import { ExpectationActor } from "../driver/ExpectationActor.js";
import {
  type ConnectionSecretsView,
  type DriverConnectionClass,
  extraLiveFromState,
  isDriverConnectionClass,
  type PEWDriver,
} from "../driver/PEWDriver.js";
import { DriverSpec } from "../shared/models/DriverSpec.js";
import { Job } from "../shared/models/Job.js";
import { WorkContainer, walkWork } from "../shared/models/WorkContainer.js";
import { type AnyWorkExpectation, WorkExpectation, isTreeOrphan } from "../shared/models/WorkExpectation.js";
import { type KernelPlexus, type SessionPlexus } from "../shared/types.js";

/** Class identity for `instanceof`. `registerExecutor` never constructs. */
export type JobConstructor<T extends Job = Job> = abstract new (...args: any[]) => T;

/**
 * Seam: session work graph → honor (PEW) and claim (Job).
 *
 * Honor is reachable PEW → handle. Unstarted cancel writes the durable
 * ending here and must not poke `ensure` — MCP: an unstarted tool must not
 * spin the server. Do not call `Actor.complete` — unstarted Work has no
 * Actor. `handle` is not the sealer. License is phase 1 on an Approvable
 * leaf. A sealed parent is not honored (the
 * child is already ending in the agentic runtime, or must not start).
 *
 * INTERN TABLE IS NOT AN ATOM. `#connections` is a plain Map of kernel-interned
 * instances (one live driver per kernel connection id). Honor re-enters by
 * reading catalog `spec.readyState` and, once minted, `instance.readyState`.
 * `handle` only when `ready`.
 *
 * A rejected ensure/load memo IS the sticky failure (no hot loop).
 *
 * Honor and Job claim do not start in the constructor. PEW autorun used to
 * run during `super()`, so a readiness Promise after construct was not a
 * gate. Call {@link activate} after replicas are pinned and recovery ran.
 *
 * Import discipline: this module does not import harness or the session document.
 */
export abstract class Orchestrator<
  K extends KernelPlexus = KernelPlexus,
  S extends SessionPlexus = SessionPlexus,
> implements Disposable {
  #disposed = false;
  #admissionStopped = false;
  readonly #activated = observable.box(false);
  readonly #disposeWork: () => void;
  /** Disposed with the orchestrator — a dead session must not keep writing the live kernel catalog. */
  readonly #mirrorDisposers: IReactionDisposer[] = [];
  readonly #processes = new Map<JobConstructor, () => void>();
  /** Execute (phase 2) — started BODY. */
  readonly #jobAbort = new Map<Job, AbortController>();
  /** In-flight license (phase 1). */
  readonly #guardAbort = new Map<Job, AbortController>();
  /**
   * Process-local: execute already claimed this job. Survives seal:false
   * so the starter does not re-run BODY. A new Orchestrator is empty —
   * bootstrap `orchestrated && !completed` runs execute once more.
   */
  readonly #bodyStarted = new WeakSet<Job>();
  /**
   * Origin-dispatched PEW skip. Lives here, not on the session subclass:
   * honor used to run during `super()`, and subclass fields are unassigned
   * then (JS). A child WeakSet made `shouldHonor` throw `undefined.has`.
   */
  protected readonly originCompletions = new WeakSet<WorkExpectation>();
  readonly #disposeAborts: () => void;

  constructor(
    public readonly kernel: K,
    public readonly session: S,
  ) {
    this.#mirrorDisposers.push(
      autorun(() => {
        if (this.#disposed || !this.#activated.get()) return;
        for (const name of Object.keys(this.drivers)) {
          // Driver discovery is intentionally eager so the kernel catalog can
          // expose class-side offers and live facts before a connection is
          // ensured. A session may not be able to load every driver in a
          // shared kernel, so consume a rejected discovery promise here; the
          // driver spec already carries the failure for interested readers.
          void this.#classes.get(name).catch(() => {});
        }
      }),
    );
    this.#disposeWork = autorun(() => {
      if (this.#disposed || !this.#activated.get()) return;
      for (const node of collectReachable(this.session.root)) {
        if (node.isDone || isTreeOrphan(node)) continue;
        if (!this.shouldHonor(node)) continue;
        const spec = this.connections[node.connectionId];
        if (spec === undefined) continue;
        void spec.readyState;
        const instance = this.#connections.get(node.connectionId);
        if (instance !== undefined) {
          if (instance.readyState === "ready") instance.handle(node);
          continue;
        }
        invariant(Object.hasOwn(this.connections, node.connectionId), `unknown connection ${node.connectionId}`);
        void this.ensure(node.connectionId);
      }
    });
    this.#disposeAborts = autorun(() => {
      if (this.#disposed || !this.#activated.get()) return;
      const live = new Set(this.reachableJobs);
      for (const [job, ac] of this.#jobAbort) {
        if (live.has(job) || ac.signal.aborted) continue;
        ac.abort();
      }
      for (const [job, ac] of this.#guardAbort) {
        if (live.has(job) || ac.signal.aborted) continue;
        ac.abort();
      }
    });
  }

  @computed
  protected get reachableJobs(): Job[] {
    const root = this.session.root;
    const jobs = new Set<Job>();
    if (root instanceof Job) jobs.add(root);
    if (root instanceof WorkContainer) {
      for (const job of Iterator.from(walkWork(root)).filter((node): node is Job => node instanceof Job)) {
        jobs.add(job);
      }
    }
    return [...jobs];
  }

  /**
   * Two functions. License (phase 1) returns `true` | `false` and writes
   * `orchestrationResult` (`orchestrated` follows). `true` → await execute
   * (phase 2). `false` → skip execute, `completed = true`. Bootstrap
   * `orchestrated && !completed` skips the license and runs execute.
   * `signal` aborts when the job leaves the graph or the orchestrator disposes.
   */
  registerExecutor<T extends Job>(
    Class: JobConstructor<T>,
    license: (job: T, orchestrator: this) => boolean | Promise<boolean>,
    execute: (job: T, signal: AbortSignal, orchestrator: this) => void | Promise<void>,
    options?: { readonly seal?: boolean },
  ): void {
    invariant(!this.#processes.has(Class), `Orchestrator: executor already registered for ${Class.name}`);
    const seal = options?.seal !== false;
    this.#processes.set(
      Class,
      autorun(() => {
        if (this.#disposed || !this.#activated.get()) return;
        for (const node of this.reachableJobs) {
          if (!(node instanceof Class)) continue;
          const job = node as T;
          if (job.completed || job.cancelled) continue;
          if (job.orchestrationResult === false) {
            job.markComplete();
            continue;
          }
          if (job.orchestrationResult === true) {
            this.#startExecute(job, execute, seal);
            continue;
          }
          if (this.#guardAbort.has(job) || this.#jobAbort.has(job)) continue;
          // Ordering is data on the job: wait here until every predecessor is released.
          if (!job.afterReleased) continue;
          this.#startGuard(job, license, execute, seal);
        }
      }),
    );
  }

  #startGuard<T extends Job>(
    job: T,
    license: (job: T, orchestrator: this) => boolean | Promise<boolean>,
    execute: (job: T, signal: AbortSignal, orchestrator: this) => void | Promise<void>,
    seal: boolean,
  ): void {
    const settle = action((ok: boolean) => {
      if (job.orchestrationResult !== null || job.completed || job.cancelled) return;
      job.orchestrationResult = ok;
      if (ok) {this.#startExecute(job, execute, seal);}
      else {job.markComplete();}
    });
    // A guard that threw never licensed the job: deny it with a crash receipt.
    const crashed = action((error: unknown) => {
      if (job.orchestrationResult !== null || job.completed || job.cancelled) return;
      this.#recordCrash(job, "license", error);
      job.orchestrationResult = false;
      job.markComplete();
    });
    try {
      const result = license(job, this);
      if (typeof result === "boolean") {
        settle(result);
        return;
      }
      const ac = new AbortController();
      this.#guardAbort.set(job, ac);
      void result.then(
        (ok) => {
          if (ac.signal.aborted) return;
          settle(ok);
          return ok;
        },
        (error: unknown) => {
          if (ac.signal.aborted) return;
          crashed(error);
        },
      ).finally(
        action(() => {
          this.#guardAbort.delete(job);
        }),
      );
    } catch (error) {
      crashed(error);
    }
  }

  #startExecute<T extends Job>(
    job: T,
    execute: (job: T, signal: AbortSignal, orchestrator: this) => void | Promise<void>,
    seal: boolean,
  ): void {
    if (this.#bodyStarted.has(job) || job.completed || job.cancelled) return;
    if (job.orchestrationResult !== true) return;
    this.#bodyStarted.add(job);
    action(() => {
      job.markStarted();
    })();
    const ac = new AbortController();
    this.#jobAbort.set(job, ac);
    void Promise.resolve()
      .then(() => execute(job, ac.signal, this))
      .then(
        () => false,
        (error: unknown) => {
          // An abort (cancel, park, leaving the graph) is not a crash: the aborter owns the ending.
          if (ac.signal.aborted || job.completed || job.cancelled) return false;
          action(() => this.#recordCrash(job, "body", error))();
          return true;
        },
      )
      .then(
        action((crashed: boolean) => {
          if (seal || crashed) job.markComplete();
          this.#jobAbort.delete(job);
        }),
      )
      .catch(() => {});
  }

  #recordCrash(job: Job, phase: "license" | "body", error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    job.crash = `${phase}: ${detail === "" ? "unknown error" : detail}`;
    try {
      this.stampCrash(job, phase, detail);
    } catch {
      /* the crash fact is already on the job; the receipt is best effort */
    }
  }

  /**
   * Host hook: a guard or body threw. `job.crash` is set; write the receipt
   * the job's joiners read (a tool outcome, a call failure). The orchestrator
   * completes the job right after.
   */
  protected stampCrash(_job: Job, _phase: "license" | "body", _detail: string): void {}

  /** In-flight claimed Jobs (handler has not `finally`'d). */
  protected inFlightJobs(): Iterable<Job> {
    return this.#jobAbort.keys();
  }

  /** Abort an in-flight executor. No-op if the job is not claimed here. */
  abortJob(job: Job, reason?: unknown): void {
    this.#jobAbort.get(job)?.abort(reason);
  }

  readonly #connections = new Map<string, PEWDriver>();
  readonly #classes = new DefaultedMap<string, Promise<DriverConnectionClass>>(this.#loadDriverClass.bind(this));
  readonly #ensured = new DefaultedMap<string, Promise<PEWDriver>>(this.#ensureConnection.bind(this));

  abstract loadDriverModule(driver: DriverSpec): Promise<DriverConnectionClass>;

  /**
   * Honor still `handle`s leftover attach PEW. Origin-dispatched completions
   * return false (PR4). Default true unless the node is in {@link originCompletions}.
   */
  protected shouldHonor(node: WorkExpectation): boolean {
    return !this.originCompletions.has(node);
  }

  /** Process-local. Secrets are never a Plexus field. */
  protected connectionSecrets(_connectionId: string): ConnectionSecretsView {
    return { get: () => undefined };
  }

  /** After bootstrap, before ensure settles. The session host binds the settings writer here. */
  protected attachConnection(_connectionId: string, _instance: PEWDriver): void {}

  connectionOf(expectation: WorkExpectation): PEWDriver | undefined {
    return this.#connections.get(expectation.connectionId);
  }

  actorOf<T extends AnyWorkExpectation>(expectation: T): ExpectationActor<T> | undefined {
    const connection = this.connectionOf(expectation);
    if (!connection?.has(expectation)) return undefined;
    return connection.resolveExpectation(expectation);
  }

  #loadDriverClass(driverName: string): Promise<DriverConnectionClass> {
    return (async () => {
      // JS: subclass fields (SessionOrchestrator.sessionDaemon) are unassigned during super().
      await Promise.resolve();
      const driver = this.drivers[driverName];
      invariant(driver !== undefined, `unknown driver ${driverName}`);
      try {
        const cls = await this.loadDriverModule(driver);
        invariant(isDriverConnectionClass(cls), "loadDriverModule: result is not a PEWDriver class");
        // Occupancy is kernel-plane: interned connections outlive a session wrap.
        cls.awareness = this.kernel.awareness;
        cls.driverName = driverName;
        const spec = this.drivers[driverName];
        if (spec !== undefined) {
          spec.stampLoad({
            readyState: "ready",
            error: "",
            offersJson: JSON.stringify(cls.offers),
            live: extraLiveFromState(cls.state),
          });
          // Offers are class state a driver may keep fresh (local detection). The
          // reaction also holds the observation that wakes a lazy `cls.offers`.
          this.#mirrorDisposers.push(
            reaction(
              () => toJS(cls.offers),
              (offers) => {
                if (!this.#disposed) spec.offers = offers;
              },
              { equals: comparer.structural },
            ),
          );
        }
        return cls;
      } catch (error) {
        const spec = this.drivers[driverName];
        if (spec !== undefined) spec.stampLoad({ readyState: "failed", error: String(error) });
        throw error;
      }
    })();
  }

  #ensureConnection(connectionId: string): Promise<PEWDriver> {
    const pending = (async () => {
      const driver = this.kernel.root.connections[connectionId]?.driver;
      invariant(driver !== undefined, `unknown driver for connection ${connectionId}`);
      const instance = await acquireConnection(this.kernel.root, this, connectionId, async () => {
        const cls = await this.#classes.get(driver.name);
        const minted = new cls(
          connectionId,
          // YAML: settings stamped onto the connection before ensure.
          this.kernel.root.connections[connectionId]?.configuration ?? {},
          this.connectionSecrets(connectionId),
        );
        action(() => {
          minted.awareness = this.kernel.awareness; // kernel occupancy, not session
        })();
        return minted;
      });
      action(() => {
        instance.awareness = this.kernel.awareness;
      })();
      this.#connections.set(connectionId, instance);
      await instance.ensureBootstrapStarted();
      this.attachConnection(connectionId, instance);
      return instance;
    })();
    void pending.then(undefined, () => {});
    return pending;
  }

  ensure(connectionId: string): Promise<PEWDriver> {
    return this.#ensured.get(connectionId);
  }

  /** True once the connection memo has been poked — without poking it. */
  protected isEnsured(connectionId: string): boolean {
    return this.#ensured.has(connectionId);
  }

  /** Intern-owner remint. Deletes the sticky `#ensured` memo. */
  forgetConnection(id: string): void {
    this.#ensured.delete(id);
    this.#connections.delete(id);
    releaseConnection(this.kernel.root, this, id);
  }

  /** True after {@link activate}; constructor and registerExecutor do not honor. */
  get activated(): boolean {
    return this.#activated.get();
  }

  /**
   * Start honor, Job claim, and driver discovery. Idempotent. No-op after
   * park/dispose — those already stopped admission.
   */
  activate(): void {
    if (this.#disposed || this.#admissionStopped) return;
    action(() => {
      this.#activated.set(true);
    })();
  }

  /**
   * Stop honor and new claim. In-flight BODY and live connections stay —
   * park waits dispatched MCP before {@link Symbol.dispose} releases them.
   */
  protected stopAdmission(): void {
    if (this.#admissionStopped) return;
    this.#admissionStopped = true;
    this.#disposeWork();
    for (const dispose of this.#processes.values()) dispose();
    this.#processes.clear();
    for (const ac of this.#guardAbort.values()) ac.abort("park");
  }

  [Symbol.dispose](): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.stopAdmission();
    for (const ac of this.#jobAbort.values()) ac.abort();
    for (const ac of this.#guardAbort.values()) ac.abort();
    this.#disposeAborts();
    this.#jobAbort.clear();
    this.#guardAbort.clear();
    for (const id of this.#connections.keys()) releaseConnection(this.kernel.root, this, id);
    this.#connections.clear();
    for (const dispose of this.#mirrorDisposers.splice(0)) dispose();
  }

  get drivers() {
    return this.kernel.root.drivers;
  }

  get connections() {
    return this.kernel.root.connections;
  }
}

function collectReachable(root: unknown): Set<WorkExpectation> {
  if (!(root instanceof WorkContainer)) return new Set();
  const found = new Set<WorkExpectation>();
  for (const node of walkWork(root)) {
    if (node instanceof WorkExpectation) found.add(node);
  }
  return found;
}
