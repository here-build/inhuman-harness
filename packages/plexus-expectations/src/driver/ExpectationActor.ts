import { type PlexusAwareness } from "@here.build/plexus";
import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";
import { reaction, runInAction } from "mobx";
import invariant from "tiny-invariant";
import { createActor } from "xstate";

import { type ActorPhase, type ActorPhaseEvent, expectationActorMachine } from "./actor-machine.js";
import type { PEWDriver } from "./PEWDriver.js";
import type { Settlement } from "../executor/types.js";
import type { SessionAwareness } from "../shared/index.js";
import {
  type AnyWorkExpectation,
  type ReportOf,
  type ResultOf,
  ROLE_LANE_OCCUPIED,
} from "../shared/models/WorkExpectation.js";
import { reportRole, retractRole } from "../shared/role.js";

/**
 * Thrown from `run()` — `start()` settles the work as fail, not crash.
 *
 * Two kinds: {@link ConnectionNotReady} (fulfiller not live), {@link DemandIncomplete}
 * (required field missing on the expectation). Not this family: cancel, applySettlement,
 * report JSON crash, HTTP/tool `fail(reason)`.
 */
export abstract class ExpectationInvariant extends ErrorWithInvariant {
  override name = this.constructor.name;

  constructor(message: string) {
    super(message);
  }
}

/** Honor started; the fulfiller is not live. */
export class ConnectionNotReady extends ExpectationInvariant {
  constructor(readonly connection: string) {
    super(`${connection} connection not ready`);
  }
}

/** Required field missing on the expectation body. */
export class DemandIncomplete extends ExpectationInvariant {
  constructor(readonly field: string) {
    super(`demand missing ${field}`);
  }
}

/**
 * One execution of one expectation, bound to the process that has the live connection.
 *
 * ENDINGS ARE OBSERVED, NOT IMPOSED. The actor writes durable endings only at
 * two authority points — its own settlement (`#settle` / `#crash`) and host
 * admission (`admitTermination`). Everything that must happen BECAUSE the
 * work ended (abort the signal, leave) runs in the done reaction — so an
 * ending that arrives from anywhere (a peer's write synced in, host policy)
 * stops this actor exactly like its own. Child endings are supervision's
 * job (the tree-orphan rule), never a cascade from here.
 */
export abstract class ExpectationActor<E extends AnyWorkExpectation = AnyWorkExpectation> {
  readonly #hub: PlexusAwareness<SessionAwareness>;
  readonly #controller = new AbortController();
  readonly signal: AbortSignal = this.#controller.signal;
  #lastReportJson: string | null = null;
  #settlement: Settlement<ResultOf<E>> | null = null;
  #resolveSettled!: (settlement: Settlement<ResultOf<E>>) => void;
  #rejectSettled!: (reason: unknown) => void;
  public readonly settled: Promise<Settlement<ResultOf<E>>>;
  readonly #phase = createActor(expectationActorMachine).start();
  #laneDisposers: Array<() => void> = [];
  #left = false;

  constructor(
    public readonly expectation: E,
    public readonly driverConnection: PEWDriver<E>,
  ) {
    this.settled = new Promise<Settlement<ResultOf<E>>>((resolve, reject) => {
      this.#resolveSettled = resolve;
      this.#rejectSettled = reject;
    });
    void this.settled.catch(() => {});

    this.signal.addEventListener(
      "abort",
      () => {
        this.#send("ABORT");
      },
      { once: true },
    );

    invariant(expectation.plexus != null, "ExpectationActor requires the expectation to be on a session plexus");
    this.#hub = expectation.plexus.awareness as PlexusAwareness<SessionAwareness>;
    this.#laneDisposers.push(
      reaction(
        () => this.expectation.isDone,
        (done) => {
          if (!done) return;
          this.abort("done");
          this.#send("RELEASE");
          this.leave();
        },
        { fireImmediately: true },
      ),
    );
  }

  get started(): boolean {
    return !this.#phase.getSnapshot().can({ type: "START" });
  }

  get done(): boolean {
    return this.#phase.getSnapshot().status === "done";
  }

  start(): void {
    invariant(this.#phase.getSnapshot().can({ type: "START" }), "double-start attempt");
    this.#send("START");
    runInAction(() => {
      this.expectation.markStarted();
    });
    this.#occupyRoleLane();
    try {
      const result = this.run();
      if (result != null && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((error) => this.#onRunError(error));
      }
    } catch (error) {
      this.#onRunError(error);
    }
  }

  #onRunError(error: unknown): void {
    if (error instanceof ExpectationInvariant) {
      this.fail(error);
      return;
    }
    this.#crash(error);
  }

  #matches(phase: ActorPhase): boolean {
    return this.#phase.getSnapshot().matches(phase);
  }

  #send(type: ActorPhaseEvent["type"]): void {
    if (!this.#phase.getSnapshot().can({ type })) return;
    this.#phase.send({ type });
  }

  #occupyRoleLane(): void {
    reportRole(this.#hub, this.expectation.uuid, ROLE_LANE_OCCUPIED);
  }

  protected abstract run(): void | Promise<void>;

  abort(reason?: unknown): void {
    this.#controller.abort(reason);
  }

  protected report(frame: ReportOf<E>): void {
    if (!this.#matches("running")) return;
    let json: string;
    try {
      json = JSON.stringify(frame ?? null);
    } catch (error) {
      this.#crash(error);
      return;
    }
    this.#lastReportJson = json;
    reportRole(this.#hub, this.expectation.uuid, JSON.parse(json));
  }

  protected complete(result: ResultOf<E>): void {
    this.#settle({ outcome: "complete", result });
  }

  protected fail(reason: unknown): void {
    this.#settle({ outcome: "fail", reason });
  }

  #settle(settlement: Settlement<ResultOf<E>>): void {
    if (this.done || !this.#phase.getSnapshot().can({ type: "SETTLE" })) return;
    const wasRunning = this.#matches("running");
    this.#settlement = settlement;
    this.#resolveSettled(settlement);
    this.#send("SETTLE");
    this.#commitEnding("settle", wasRunning);
  }

  #crash(reason: unknown): void {
    if (this.done || !this.#phase.getSnapshot().can({ type: "CRASH" })) return;
    const wasRunning = this.#matches("running");
    this.#rejectSettled(reason);
    this.#send("CRASH");
    this.#commitEnding("crash", wasRunning, String(reason));
  }

  /**
   * ENDING PRECEDES ABORT. A settlement captured while running (or consulted
   * when admitting cancel) wins. A complete/fail flushed from an abort listener
   * is stored on `#settlement` but not written here.
   */
  #commitEnding(kind: "settle" | "crash" | "cancel", wasRunning: boolean, crashDetail?: string): void {
    if (this.expectation.isDone) return;
    if (this.#settlement !== null && (wasRunning || kind === "cancel")) {
      const settlement = this.#settlement;
      if (settlement.outcome === "complete") {
        this.expectation.succeed("settled", "", this.#frameJson(), { result: settlement.result });
      } else {
        this.expectation.fail(
          "settled",
          settlement.reason instanceof Error ? settlement.reason.message : String(settlement.reason),
          this.#frameJson(),
        );
      }
      return;
    }
    if (kind === "cancel") {
      this.expectation.fail("cancel", "terminate", this.#frameJson());
      return;
    }
    if (!wasRunning) return;
    if (kind === "crash") {
      this.expectation.fail("crash", crashDetail ?? "", this.#frameJson());
    }
  }

  /** Host cancel. A settlement captured while running outranks the cancel. */
  admitTermination(): void {
    this.#commitEnding("cancel", this.#matches("running"));
  }

  #frameJson(): string {
    return this.#lastReportJson ?? "null";
  }

  leave(): void {
    if (!this.#left) {
      this.#left = true;
      for (const dispose of this.#laneDisposers) dispose();
      this.#laneDisposers = [];
      retractRole(this.#hub, this.expectation.uuid);
    }
    this.driverConnection.release(this.expectation);
  }
}
