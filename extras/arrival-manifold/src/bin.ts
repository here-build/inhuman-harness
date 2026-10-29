#!/usr/bin/env node
// bin — CLI entrypoint: read the --config path, connect every server (stdio or http,
// dispatched by transport.ts), build the manifold server, and serve over stdin.

import { readFileSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { parseManifoldConfig, responseCharacterCapFromEnv, typeHintsModeFromEnv } from "./config.js";
import { connectServer } from "./connect.js";
import { buildManifoldServer } from "./server.js";
import { buildTransport } from "./transport.js";

export function configPathFromArgv(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--config");
  const path = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  if (path === undefined) {
    throw new Error("usage: arrival-manifold --config <path-to-mcpServers.json>");
  }
  return path;
}

/** `--response-character-cap <n>` — highest-precedence override of the observation
 *  budget: CLI flag > `ARRIVAL_RESPONSE_CHARACTER_CAP` env > config file's
 *  `observation.maxTotalChars` > 20k default. Non-positive-integer ⇒ loud error. */
export function responseCharacterCapFromArgv(argv: readonly string[]): number | undefined {
  const flagIndex = argv.indexOf("--response-character-cap");
  if (flagIndex === -1) return undefined;
  const raw = argv[flagIndex + 1];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--response-character-cap requires a positive integer argument, got "${raw ?? ""}"`);
  }
  return parsed;
}

/** Orphan safety net: the MCP SDK's StdioServerTransport doesn't listen for stdin
 *  `end` (EOF), so a parent process that dies without an orderly close() (SIGKILL,
 *  OOM, abrupt exit) leaves this process running forever. This listens for EOF on
 *  stdin — the SAME signal a PR_SET_PDEATHSIG design would use, observed cross-
 *  platform. */
function exitWhenStdinCloses(): void {
  process.stdin.on("end", () => process.exit(0));
}

export async function main(argv: readonly string[]): Promise<void> {
  const configPath = configPathFromArgv(argv);
  const config = parseManifoldConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const connected = await Promise.all(config.servers.map((s) => connectServer(s.name, buildTransport(s))));
  const toolAllowlist: Record<string, readonly string[]> = {};
  for (const s of config.servers) {
    if (s.tools !== undefined) toolAllowlist[s.name] = s.tools;
  }
  const responseCharacterCap =
    responseCharacterCapFromArgv(argv) ??
    responseCharacterCapFromEnv(process.env.ARRIVAL_RESPONSE_CHARACTER_CAP) ??
    config.observation?.maxTotalChars;
  const server = await buildManifoldServer(connected, {
    timeoutMs: config.evalTimeoutMs,
    catalog: config.catalog,
    attestation: config.attestation,
    rendering: config.rendering,
    observation: responseCharacterCap === undefined ? config.observation : { maxTotalChars: responseCharacterCap },
    promptFields: config.promptFields,
    toolAllowlist: Object.keys(toolAllowlist).length > 0 ? toolAllowlist : undefined,
    typeHints: { mode: typeHintsModeFromEnv(process.env.MANIFOLD_TYPE_HINTS) ?? config.typeHints },
  });
  exitWhenStdinCloses();
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
