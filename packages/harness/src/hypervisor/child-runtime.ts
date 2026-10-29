import { fail, note } from "@inhuman.tools/harness-diagnostics";

import {
  publishedReadiness,
  SUPERVISION_PROTOCOL_VERSION,
  supervisionIdentitySchema,
  type PublishedHealth,
  type ServerRole,
  type ShutdownCutoff,
  type SupervisionIdentity,
} from "@/protocol/schemas";

import { readSupervisionMessages, writeSupervisionMessage } from "./ipc.js";
import { LifetimeLock } from "./lock.js";

export type SupervisedChildFlags = {
  role: ServerRole;
  identity: SupervisionIdentity;
  lockPath: string | undefined;
  lockKind: "root" | "runtime" | undefined;
  ignoreParentLoss: boolean;
  ignoreShutdown: boolean;
  unready: boolean;
};

export function parseSupervisedChildFlags(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): SupervisedChildFlags {
  const role = parseRole(flagValue(argv, "--role") ?? env.HARNESS_ROLE ?? "runtime");
  const id = flagValue(argv, "--id") ?? role;
  const identity = parseIdentity(argv, env, role, id);
  const lockPath = flagValue(argv, "--lock-path") ?? env.HARNESS_LOCK_PATH;
  const lockKindRaw = flagValue(argv, "--lock-kind") ?? env.HARNESS_LOCK_KIND ?? undefined;
  const lockKind = lockKindRaw === "root" || lockKindRaw === "runtime" ? lockKindRaw : undefined;

  return {
    role,
    identity,
    lockPath: lockPath === "" ? undefined : lockPath,
    lockKind,
    ignoreParentLoss: argv.includes("--ignore-parent-loss"),
    ignoreShutdown: argv.includes("--ignore-shutdown"),
    unready: argv.includes("--unready"),
  };
}

/** Production children start their server, then publish role readiness. */
export async function runSupervisedProcess(
  options: {
    readonly start?: (ctx: {
      readonly role: ServerRole;
      readonly identity: SupervisionIdentity;
    }) => Promise<(() => void | Promise<void | ShutdownCutoff["flush"]>) | void>;
    readonly argv?: string[];
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const flags = parseSupervisedChildFlags(argv, env);
  const { identity, role } = flags;

  let lock: LifetimeLock | undefined;
  if (flags.lockPath !== undefined && flags.lockKind !== undefined) {
    const acquired = await LifetimeLock.tryAcquire(flags.lockPath, flags.lockKind);
    if (acquired === null) {
      await writeSupervisionMessage(process.stdout, {
        v: SUPERVISION_PROTOCOL_VERSION,
        op: "failed",
        identity,
        health: healthFor(role, "failed", "lock-held"),
        reason: "lock-held",
      });
      return 1;
    }
    lock = acquired;
    note(`supervised-child lock held kind=${flags.lockKind} path=${flags.lockPath}`);
  }

  let stop: (() => void | Promise<void | ShutdownCutoff["flush"]>) | undefined;
  let started = false;
  const gate = { stopping: false };
  const shutdown = async (): Promise<void> => {
    if (gate.stopping) return;
    gate.stopping = true;
    if (flags.ignoreShutdown) return;
    let flush: ShutdownCutoff["flush"] = "ok";
    if (options.start != null && !flags.unready && !started) {
      flush = "pending";
    }
    try {
      const result = await stop?.();
      if (result === "ok" || result === "failed" || result === "pending") {
        flush = result;
      }
    } catch (error) {
      flush = "failed";
      note(`supervised-child stop ${String(error)}`);
    }
    await writeSupervisionMessage(process.stdout, {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "stopped",
      identity,
      cutoff: {
        admission: "refused",
        drain: "complete",
        flush,
        forced: false,
      },
    });
    await lock?.release();
    process.exit(0);
  };

  process.stdin.resume();
  readSupervisionMessages(
    process.stdin,
    (message) => {
      if (message.op === "shutdown") void shutdown();
    },
    (error) => {
      fail("supervised-child ipc", error);
      process.exit(1);
    },
  );

  process.stdin.on("end", () => {
    if (flags.ignoreParentLoss) return;
    void writeSupervisionMessage(process.stdout, {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "loss",
      identity,
      kind: "parent-lost",
    }).then(shutdown, (error: unknown) => {
      fail("supervised-child parent-lost", error);
      process.exit(1);
    });
  });

  process.on("SIGTERM", () => {
    void shutdown();
  });

  if (options.start != null && !flags.unready) {
    try {
      const startedStop = await options.start({ role, identity });
      if (gate.stopping) {
        try {
          await startedStop?.();
        } catch {
          /* shutting down */
        }
        return 0;
      }
      stop = startedStop ?? undefined;
      started = true;
    } catch (error) {
      if (gate.stopping) return 0;
      const reason = error instanceof Error ? error.message : String(error);
      await writeSupervisionMessage(process.stdout, {
        v: SUPERVISION_PROTOCOL_VERSION,
        op: "failed",
        identity,
        health: healthFor(role, "failed", reason),
        reason,
      });
      await lock?.release();
      return 1;
    }
  }

  if (gate.stopping) return 0;

  if (flags.unready) {
    await writeSupervisionMessage(process.stdout, {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "health",
      identity,
      health: healthFor(role, "starting"),
    });
  } else {
    await writeSupervisionMessage(process.stdout, {
      v: SUPERVISION_PROTOCOL_VERSION,
      op: "ready",
      identity,
      health: healthFor(role, "ready"),
    });
  }

  await new Promise<void>(() => {
    /* lock listen / stdin keep the isolate alive until shutdown */
  });
  return 0;
}

function parseRole(value: string): ServerRole {
  if (value === "yjs" || value === "runtime") return value;
  throw new Error(`unknown supervised child role ${value}`);
}

function parseIdentity(argv: string[], env: NodeJS.ProcessEnv, role: ServerRole, id: string): SupervisionIdentity {
  const raw = env.HARNESS_SUPERVISION_IDENTITY;
  if (raw !== undefined && raw !== "") {
    return supervisionIdentitySchema.parse(JSON.parse(raw) as unknown);
  }
  return {
    hypervisor: {
      kind: "hypervisor",
      id: flagValue(argv, "--hypervisor-id") ?? "test-hv",
    },
    process: { kind: role, id },
    serverEpoch: 1,
    runtimeGeneration: 1,
    connectionEpoch: 1,
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function healthFor(role: ServerRole, state: "ready" | "starting" | "failed", reason?: string): PublishedHealth {
  const plane = state === "failed" ? { state, reason: reason ?? "failed" } : { state };
  const health: PublishedHealth = {};
  for (const kind of publishedReadiness(role)) {
    health[kind] = plane;
  }
  return health;
}
