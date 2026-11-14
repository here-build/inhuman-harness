import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { pairId, schemaSql, tables } from "@inhuman.tools/scope-plane";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createElectricRowPlane, type ElectricSql } from "../index.js";

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
describe.skipIf(!enabled)("PostgreSQL qualification over canonical 11-table schema", () => {
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
  });

  afterAll(async () => {
    if (dir === "") return;
    try {
      if (started) await run("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects NUL-byte IDs across composite-keyed tables and supports projects/sessions CRUD", async () => {
    const table = tables.scope_nodes;
    const cols = [table.keySql, ...table.columns.map((c) => c.sql)];
    const legacyId = "convert_from(decode('726f6f74006c6567616379', 'hex'), 'UTF8')";
    await expect(
      sql.query(
        `INSERT INTO ${table.sql} (${cols.join(", ")}) VALUES (${legacyId}, 'local', 'kernel', 'n1', 'node', false, 1, '{}')`,
        [],
      ),
    ).rejects.toThrow(/invalid byte sequence for encoding "UTF8": 0x00/);

    const projectRow = {
      kernelId: "tenant-pg",
      title: "PG Project",
      kind: "remote",
      defaultPermissionMode: "manual",
      authorizationJson: "{}",
      kvsJson: "{}",
      lastUsedModelJson: "{}",
      enabledPluginsJson: "[]",
      pluginConfigsJson: "{}",
      botsRosterJson: "{}",
      trusted: true,
      revision: 1,
      updatedAtMs: 1000,
    };
    expect(await rows.insertIfAbsent("projects", "pg-proj", projectRow)).toBe(true);
    expect(await rows.insertIfAbsent("projects", "pg-proj", projectRow)).toBe(false);
    expect(await rows.get("projects", "pg-proj")).toMatchObject({ title: "PG Project", trusted: true });

    const scmId = pairId("kernel", "tenant-pg:policy/default");
    await rows.put("scm_resources", scmId, {
      kernelId: "tenant-pg",
      scope: "kernel",
      scopeId: "tenant-pg",
      kind: "policy",
      name: "default.scm",
      source: "(allow)",
      sha256: "abc",
      updatedAtMs: 1001,
    });
    expect(await rows.list("scm_resources", "kernelId", "tenant-pg")).toHaveLength(1);
    await rows.remove("scm_resources", scmId);
    expect(await rows.list("scm_resources", "kernelId", "tenant-pg")).toEqual([]);
  });
});
