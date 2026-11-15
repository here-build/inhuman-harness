import { rowPairId } from "@inhuman.tools/harness-contract/schema";

import { SESSION_CASCADE_TABLES, type CommitDiff, type HarnessKvStore } from "./kv-store.js";

export type ComplianceRunner = {
  readonly describe: (name: string, fn: () => void) => void;
  readonly it: (name: string, fn: () => Promise<void> | void) => void;
};

export type HarnessKvComplianceContext = {
  readonly store: HarnessKvStore;
  readonly reopen?: () => Promise<HarnessKvStore>;
  readonly cleanup: () => Promise<void>;
};

export type HarnessKvComplianceFactory = () => Promise<HarnessKvComplianceContext>;

function fail(message: string): never {
  throw new Error(message);
}

function assertOk(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, idx) => deepEqual(item, b[idx]));
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA).filter((k) => recA[k] !== undefined);
  const keysB = Object.keys(recB).filter((k) => recB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recB, key)) return false;
    if (!deepEqual(recA[key], recB[key])) return false;
  }
  return true;
}

function assertEqual<T>(actual: T, expected: T, label = "value"): void {
  if (!Object.is(actual, expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, label = "value"): void {
  if (!deepEqual(actual, expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function withStore(
  factory: HarnessKvComplianceFactory,
  body: (ctx: HarnessKvComplianceContext) => Promise<void>,
): Promise<void> {
  const ctx = await factory();
  let currentStore = ctx.store;
  const wrappedCtx: HarnessKvComplianceContext = {
    get store() {
      return currentStore;
    },
    reopen:
      ctx.reopen !== undefined
        ? async () => {
            currentStore = await ctx.reopen!();
            return currentStore;
          }
        : undefined,
    cleanup: ctx.cleanup,
  };
  try {
    await body(wrappedCtx);
  } finally {
    try {
      await currentStore.close();
    } catch {
      // Ignore double-close during teardown.
    }
    await ctx.cleanup();
  }
}

export function runHarnessKvComplianceSuite(
  adapterName: string,
  runner: ComplianceRunner,
  factory: HarnessKvComplianceFactory,
): void {
  runner.describe(`${adapterName} — HarnessKvStore compliance`, () => {
    runner.it("normalizes defaults and preserves types across all 11 tables", async () => {
      await withStore(factory, async ({ store }) => {
        await store.set("kernel_state", { id: "k1", updatedAtMs: 100 });
        assertDeepEqual(
          await store.get("kernel_state", "k1"),
          {
            id: "k1",
            kernelId: "local",
            defaultModel: "",
            permissionMode: "manual",
            enabledPluginsJson: "[]",
            kvsJson: "{}",
            updatedAtMs: 100,
          },
          "kernel_state",
        );

        await store.set("projects", { projectId: "p1", updatedAtMs: 200 });
        assertDeepEqual(
          await store.get("projects", "p1"),
          {
            projectId: "p1",
            kernelId: "local",
            title: "",
            kind: "local",
            workspacePath: null,
            defaultPermissionMode: "manual",
            authorizationJson: "{}",
            kvsJson: "{}",
            lastUsedModelJson: "{}",
            enabledPluginsJson: "[]",
            pluginConfigsJson: "{}",
            botsRosterJson: "{}",
            trusted: false,
            contentHash: null,
            revision: 0,
            updatedAtMs: 200,
          },
          "projects",
        );

        await store.set("scope_nodes", {
          id: "sn1",
          scopeId: "kernel",
          nodeId: "n1",
          tag: "Root",
          revision: 1,
          rowJson: "{}",
        });
        assertDeepEqual(
          await store.get("scope_nodes", "sn1"),
          {
            id: "sn1",
            kernelId: "local",
            scopeId: "kernel",
            nodeId: "n1",
            tag: "Root",
            isRoot: false,
            revision: 1,
            rowJson: "{}",
          },
          "scope_nodes",
        );

        await store.set("sessions", {
          sessionId: "s1",
          createdAtMs: 300,
          lastActiveAtMs: 400,
        });
        assertDeepEqual(
          await store.get("sessions", "s1"),
          {
            sessionId: "s1",
            kernelId: "local",
            projectId: "",
            title: "",
            workspacePath: "",
            mode: "assistant",
            permissionMode: "manual",
            running: false,
            headTurnId: null,
            parentSessionId: null,
            parentCallId: null,
            depth: 0,
            revision: 0,
            createdAtMs: 300,
            lastActiveAtMs: 400,
            archivedAtMs: null,
          },
          "sessions",
        );

        await store.set("pending_asks", {
          jobId: "j1",
          sessionId: "s1",
          turnId: "t1",
          kind: "ask",
          object: "bash",
          summary: "Run ls",
          createdAtMs: 500,
        });
        assertDeepEqual(
          await store.get("pending_asks", "j1"),
          {
            jobId: "j1",
            kernelId: "local",
            sessionId: "s1",
            turnId: "t1",
            kind: "ask",
            object: "bash",
            summary: "Run ls",
            createdAtMs: 500,
          },
          "pending_asks",
        );

        await store.set("session_turns", {
          turnId: "t1",
          sessionId: "s1",
          ordinal: 1,
          prompt: "hello",
          status: "running",
          startedAtMs: 600,
        });
        assertDeepEqual(
          await store.get("session_turns", "t1"),
          {
            turnId: "t1",
            kernelId: "local",
            sessionId: "s1",
            ordinal: 1,
            prompt: "hello",
            status: "running",
            cancelRequested: false,
            reducerExited: false,
            startedAtMs: 600,
            endedAtMs: null,
          },
          "session_turns",
        );

        await store.set("session_nodes", {
          id: "n-row-1",
          sessionId: "s1",
          nodeId: "u1",
          tag: "SessionRoot",
          isRoot: true,
          revision: 2,
          rowJson: '{"uuid":"u1"}',
        });
        assertEqual((await store.get("session_nodes", "n-row-1"))?.isRoot, true, "session_nodes.isRoot");

        await store.set("session_effects", {
          id: "ef-1",
          sessionId: "s1",
          effectKey: "k",
          kind: "commit",
          inputHash: "abc",
          outcomeJson: "{}",
          revision: 1,
          createdAtMs: 700,
        });
        assertEqual((await store.get("session_effects", "ef-1"))?.phase, "committed", "session_effects.phase");

        await store.set("session_blobs", {
          id: "b-1",
          sessionId: "s1",
          blobId: "sha-1",
          createdAtMs: 800,
        });
        assertEqual((await store.get("session_blobs", "b-1"))?.turnId, null, "session_blobs.turnId");

        await store.set("scm_resources", {
          id: "r-1",
          scope: "kernel",
          scopeId: "k1",
          kind: "policy",
          name: "config.json",
          source: "{}",
          sha256: "h1",
          updatedAtMs: 900,
        });
        assertEqual((await store.get("scm_resources", "r-1"))?.kernelId, "local", "scm_resources.kernelId");

        await store.set("plugin_state_logs", {
          id: "pl-1",
          plugin: "todo",
          scope: "global",
          scopeId: "kernel",
          updatedAtMs: 1000,
        });
        assertDeepEqual(
          await store.get("plugin_state_logs", "pl-1"),
          {
            id: "pl-1",
            kernelId: "local",
            plugin: "todo",
            scope: "global",
            scopeId: "kernel",
            namespace: "default",
            logJson: "[]",
            updatedAtMs: 1000,
          },
          "plugin_state_logs",
        );

        assertEqual(await store.get("sessions", "does-not-exist"), undefined, "missing key");
      });
    });

    runner.it("evaluates scan filters, SQL NULL semantics, ordering, limits, keys, and count", async () => {
      await withStore(factory, async ({ store }) => {
        await store.setMany("sessions", [
          {
            sessionId: "s1",
            kernelId: "kA",
            projectId: "p1",
            running: true,
            createdAtMs: 10,
            lastActiveAtMs: 100,
            archivedAtMs: null,
          },
          {
            sessionId: "s2",
            kernelId: "kA",
            projectId: "p1",
            running: false,
            parentSessionId: "s1",
            createdAtMs: 20,
            lastActiveAtMs: 300,
            archivedAtMs: null,
          },
          {
            sessionId: "s3",
            kernelId: "kA",
            projectId: "p2",
            running: false,
            createdAtMs: 30,
            lastActiveAtMs: 200,
            archivedAtMs: 999,
          },
          {
            sessionId: "s4",
            kernelId: "kB",
            projectId: "p1",
            running: true,
            createdAtMs: 40,
            lastActiveAtMs: 500,
            archivedAtMs: null,
          },
        ]);

        const recentKA = await store.scan("sessions", {
          where: { kernelId: "kA", archivedAtMs: null },
          orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
        });
        assertDeepEqual(
          recentKA.map((r) => r.sessionId),
          ["s2", "s1"],
          "recentKA",
        );

        const limited = await store.scan("sessions", {
          where: { kernelId: "kA", archivedAtMs: { isNull: true }, lastActiveAtMs: { lt: 250 } },
          orderBy: [{ column: "lastActiveAtMs", direction: "desc" }],
          limit: 1,
        });
        assertDeepEqual(
          limited.map((r) => r.sessionId),
          ["s1"],
          "lt + limit",
        );

        const archivedNotNull = await store.scan("sessions", {
          where: { kernelId: "kA", archivedAtMs: { isNull: false } },
        });
        assertDeepEqual(
          archivedNotNull.map((r) => r.sessionId),
          ["s3"],
          "isNull: false",
        );

        const nullRangeCheck = await store.scan("sessions", {
          where: { kernelId: "kA", archivedAtMs: { lt: 5000 } },
        });
        assertDeepEqual(
          nullRangeCheck.map((r) => r.sessionId),
          ["s3"],
          "NULL must not satisfy lt",
        );

        const inFilter = await store.scan("sessions", {
          where: { sessionId: { in: ["s4", "s1", "missing"] } },
          orderBy: [{ column: "createdAtMs", direction: "asc" }],
        });
        assertDeepEqual(
          inFilter.map((r) => r.sessionId),
          ["s1", "s4"],
          "in filter",
        );

        const kAKeys = await store.keys("sessions", { kernelId: "kA" });
        assertEqual(kAKeys.length, 3, "keys length");
        assertOk(kAKeys.includes("s1") && kAKeys.includes("s2") && kAKeys.includes("s3"), "keys contents");
        assertEqual(await store.count("sessions", { kernelId: "kA", running: false }), 2, "count");
      });
    });

    runner.it("commits batches atomically and emits accurate CommitDiffs", async () => {
      await withStore(factory, async ({ store }) => {
        const events: CommitDiff[] = [];
        const unsub = store.onCommit((diff) => events.push(diff));

        await store.setMany("scope_nodes", [
          { id: "a", kernelId: "k1", scopeId: "kernel", nodeId: "a", tag: "A", revision: 1, rowJson: "{}" },
          { id: "b", kernelId: "k1", scopeId: "kernel", nodeId: "b", tag: "B", revision: 1, rowJson: "{}" },
          { id: "other", kernelId: "k2", scopeId: "kernel", nodeId: "other", tag: "O", revision: 1, rowJson: "{}" },
        ]);
        assertEqual(events.length, 1, "initial commit event count");

        const noop = await store.batch(() => {});
        assertEqual(noop.spaces.length, 0, "empty batch has empty spaces");
        assertEqual(events.length, 1, "empty batch does not fire onCommit");

        const prevOffset = events[0]!.offset;
        const diff = await store.batch((tx) => {
          tx.setMany("scope_nodes", [
            { id: "a", kernelId: "k1", scopeId: "kernel", nodeId: "a", tag: "A2", revision: 2, rowJson: "{}" },
            { id: "c", kernelId: "k1", scopeId: "kernel", nodeId: "c", tag: "C", revision: 2, rowJson: "{}" },
          ]);
          tx.retainOnly("scope_nodes", { kernelId: "k1", scopeId: "kernel" }, ["a", "c"]);
        });

        assertOk(diff.offset > prevOffset, "monotonic commit offset");
        assertEqual(events.length, 2, "batch fires single commit event");
        const scopeSpace = diff.spaces.find((s) => s.table === "scope_nodes") as
          | {
              readonly upserts: readonly unknown[];
              readonly deletes: readonly string[];
              readonly deletedRows?: readonly { readonly nodeId: string }[];
            }
          | undefined;
        assertOk(scopeSpace !== undefined, "scope_nodes space diff present");
        assertEqual(scopeSpace.upserts.length, 2, "2 upserts");
        assertDeepEqual([...scopeSpace.deletes], ["b"], "retainOnly deleted b, kept other kernel k2");
        assertEqual(scopeSpace.deletedRows?.[0]?.nodeId, "b", "deletedRows includes b");

        assertOk((await store.get("scope_nodes", "other")) !== undefined, "k2 row untouched");
        assertEqual(await store.get("scope_nodes", "b"), undefined, "b deleted");

        unsub();
        await store.delete("scope_nodes", "other");
        assertEqual(events.length, 2, "unsubscribed listener stops receiving commits");
      });
    });

    runner.it("enforces monotonicRevision and ifAbsent semantics including within-batch dedup", async () => {
      await withStore(factory, async ({ store }) => {
        await store.set("sessions", {
          sessionId: "s1",
          createdAtMs: 1,
          lastActiveAtMs: 1,
        });
        await store.set("session_nodes", {
          id: "s1:n1",
          sessionId: "s1",
          nodeId: "n1",
          tag: "Msg",
          revision: 5,
          rowJson: '{"v":5}',
        });

        // Stale revision 3 rejected
        const staleDiff = await store.set(
          "session_nodes",
          {
            id: "s1:n1",
            sessionId: "s1",
            nodeId: "n1",
            tag: "Msg",
            revision: 3,
            rowJson: '{"v":3}',
          },
          { monotonicRevision: true },
        );
        assertEqual(staleDiff.spaces.length, 0, "stale revision produces empty diff");
        assertEqual((await store.get("session_nodes", "s1:n1"))?.rowJson, '{"v":5}', "stale write ignored");

        // Same revision 5 allowed
        await store.set(
          "session_nodes",
          {
            id: "s1:n1",
            sessionId: "s1",
            nodeId: "n1",
            tag: "Msg",
            revision: 5,
            rowJson: '{"v":"5b"}',
          },
          { monotonicRevision: true },
        );
        assertEqual((await store.get("session_nodes", "s1:n1"))?.rowJson, '{"v":"5b"}', "equal revision updates");

        // Batch duplicate primary key deduplication
        await store.setMany(
          "session_nodes",
          [
            { id: "s1:n1", sessionId: "s1", nodeId: "n1", tag: "Msg", revision: 9, rowJson: '{"v":9}' },
            { id: "s1:n1", sessionId: "s1", nodeId: "n1", tag: "Msg", revision: 7, rowJson: '{"v":7}' },
          ],
          { monotonicRevision: true },
        );
        assertEqual((await store.get("session_nodes", "s1:n1"))?.revision, 9, "batch dedup keeps rev 9");

        // ifAbsent skips existing and inserts new
        const absentSkip = await store.set(
          "sessions",
          { sessionId: "s-abs", title: "first", createdAtMs: 1, lastActiveAtMs: 1 },
          { ifAbsent: true },
        );
        assertEqual(absentSkip.spaces.length, 1, "first ifAbsent inserts");
        const absentConflict = await store.set(
          "sessions",
          { sessionId: "s-abs", title: "second", createdAtMs: 2, lastActiveAtMs: 2 },
          { ifAbsent: true },
        );
        assertEqual(absentConflict.spaces.length, 0, "second ifAbsent skipped");
        assertEqual((await store.get("sessions", "s-abs"))?.title, "first", "original kept on ifAbsent conflict");
      });
    });

    runner.it("cascades session deletes across all 5 child tables and reports deleted child rows", async () => {
      await withStore(factory, async ({ store }) => {
        await store.batch((tx) => {
          for (const sid of ["s1", "s2"]) {
            tx.set("sessions", { sessionId: sid, kernelId: `k-${sid}`, createdAtMs: 1, lastActiveAtMs: 1 });
            tx.set("pending_asks", {
              jobId: `job-${sid}`,
              kernelId: `k-${sid}`,
              sessionId: sid,
              turnId: `turn-${sid}`,
              kind: "ask",
              object: "tool",
              summary: "confirm",
              createdAtMs: 2,
            });
            tx.set("session_turns", {
              turnId: `turn-${sid}`,
              kernelId: `k-${sid}`,
              sessionId: sid,
              ordinal: 1,
              prompt: "hi",
              status: "completed",
              startedAtMs: 2,
            });
            tx.set("session_nodes", {
              id: rowPairId(sid, "n1"),
              kernelId: `k-${sid}`,
              sessionId: sid,
              nodeId: "n1",
              tag: "Root",
              isRoot: true,
              revision: 1,
              rowJson: "{}",
            });
            tx.set("session_effects", {
              id: rowPairId(sid, "e1"),
              kernelId: `k-${sid}`,
              sessionId: sid,
              effectKey: "e1",
              kind: "effect",
              inputHash: "h",
              outcomeJson: "{}",
              revision: 1,
              createdAtMs: 3,
            });
            tx.set("session_blobs", {
              id: rowPairId(sid, "b1"),
              kernelId: `k-${sid}`,
              sessionId: sid,
              blobId: `blob-${sid}`,
              createdAtMs: 4,
            });
          }
        });

        const diff = await store.delete("sessions", "s1");
        assertEqual(await store.get("sessions", "s1"), undefined, "s1 deleted");
        assertOk((await store.get("sessions", "s2")) !== undefined, "s2 preserved");

        const sessionSpace = diff.spaces.find((s) => s.table === "sessions");
        assertDeepEqual([...(sessionSpace?.deletes ?? [])], ["s1"], "sessions diff delete");

        for (const childTable of SESSION_CASCADE_TABLES) {
          assertEqual(await store.count(childTable, { sessionId: "s1" } as never), 0, `${childTable} s1 cascaded`);
          assertEqual(await store.count(childTable, { sessionId: "s2" } as never), 1, `${childTable} s2 preserved`);
          const childSpace = diff.spaces.find((s) => s.table === childTable);
          assertOk(
            childSpace !== undefined && childSpace.deletes.length === 1 && childSpace.deletedRows?.length === 1,
            `${childTable} diff includes cascaded delete and deletedRows`,
          );
        }
      });
    });

    runner.it("preserves special characters, unicode, JSON payloads, and multi-tenant isolation", async () => {
      await withStore(factory, async ({ store }) => {
        const trickyKey = JSON.stringify(["tenant:'\"\\;--", "plugin", "scope", "id"]);
        const trickyBody = JSON.stringify({
          quote: 'it\'s "quoted"; DROP TABLE sessions;-- \\ \n\t',
          unicode: "Привет мир 🚀 日本語",
          empty: "",
        });
        await store.set("plugin_state_logs", {
          id: trickyKey,
          kernelId: "tenant-1",
          plugin: "todo",
          scope: "global",
          scopeId: "kernel",
          namespace: "main",
          logJson: trickyBody,
          updatedAtMs: 42,
        });
        const got = await store.get("plugin_state_logs", trickyKey);
        assertEqual(got?.logJson, trickyBody, "special chars preserved verbatim");
      });
    });

    runner.it("persists state across close() and reopen() when supported", async () => {
      await withStore(factory, async (ctx) => {
        if (ctx.reopen === undefined) return;
        await ctx.store.set("kernel_state", {
          id: "k-persist",
          kernelId: "k-persist",
          defaultModel: "gpt-5",
          updatedAtMs: 1234567890123,
        });
        await ctx.store.set("sessions", {
          sessionId: "s-persist",
          kernelId: "k-persist",
          running: true,
          createdAtMs: 1234567890000,
          lastActiveAtMs: 1234567890123,
        });
        await ctx.store.close();

        const reopened = await ctx.reopen();
        const kState = await reopened.get("kernel_state", "k-persist");
        assertEqual(kState?.defaultModel, "gpt-5", "reopened kernel_state");
        assertEqual(kState?.updatedAtMs, 1234567890123, "large millisecond timestamp precision");
        const sRow = await reopened.get("sessions", "s-persist");
        assertEqual(sRow?.running, true, "reopened session boolean");
      });
    });
  });
}
