/**
 * Stdio child isolation: env never spreads process.env; cwd is ConnectionSpec.cwd;
 * stderr pipe drain + child death leaves no live client.
 */
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { McpStdioDriverConnection } from "../stdio-driver.js";

const live: McpStdioDriverConnection[] = [];

afterEach(async () => {
  await Promise.all(live.splice(0).map((connection) => connection[Symbol.asyncDispose]()));
});

type Probe = {
  hasMarker: boolean;
  hasPath: boolean;
  keyCount: number;
  cwd: string;
  FWD: string | null;
  BAZ: string | null;
  TOKEN: string | null;
  env_TOKEN: string | null;
};

function probeScript(marker: string): string {
  return `
    const keys = Object.keys(process.env);
    process.stderr.write(JSON.stringify({
      hasMarker: keys.includes(${JSON.stringify(marker)}),
      hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
      keyCount: keys.length,
      cwd: process.cwd(),
      FWD: process.env.HARNESS_MCP_FWD ?? null,
      BAZ: process.env.HARNESS_MCP_BAZ ?? null,
      TOKEN: process.env.TOKEN ?? null,
      env_TOKEN: process.env.env_TOKEN ?? null,
    }) + "\\n");
    process.exit(0);
  `;
}

function parseProbe(error: unknown): Probe {
  const message = error instanceof Error ? error.message : String(error);
  const line = message.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line) as Probe;
  } catch {
    throw new Error(`probe did not print JSON: ${message}`);
  }
}

async function spawnProbe(
  settings: Record<string, unknown>,
  secrets?: Record<string, string>,
  marker = "HARNESS_MCP_BARREL_UNUSED",
): Promise<Probe> {
  const connection = new McpStdioDriverConnection(
    "probe",
    {
      command: process.execPath,
      args: ["-e", probeScript(marker)],
      ...settings,
    },
    secrets,
  );
  live.push(connection);
  return parseProbe(
    await connection.bootstrap().then(
      () => new Error("unexpected connect success"),
      (error: unknown) => error,
    ),
  );
}

it("stdio child isolation", async () => {
  const marker = `HARNESS_MCP_BARREL_${Date.now()}`;
  const specCwd = await mkdtemp(path.join(os.tmpdir(), "mcp-cfg-cwd-"));
  const decoy = await mkdtemp(path.join(os.tmpdir(), "mcp-session-path-"));
  process.env[marker] = "leaked";
  process.env.HARNESS_MCP_FWD = "forwarded";
  process.env.HARNESS_MCP_BAZ = "barrel";
  try {
    const isolated = await spawnProbe(
      { cwd: specCwd, envForward: ["HARNESS_MCP_FWD"] },
      { env_TOKEN: "secret-token" },
      marker,
    );
    const inherited = await spawnProbe({});
    expect({
      isolated: {
        hasMarker: isolated.hasMarker,
        hasPath: isolated.hasPath,
        keyCountBounded: isolated.keyCount < 25,
        cwd: realpathSync(isolated.cwd),
        usedDecoy: realpathSync(isolated.cwd) === realpathSync(decoy),
        FWD: isolated.FWD,
        BAZ: isolated.BAZ,
        TOKEN: isolated.TOKEN,
        env_TOKEN: isolated.env_TOKEN,
      },
      inheritedCwd: realpathSync(inherited.cwd),
    }).toEqual({
      isolated: {
        hasMarker: false,
        hasPath: true,
        keyCountBounded: true,
        cwd: realpathSync(specCwd),
        usedDecoy: false,
        FWD: "forwarded",
        BAZ: null,
        TOKEN: "secret-token",
        env_TOKEN: null,
      },
      inheritedCwd: realpathSync(process.cwd()),
    });

    const started = Date.now();
    const dying = new McpStdioDriverConnection("noise-death", {
      command: process.execPath,
      args: [
        "-e",
        `
          process.stderr.write(Buffer.alloc(80 * 1024, 0x61));
          process.stderr.write("\\nNOISE_DONE\\n");
          setTimeout(() => process.exit(1), 50);
        `,
      ],
    });
    live.push(dying);
    await dying.bootstrap().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect({
      hung: Date.now() - started >= 5_000,
      client: dying.client,
    }).toEqual({
      hung: false,
      client: null,
    });
  } finally {
    delete process.env[marker];
    delete process.env.HARNESS_MCP_FWD;
    delete process.env.HARNESS_MCP_BAZ;
    await rm(specCwd, { recursive: true, force: true });
    await rm(decoy, { recursive: true, force: true });
  }
}, 15_000);
