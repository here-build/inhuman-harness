/** Not `auth.json`. That file holds the chat-model credential. */

import path from "node:path";

import { parseAcknowledge, type AckFlag } from "@inhuman.tools/policy";

export const PROGRAM_FILE = "policy-pi-authorize.scm";
export const SETTINGS_FILE = "policy-pi.json";
export const CONFIG_DIR_NAME = ".pi";

export function agentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const trimmed = env.PI_CODING_AGENT_DIR?.trim();
  return trimmed === undefined || trimmed === "" ? path.join(home, ".pi", "agent") : trimmed;
}

export function readEnabled(text: string | undefined): boolean | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !("enabled" in parsed)) {
      return undefined;
    }
    return typeof parsed.enabled === "boolean" ? parsed.enabled : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Trusted `enabled: false` skips floor blocks as well as the judge.
 * Treating the project file as tighten-only leaves a block the operator turned off.
 */
export function gateEnabled(user: boolean | undefined, project: boolean | undefined, trusted: boolean): boolean {
  if (trusted && project !== undefined) return project;
  return user ?? true;
}

/** The `acknowledge` array of a settings file. A block that does not parse throws; the gate then blocks. */
export function readAcknowledge(text: string | undefined): readonly AckFlag[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  return parseAcknowledge((parsed as Record<string, unknown>).acknowledge);
}
