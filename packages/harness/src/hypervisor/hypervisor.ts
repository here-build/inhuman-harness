import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { note, trace } from "@inhuman.tools/harness-diagnostics";

import {
  publishedReadiness,
  serverRosterSchema,
  SUPERVISION_PROTOCOL_VERSION,
  type OwnerEvidence,
  type PublishedHealth,
  type ServerDescriptor,
  type ServerRole,
  type ServerRoster,
  type ShutdownCutoff,
  type SupervisionIdentity,
  type SupervisionMessage,
  type TopologyHealth,
} from "@/protocol/schemas";
import {
  isPlaneReady,
  isStaleSupervisionIdentity,
  mayReplaceExecutionOwner,
  mayStartExecutionOwnerAfterYjsLoss,
  replacementDecision,
} from "@/protocol/supervision";

import { readSupervisionMessages, writeSupervisionMessage } from "./ipc.js";
import { isLifetimeLockHeld, LifetimeLock, lockPathFor, waitForLockRelease } from "./lock.js";
import { pidAlive, sleep, waitUntil } from "./util.js";

const READY_TIMEOUT_MS = 10_000;
const LOCK_WAIT_MS = 10_000;
const STOP_GRACE_MS = 500;

export class AdmissionRefusedError extends Error {
  constructor() {
    super("hypervisor admission refused");
    this.name = "AdmissionRefusedError";
  }
}

export class ReplacementRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`replacement refused: ${reason}`);
    this.name = "ReplacementRefusedError";
  }
}

export type HypervisorOptions = {
  readonly root: string;
  readonly serverRoster: ServerRoster;
  readonly hypervisorId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly readyTimeoutMs?: number;
};

export type ChildSnapshot = {
  readonly id: string;
  readonly role: ServerRole;
  readonly pid: number | undefined;
  readonly identity: SupervisionIdentity;
  readonly health: PublishedHealth;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | undefined;
  readonly cutoff: ShutdownCutoff | undefined;
};

type ChildRecord = {
  descriptor: ServerDescriptor;
  process: ChildProcess | undefined;
  identity: SupervisionIdentity;
  health: PublishedHealth;
  lockPath: string | undefined;
  exit: { code: number | null; signal: string | null } | undefined;
  cutoff: ShutdownCutoff | undefined;
  restartAttempts: number;
  parentLost: boolean;
  dataDisconnected: boolean;
  heartbeatMissing: boolean;
};

export class Hypervisor implements AsyncDisposable {
  readonly root: string;
  readonly hypervisorId: string;
  readonly serverRoster: ServerRoster;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readyTimeoutMs: number;
  private readonly children = new Map<string, ChildRecord>();
  private admission: "open" | "refused" = "open";
  private rootLock: LifetimeLock | undefined;
  private serverEpoch = 1;
  private runtimeGeneration = 1;
  private chain: Promise<void> = Promise.resolve();

  private constructor(options: HypervisorOptions, roster: ServerRoster) {
    this.root = options.root;
    this.hypervisorId = options.hypervisorId ?? randomUUID();
    this.serverRoster = roster;
    this.env = options.env ?? process.env;
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  }

  static async start(options: HypervisorOptions): Promise<Hypervisor> {
    const roster = serverRosterSchema.parse(options.serverRoster);
    const hv = new Hypervisor(options, roster);
    await mkdir(options.root, { recursive: true });
    hv.rootLock = await LifetimeLock.acquire(lockPathFor(options.root, "root"), "root");
    try {
      await hv.boot();
    } catch (error) {
      await hv.shutdown({ deadlineMs: 5_000 }).catch(() => undefined);
      throw error;
    }
    return hv;
  }

  get admissionState(): "open" | "refused" {
    return this.admission;
  }

  health(): TopologyHealth {
    const yjs = this.roleChild("yjs");
    const runtime = this.roleChild("runtime");
    return {
      sync: planeOf(yjs, "sync"),
      storage: planeOf(yjs, "storage"),
      execution: planeOf(runtime, "execution"),
    };
  }

  snapshot(): ChildSnapshot[] {
    return [...this.children.values()].map((child) => ({
      id: child.descriptor.id,
      role: child.descriptor.role,
      pid: child.process?.pid,
      identity: child.identity,
      health: child.health,
      exit: child.exit,
      cutoff: child.cutoff,
    }));
  }

  async replace(id: string): Promise<void> {
    await this.enqueue(() => this.replaceExclusive(id));
  }

  private async replaceExclusive(id: string): Promise<void> {
    const child = this.requireChild(id);
    if (this.admission === "refused") throw new AdmissionRefusedError();
    const evidence = await this.ownerEvidence(child);
    const decision = replacementDecision(evidence);
    if (decision.action !== "replace") {
      throw new ReplacementRefusedError(decision.reason);
    }
    if (child.descriptor.role === "runtime") this.runtimeGeneration += 1;
    if (child.descriptor.role === "yjs") this.serverEpoch += 1;
    await this.spawnAndWaitReady(child.descriptor);
  }

  async shutdown(options?: { deadlineMs?: number }): Promise<ShutdownCutoff> {
    const deadlineMs = options?.deadlineMs ?? 5_000;
    this.admission = "refused";
    const live = [...this.children.values()].filter((child) => child.process !== undefined && child.exit === undefined);
    await Promise.all(
      live.map((child) =>
        this.send(child, {
          v: SUPERVISION_PROTOCOL_VERSION,
          op: "shutdown",
          identity: child.identity,
          deadlineMs,
        }),
      ),
    );

    const deadline = Date.now() + deadlineMs;
    try {
      await waitUntil(
        "children stop",
        () => [...this.children.values()].every((child) => child.exit !== undefined),
        Math.max(0, deadline - Date.now()),
      );
    } catch {
      /* force remaining */
    }

    let forced = false;
    for (const child of this.children.values()) {
      if (child.exit !== undefined) continue;
      forced = true;
      const pid = child.process?.pid;
      if (pid !== undefined && pidAlive(pid)) {
        try {
          child.process?.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    }
    await sleep(STOP_GRACE_MS);
    for (const child of this.children.values()) {
      if (child.exit !== undefined) continue;
      const pid = child.process?.pid;
      if (pid !== undefined && pidAlive(pid)) {
        try {
          child.process?.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    await waitUntil(
      "forced child exit",
      () => [...this.children.values()].every((child) => child.exit !== undefined),
      5_000,
    ).catch(() => undefined);

    for (const child of this.children.values()) {
      if (child.lockPath !== undefined) {
        await waitForLockRelease(child.lockPath, LOCK_WAIT_MS).catch(() => undefined);
      }
    }

    const flush = this.aggregateFlush();
    const cutoff: ShutdownCutoff = {
      admission: "refused",
      drain: [...this.children.values()].every((child) => child.exit !== undefined) ? "complete" : "pending",
      flush,
      forced,
    };
    await this.rootLock?.release();
    this.rootLock = undefined;
    note(`hypervisor shutdown complete forced=${forced} flush=${flush}`);
    return cutoff;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.rootLock !== undefined) {
      await this.shutdown({ deadlineMs: 5_000 });
    }
  }

  private async boot(): Promise<void> {
    const remaining = new Set(this.serverRoster.servers.map((server) => server.id));
    while (remaining.size > 0) {
      const next = this.serverRoster.servers.find(
        (server) => remaining.has(server.id) && server.requires.every((required) => this.isReady(required)),
      );
      if (next === undefined) {
        await waitUntil(
          "readiness dependencies",
          () =>
            this.serverRoster.servers.some(
              (server) => remaining.has(server.id) && server.requires.every((required) => this.isReady(required)),
            ),
          this.readyTimeoutMs,
        );
        continue;
      }
      remaining.delete(next.id);
      await this.spawnAndWaitReady(next);
    }
  }

  private isReady(id: string): boolean {
    const child = this.children.get(id);
    if (child === undefined || child.exit !== undefined) return false;
    return publishedReadiness(child.descriptor.role).every((kind) => isPlaneReady(child.health, kind));
  }

  private roleChild(role: ServerRole): ChildRecord | undefined {
    return [...this.children.values()].find((child) => child.descriptor.role === role);
  }

  private requireChild(id: string): ChildRecord {
    const child = this.children.get(id);
    if (child === undefined) throw new Error(`unknown descriptor ${id}`);
    return child;
  }

  private makeIdentity(descriptor: ServerDescriptor): SupervisionIdentity {
    return {
      hypervisor: { kind: "hypervisor", id: this.hypervisorId },
      process: { kind: descriptor.role, id: descriptor.id },
      serverEpoch: this.serverEpoch,
      runtimeGeneration: this.runtimeGeneration,
      connectionEpoch: 1,
    };
  }

  private lockPathForRole(role: ServerRole): string | undefined {
    return role === "runtime" ? lockPathFor(this.root, "runtime") : undefined;
  }

  private async ownerEvidence(child: ChildRecord): Promise<OwnerEvidence> {
    const lockReleased = child.lockPath === undefined ? true : !(await isLifetimeLockHeld(child.lockPath));
    return {
      exitConfirmed: child.exit !== undefined,
      lockReleased,
      parentLost: child.parentLost,
      dataDisconnected: child.dataDisconnected,
      heartbeatMissing: child.heartbeatMissing,
    };
  }

  private async spawnAndWaitReady(descriptor: ServerDescriptor): Promise<void> {
    if (this.admission === "refused") throw new AdmissionRefusedError();
    await this.waitForRequires(descriptor);
    const lockPath = this.lockPathForRole(descriptor.role);
    const previous = this.roleChild(descriptor.role);
    if (previous !== undefined && previous.exit === undefined) {
      const decision = replacementDecision(await this.ownerEvidence(previous));
      if (decision.action !== "replace") {
        throw new ReplacementRefusedError(decision.reason);
      }
    }
    if (lockPath !== undefined) {
      await waitForLockRelease(lockPath, LOCK_WAIT_MS);
    }
    if (previous !== undefined && descriptor.role === "runtime") {
      const decision = replacementDecision(await this.ownerEvidence(previous));
      if (decision.action !== "replace") {
        throw new ReplacementRefusedError(decision.reason);
      }
    }

    // Shutdown may have collected its live set during the awaits above.
    if (this.admissionState === "refused") throw new AdmissionRefusedError();
    const identity = this.makeIdentity(descriptor);
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      HARNESS_ROLE: descriptor.role,
      HARNESS_SUPERVISION_IDENTITY: JSON.stringify(identity),
    };
    if (lockPath !== undefined) {
      childEnv.HARNESS_LOCK_PATH = lockPath;
      childEnv.HARNESS_LOCK_KIND = "runtime";
    }

    trace(
      "harness:hypervisor",
      `spawn ${descriptor.id} role=${descriptor.role} gen=${identity.runtimeGeneration} epoch=${identity.serverEpoch}`,
    );
    const childProcess = spawn(descriptor.executable, descriptor.args, {
      cwd: this.root,
      env: childEnv,
      stdio: ["pipe", "pipe", "inherit"],
    });
    childProcess.stdin.on("error", () => {
      /* EPIPE after child death is not a hypervisor failure */
    });
    childProcess.stdout.on("error", () => {
      /* closed pipe */
    });

    const record: ChildRecord = {
      descriptor,
      process: childProcess,
      identity,
      health: {},
      lockPath,
      exit: undefined,
      cutoff: undefined,
      restartAttempts: this.children.get(descriptor.id)?.restartAttempts ?? 0,
      parentLost: false,
      dataDisconnected: false,
      heartbeatMissing: false,
    };
    this.children.set(descriptor.id, record);

    readSupervisionMessages(
      childProcess.stdout,
      (message) => this.onMessage(descriptor.id, message),
      (error) => {
        note(`hypervisor ${descriptor.id} control ipc fatal ${String(error)}`);
        try {
          childProcess.kill("SIGTERM");
        } catch {
          /* gone */
        }
      },
    );

    childProcess.once("exit", (code, signal) => {
      const current = this.children.get(descriptor.id);
      if (current?.process !== undefined && current.process !== childProcess) {
        return;
      }
      // Record exit on the event, not only inside the serialized onExit
      // chain — spawnAndWaitReady may be on that chain already.
      this.recordExit(descriptor.id, childProcess, code, signal);
      void this.enqueue(() => this.onExit(descriptor.id, code, signal));
    });

    try {
      await waitUntil(
        `${descriptor.id} ready`,
        () =>
          record.exit !== undefined ||
          publishedReadiness(descriptor.role).every((kind) => isPlaneReady(record.health, kind)),
        this.readyTimeoutMs,
      );
    } catch (error) {
      // A child that never came ready still holds its lock. Its exit runs the restart policy.
      childProcess.kill("SIGKILL");
      throw error;
    }
    if (record.exit !== undefined) {
      throw new Error(`${descriptor.id} exited before ready code=${record.exit.code} signal=${record.exit.signal}`);
    }
    record.restartAttempts = 0;
  }

  private onMessage(id: string, message: SupervisionMessage): void {
    const child = this.children.get(id);
    if (child === undefined) return;
    if (isStaleSupervisionIdentity(child.identity, message.identity)) {
      trace("harness:hypervisor", `drop stale frame from ${id}`);
      return;
    }
    if (message.identity.process.id !== child.descriptor.id) return;

    if (message.op === "ready" || message.op === "health" || message.op === "failed") {
      child.health = message.health;
    }
    if (message.op === "failed") {
      note(`hypervisor ${id} failed ${message.reason}`);
    }
    if (message.op === "stopped") {
      child.cutoff = message.cutoff;
    }
    if (message.op === "loss") {
      if (message.kind === "parent-lost") child.parentLost = true;
      if (message.kind === "data-disconnected") child.dataDisconnected = true;
      if (message.kind === "heartbeat-missing") child.heartbeatMissing = true;
    }
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private recordExit(id: string, childProcess: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    const child = this.children.get(id);
    if (child === undefined) return;
    if (child.process !== undefined && child.process !== childProcess) return;
    if (child.exit !== undefined) return;
    child.exit = { code, signal };
    child.process = undefined;
  }

  private async waitForRequires(descriptor: ServerDescriptor): Promise<void> {
    if (descriptor.requires.length === 0) return;
    await waitUntil(
      `${descriptor.id} requires`,
      () => descriptor.requires.every((required) => this.isReady(required)),
      this.readyTimeoutMs,
    );
  }

  private async onExit(id: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const child = this.children.get(id);
    if (child === undefined) return;
    child.exit ??= { code, signal };
    child.process = undefined;
    note(`hypervisor ${id} exited code=${code} signal=${signal ?? "none"}`);
    if (child.lockPath !== undefined) {
      await waitForLockRelease(child.lockPath, LOCK_WAIT_MS).catch(() => {
        note(`hypervisor ${id} lock still held after exit`);
      });
    }
    if (this.admission === "refused") return;

    if (child.descriptor.role === "yjs") {
      await this.stopRuntimeBeforeYjsReplace(child);
    }

    if (!(await this.shouldRestart(child))) return;
    child.restartAttempts += 1;
    if (child.descriptor.role === "runtime") this.runtimeGeneration += 1;
    if (child.descriptor.role === "yjs") this.serverEpoch += 1;
    await sleep(child.descriptor.restart.backoffMs);
    try {
      await this.spawnAndWaitReady(child.descriptor);
    } catch (error) {
      note(`hypervisor restart ${id} failed ${String(error)}`);
    }
  }

  private async stopRuntimeBeforeYjsReplace(yjs: ChildRecord): Promise<void> {
    const runtime = this.roleChild("runtime");
    if (runtime === undefined || runtime.exit !== undefined) return;
    await this.send(runtime, {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "shutdown",
      identity: runtime.identity,
      deadlineMs: 5_000,
    });
    try {
      await waitUntil("runtime exit after yjs loss", () => runtime.exit !== undefined, 5_000);
    } catch {
      try {
        runtime.process?.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    const evidence = await this.ownerEvidence(runtime);
    if (!mayStartExecutionOwnerAfterYjsLoss(evidence)) {
      note(`hypervisor yjs ${yjs.descriptor.id} loss still holds runtime lock`);
    }
  }

  private async shouldRestart(child: ChildRecord): Promise<boolean> {
    if (this.admission === "refused") return false;
    if (child.exit === undefined) return false;
    const { mode, maxAttempts } = child.descriptor.restart;
    if (mode === "never") return false;
    if (child.restartAttempts >= maxAttempts) return false;
    const failed = child.exit.code !== 0 || child.exit.signal != null;
    if (mode === "on-failure" && !failed) return false;
    const evidence = await this.ownerEvidence(child);
    if (child.descriptor.role === "runtime" && !mayReplaceExecutionOwner(evidence)) {
      return false;
    }
    return true;
  }

  private async send(child: ChildRecord, message: SupervisionMessage): Promise<void> {
    const stdin = child.process?.stdin;
    if (stdin == null) return;
    try {
      await writeSupervisionMessage(stdin, message);
    } catch {
      /* child already closing */
    }
  }

  private aggregateFlush(): ShutdownCutoff["flush"] {
    const reports = [...this.children.values()].map((child) => child.cutoff);
    if (reports.length === 0) return "ok";
    if (reports.some((cutoff) => cutoff?.flush === "failed")) return "failed";
    if (reports.every((cutoff) => cutoff?.flush === "ok")) return "ok";
    // Missing cutoff is not success. Forced-pending stays visible.
    return "pending";
  }
}

function planeOf(child: ChildRecord | undefined, kind: "sync" | "storage" | "execution"): TopologyHealth[typeof kind] {
  if (child === undefined) return { state: "starting" };
  if (child.exit !== undefined) {
    const plane = child.health[kind];
    if (plane?.state === "failed" || plane?.state === "degraded") return plane;
    return { state: "disconnected", reason: "process exited" };
  }
  return child.health[kind] ?? { state: "starting" };
}
