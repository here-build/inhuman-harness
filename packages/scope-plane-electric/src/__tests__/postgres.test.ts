import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { schemaSql, tables, type GenerationClaim } from "@inhuman.tools/scope-plane";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createElectricRowPlane, createElectricScopePlane, type ElectricSql } from "../index.js";

const run = promisify(execFile);
const enabled = process.env.SCOPE_PLANE_POSTGRES_TEST === "1";
const booleanColumns = new Set(
  Object.values(tables).flatMap((table) =>
    table.columns.filter((column) => column.kind === "boolean").map((column) => column.sql),
  ),
);

function csv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === "," || char === "\n")) {
      record.push(field);
      field = "";
      if (char === "\n") {
        records.push(record);
        record = [];
      }
    } else field += char;
  }
  if (field !== "" || record.length > 0) records.push([...record, field]);
  return records;
}

function literal(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" && !value.includes("\0")) return `'${value.replaceAll("'", "''")}'`;
  throw new Error("unsupported test SQL parameter");
}

/** Uses an owned temporary cluster and psql, never an ambient database URL. */
describe.skipIf(!enabled)("PostgreSQL qualification (no Electric server)", () => {
  let dir = "";
  let args: string[] = [];
  let started = false;
  const sql: ElectricSql = {
    async query(text, params) {
      const statement = text.replaceAll(/\$(\d+)\b/g, (_, index: string) => literal(params[Number(index) - 1]));
      const { stdout } = await run(
        "psql",
        [...args, "--command", `SET standard_conforming_strings = on; ${statement}`],
        { encoding: "utf8", maxBuffer: 1_000_000 },
      );
      const [columns, ...records] = csv(stdout);
      if (columns == null) return [];
      return records.map((record) =>
        Object.fromEntries(
          columns.map((column, index) => {
            const value = record[index];
            return [column, value === "\\N" ? null : booleanColumns.has(column) ? value === "t" : value];
          }),
        ),
      );
    },
  };
  const shapes = { subscribe: () => () => undefined };
  const plane = createElectricScopePlane({ sql, shapes });
  const rows = createElectricRowPlane({ sql, shapes });

  beforeAll(async () => {
    dir = await mkdtemp("/tmp/scope-pg-");
    const data = join(dir, "data");
    await run("initdb", [
      "-D",
      data,
      "--auth=trust",
      "--username=scope_test",
      "--no-locale",
      "--encoding=UTF8",
      "--no-sync",
    ]);
    await run("pg_ctl", ["-D", data, "-l", join(dir, "server.log"), "-o", `-k ${dir} -h '' -p 54329`, "-w", "start"]);
    started = true;
    args = [
      "--no-psqlrc",
      "--no-password",
      "--quiet",
      "--csv",
      "--pset",
      "null=\\N",
      "--set",
      "ON_ERROR_STOP=1",
      "--host",
      dir,
      "--port",
      "54329",
      "--username",
      "scope_test",
      "--dbname",
      "postgres",
    ];
    await run("psql", [...args, "--command", schemaSql()]);
    await plane.ensureScope({ id: "root", parentId: null, path: null });
  });

  afterAll(async () => {
    if (dir === "") return;
    try {
      if (started) await run("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects the previous NUL-separated IDs in every composite-key table", async () => {
    for (const name of ["kv", "roster", "termContinue", "modelUsage", "lastUsedModel"] as const) {
      const table = tables[name];
      const columns = [table.keySql, ...table.columns.map((column) => column.sql)];
      const values = table.columns.map((column) =>
        column.name === "scopeId" ? "'root'" : column.kind === "number" ? "1" : "'legacy'",
      );
      // Construct the old bytes on the server, beyond the test parameter serializer.
      const legacyId = "convert_from(decode('726f6f74006c6567616379', 'hex'), 'UTF8')";
      await expect(
        sql.query(`INSERT INTO ${table.sql} (${columns.join(", ")}) VALUES (${[legacyId, ...values].join(", ")})`, []),
      ).rejects.toThrow(/invalid byte sequence for encoding "UTF8": 0x00/);
    }
  });

  it("updates and removes composite rows without shadows and rejects a concurrent duplicate roster name", async () => {
    await plane.ensureScope({ id: "composite", parentId: null, path: null });
    await plane.putKv("composite", "color", "blue");
    await plane.putKv("composite", "color", "red");
    await plane.putTermContinue("composite", "pane", "old");
    await plane.putTermContinue("composite", "pane", "new");
    await plane.stampModelUsage("composite", "connection/model", 1);
    await plane.stampModelUsage("composite", "connection/model", 2);
    await plane.putLastUsedModel("composite", "connection", "old");
    await plane.putLastUsedModel("composite", "connection", "new");
    expect(await plane.read("composite")).toMatchObject({
      kv: { color: "red" },
      termContinue: { pane: "new" },
      modelsUsage: { "connection/model": 2 },
      lastUsedConnectionModel: { connection: "new" },
    });
    for (const name of ["kv", "termContinue", "modelUsage", "lastUsedModel"] as const) {
      expect(await rows.list(name, "scopeId", "composite")).toHaveLength(1);
    }
    await plane.putKv("composite", "color", null);
    await plane.putTermContinue("composite", "pane", null);
    await plane.putLastUsedModel("composite", "connection", null);
    expect(await plane.read("composite")).toMatchObject({ kv: {}, termContinue: {}, lastUsedConnectionModel: {} });
    for (const name of ["kv", "termContinue", "lastUsedModel"] as const) {
      expect(await rows.list(name, "scopeId", "composite")).toEqual([]);
    }
    const inserted = await Promise.all([
      plane.insertRoster("composite", "worker", "one"),
      plane.insertRoster("composite", "worker", "two"),
    ]);
    expect(inserted.sort()).toEqual([false, true]);
    expect(await rows.list("roster", "scopeId", "composite")).toHaveLength(1);
  });

  it("uses valid text composite keys and makes concurrent absent inserts conflict-safe", async () => {
    await plane.putKv("root", "colon:quote'☃", "value");
    expect((await plane.read("root"))?.kv["colon:quote'☃"]).toBe("value");
    const won = await Promise.all([
      rows.insertIfAbsent("roster", "race", { scopeId: "root", name: "race", sessionId: "one" }),
      rows.insertIfAbsent("roster", "race", { scopeId: "root", name: "race", sessionId: "two" }),
    ]);
    expect(won.sort()).toEqual([false, true]);
    const generations = await Promise.all([
      plane.claimGeneration("race-session", "root", 0, "a"),
      plane.claimGeneration("race-session", "root", 0, "b"),
    ]);
    expect(generations.filter((generation) => generation === 1)).toHaveLength(1);
    expect(generations.filter((generation) => generation == null)).toHaveLength(1);
  });

  it("rejects a reused holder's stale token and enforces call ownership in the mutation", async () => {
    const old: GenerationClaim = { sessionId: "caller", scopeId: "root", generation: 1, holder: "worker" };
    await plane.claimGeneration("caller", "root", 0, "worker");
    expect(await plane.releaseGeneration("caller", 1, "worker")).toBe(true);
    expect(await plane.claimGeneration("caller", "root", 0, "worker")).toBe(2);
    const call = {
      callId: "call",
      scopeId: "root",
      callerSessionId: "caller",
      workerSessionId: "child",
      spec: "",
      oneShot: true,
      completed: false,
    };
    expect(await plane.writeAgentCallOwned(old, call)).toBe(false);
    const current = { ...old, generation: 2 };
    expect(await plane.writeAgentCallOwned(current, call)).toBe(true);
    await plane.claimGeneration("other", "root", 0, "worker");
    const other = { ...old, sessionId: "other" };
    expect(await plane.writeAgentCallOwned(other, { ...call, callerSessionId: "other" })).toBe(false);
    expect(await plane.removeAgentCallOwned(other, "call")).toBe(false);
    expect(await plane.releaseGeneration("caller", 1, "worker")).toBe(false);
    expect(await plane.removeAgentCallOwned(current, "call")).toBe(true);
  });

  it("rechecks ownership after a concurrent takeover releases the generation lock", async () => {
    const claim = { sessionId: "blocked", scopeId: "root", generation: 1, holder: "old" };
    await plane.claimGeneration("blocked", "root", 0, "old");
    const blocker = spawn("psql", args, { stdio: ["pipe", "pipe", "pipe"] });
    let errorText = "";
    blocker.stderr.on("data", (chunk: Buffer) => {
      errorText += chunk.toString();
    });
    const finished = new Promise<void>((resolve, reject) => {
      blocker.on("error", reject);
      blocker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(errorText))));
    });
    const locked = new Promise<void>((resolve, reject) => {
      let output = "";
      blocker.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("LOCKED")) resolve();
      });
      blocker.on("error", reject);
    });
    blocker.stdin.write(
      "BEGIN; UPDATE generations SET generation = 2, holder = 'new' WHERE session_id = 'blocked';\n\\echo LOCKED\n",
    );
    await locked;
    let ended = false;
    try {
      const writing = plane.writeAgentCallOwned(claim, {
        callId: "blocked-call",
        scopeId: "root",
        callerSessionId: "blocked",
        workerSessionId: "child",
        spec: "",
        oneShot: false,
        completed: false,
      });
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const records = await sql.query(
          "SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SET standard_conforming_strings = on; WITH ownership%'",
          [],
        );
        if (records[0]?.waiting === "1") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      blocker.stdin.end("COMMIT;\n");
      ended = true;
      await finished;
      expect(await writing).toBe(false);
      expect(await rows.get("agentCalls", "blocked-call")).toBeUndefined();
    } finally {
      if (!ended) blocker.stdin.end("ROLLBACK;\n");
      await finished;
    }
  });
});
