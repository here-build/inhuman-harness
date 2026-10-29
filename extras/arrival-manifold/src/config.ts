// config — reads the STANDARD `mcpServers` shape (Claude Desktop / Claude Code's `.mcp.json`
// convention: one object keyed by server name). No new format to learn — point this at a
// config you already have. Each entry is EITHER stdio (`command`) OR http (`url`), never
// both, never neither.

import type { TypeHintsMode } from "@inhuman.tools/substrate";
import type * as z from "zod";

import type { AttestationMode } from "./bind.js";
import { mcpServerEntry, mcpServersFile } from "./schemas/config.js";

export type ManifoldServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      tools?: string[];
    }
  | { name: string; transport: "http"; url: string; headers?: Record<string, string>; tools?: string[] };

export interface ManifoldConfig {
  servers: readonly ManifoldServerConfig[];
  evalTimeoutMs?: number;
  catalog?: { detail?: "full" | "summary"; summaryText?: string };
  attestation?: AttestationMode;
  rendering?: "braces" | "sexpr";
  observation?: { maxTotalChars?: number };
  promptFields?: { intent?: boolean; successCriteria?: boolean };
  typeHints: TypeHintsMode;
}

function toServerConfig(name: string, entry: z.infer<typeof mcpServerEntry>): ManifoldServerConfig {
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  if (hasCommand === hasUrl) {
    throw new Error(
      `invalid manifold config: mcpServers.${name} must have exactly one of "command" (stdio) or "url" (http)`,
    );
  }
  return hasCommand
    ? { name, transport: "stdio", command: entry.command!, args: entry.args, env: entry.env, tools: entry.tools }
    : { name, transport: "http", url: entry.url!, headers: entry.headers, tools: entry.tools };
}

/** Deploy-time override from `MANIFOLD_TYPE_HINTS` — applies over `config.typeHints`.
 *  Unset/empty ⇒ undefined (no override); non-mode value is a LOUD error. */
export function typeHintsModeFromEnv(raw: string | undefined): TypeHintsMode | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "off" || raw === "telemetry" || raw === "on-error") return raw;
  throw new Error(`invalid MANIFOLD_TYPE_HINTS value "${raw}" — expected "off" | "telemetry" | "on-error"`);
}

/** Deploy-time override from `ARRIVAL_RESPONSE_CHARACTER_CAP` — same precedence as
 *  `typeHintsModeFromEnv`: applies over `config.observation?.maxTotalChars`, itself
 *  overridden by a `--response-character-cap` CLI flag. */
export function responseCharacterCapFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ARRIVAL_RESPONSE_CHARACTER_CAP value "${raw}" — expected a positive integer`);
  }
  return parsed;
}

export function parseManifoldConfig(raw: unknown): ManifoldConfig {
  const result = mcpServersFile.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`invalid manifold config: ${issues}`);
  }
  const entries = Object.entries(result.data.mcpServers);
  if (entries.length === 0) {
    throw new Error("invalid manifold config: mcpServers must have at least one entry");
  }
  if (result.data.catalog?.detail === "summary" && !result.data.catalog.summaryText) {
    throw new Error('invalid manifold config: catalog.detail "summary" requires a non-empty catalog.summaryText');
  }
  return {
    servers: entries.map(([name, entry]) => toServerConfig(name, entry)),
    evalTimeoutMs: result.data.evalTimeoutMs,
    catalog: result.data.catalog,
    attestation: result.data.attestation,
    rendering: result.data.rendering,
    observation: result.data.observation,
    promptFields: result.data.promptFields,
    typeHints: result.data.typeHints ?? "telemetry",
  };
}
