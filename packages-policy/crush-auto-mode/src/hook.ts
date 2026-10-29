/**
 * Crush runs this as a `PreToolUse` command. It never imports the package.
 * Stdin is the hook JSON. Stdout is `{ decision: "allow" | "deny" }`.
 * `ask` is not a Crush decision. A timeout here prints deny. Crush's own timeout does not.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { structuredOutputDecideCapability } from "@inhuman.tools/env-capability-decision-structured";
import {
  acknowledgeRequirement,
  checkToolPath,
  floorVerdictOf,
  mergeAcknowledge,
  parseAcknowledgeText,
  type AckFlag,
} from "@inhuman.tools/policy";

import { evaluateCall, judgeWith, type Call, type Judge } from "./index.js";

export type HookDecision = { readonly decision: "allow" } | { readonly decision: "deny"; readonly reason: string };

const FILE_TOOLS = new Set(["edit", "write", "multiedit"]);
/** Read-side tools. Their path goes through the read floor only; a floor approve is left to Crush. */
const READ_TOOLS = new Set(["view", "ls", "grep", "glob"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hookCall(raw: unknown): { readonly kind: "skip" } | { readonly kind: "invalid" } | Call {
  if (!isRecord(raw) || typeof raw.tool_name !== "string") return { kind: "skip" };
  const input = isRecord(raw.tool_input) ? raw.tool_input : {};
  const cwd = typeof raw.cwd === "string" && raw.cwd !== "" ? raw.cwd : undefined;
  if (READ_TOOLS.has(raw.tool_name)) {
    const target = [input.file_path, input.path].find((value) => typeof value === "string" && value !== "");
    return typeof target === "string"
      ? { kind: "read", path: target, ...(cwd === undefined ? {} : { cwd }) }
      : { kind: "skip" };
  }
  if (raw.tool_name === "bash") {
    return typeof input.command === "string" && input.command !== ""
      ? { kind: "bash", command: input.command }
      : { kind: "invalid" };
  }
  if (!FILE_TOOLS.has(raw.tool_name)) return { kind: "skip" };
  return typeof input.file_path === "string" && input.file_path !== ""
    ? { kind: "write", path: input.file_path, ...(cwd === undefined ? {} : { cwd }) }
    : { kind: "invalid" };
}

function checkReadApproved(call: Extract<Call, { kind: "read" }>): boolean {
  return checkToolPath("read", call.path, call.cwd === undefined ? undefined : { cwd: call.cwd }) === "policyApprove";
}

/**
 * Crush has a host prompt, so a flagged call that would run returns no decision and Crush asks.
 * Under `--yolo` Crush asks nothing, and a hook cannot see the flag: `yolo` tells it (env `CRUSH_YOLO=1`
 * in the hook command's environment), and a flagged call is then denied rather than silently run.
 * Unverified: whether Crush honours "no decision" as "ask" for every tool.
 */
export type HookOptions = {
  readonly acknowledgeFlags?: readonly AckFlag[];
  readonly yolo?: boolean;
  /** The acknowledge config did not parse; every call is denied with this reason. */
  readonly configError?: string;
};

function readQuietly(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Flags: the user file (`POLICY_ACKNOWLEDGE_FILE`, default `~/.config/crush/policy-acknowledge.json`) and the
 * project's `.crush/policy-acknowledge.json`, as a union: the project adds and cannot remove.
 */
export function hookOptionsFromEnv(env: NodeJS.ProcessEnv, raw: string, home: string = homedir()): HookOptions {
  let cwd: string | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.cwd === "string" && parsed.cwd !== "") cwd = parsed.cwd;
  } catch {
    // runHook reports the unparseable input.
  }
  const yolo = ["1", "true"].includes(env.CRUSH_YOLO?.trim().toLowerCase() ?? "");
  try {
    const userFile =
      env.POLICY_ACKNOWLEDGE_FILE?.trim() || path.join(home, ".config", "crush", "policy-acknowledge.json");
    const flags = mergeAcknowledge(
      parseAcknowledgeText(readQuietly(userFile)),
      cwd === undefined ? [] : parseAcknowledgeText(readQuietly(path.join(cwd, ".crush", "policy-acknowledge.json"))),
    );
    return { yolo, ...(flags.length === 0 ? {} : { acknowledgeFlags: flags }) };
  } catch (error) {
    return { yolo, configError: error instanceof Error ? error.message : "invalid acknowledge config" };
  }
}

export function programSource(env: NodeJS.ProcessEnv): { readonly env?: NodeJS.ProcessEnv } {
  const trimmed = env.POLICY_AUTHORIZE?.trim();
  const file = trimmed === undefined || trimmed === "" ? undefined : trimmed;
  return file === undefined ? {} : { env: { POLICY_AUTHORIZE: file } };
}

export function structuredJudge(env: NodeJS.ProcessEnv): Judge {
  return judgeWith(structuredOutputDecideCapability, {}, programSource(env));
}

export async function decideHook(
  raw: unknown,
  judge: Judge | null,
  options?: HookOptions,
): Promise<HookDecision | undefined> {
  if (options?.configError !== undefined) return { decision: "deny", reason: options.configError };
  const decided = await decideCall(raw, judge);
  // Only a call that would run is flagged. A deny stays a deny.
  if (decided !== undefined && decided.decision === "deny") return decided;
  const flags = options?.acknowledgeFlags ?? [];
  if (flags.length === 0) return decided;
  const call = hookCall(raw);
  const verdict =
    call.kind === "bash" || call.kind === "read" || call.kind === "write" ? floorVerdictOf(call) : undefined;
  const tool = isRecord(raw) && typeof raw.tool_name === "string" ? raw.tool_name : undefined;
  const requirement = acknowledgeRequirement(flags, {
    ...(tool === undefined ? {} : { tool }),
    ...(verdict === undefined ? {} : { verdict }),
  });
  if (requirement === null) return decided;
  if (options?.yolo === true) {
    return {
      decision: "deny",
      reason: `needs acknowledgement: ${requirement.labels.join(", ")} (Crush is running with --yolo, so the host cannot ask you)`,
    };
  }
  // No decision: Crush's own permission prompt asks.
  return undefined;
}

async function decideCall(raw: unknown, judge: Judge | null): Promise<HookDecision | undefined> {
  const call = hookCall(raw);
  if (call.kind === "skip") return undefined;
  if (call.kind === "invalid") return { decision: "deny", reason: "missing command or path" };
  const verdict = await evaluateCall(call, judge);
  if (verdict === "allow") {
    // A read the floor approves is not ours to grant: leave Crush's own permission flow in charge.
    return call.kind === "read" && checkReadApproved(call) ? undefined : { decision: "allow" };
  }
  return { decision: "deny", reason: "not authorized" };
}

export async function runHook(
  raw: string,
  judge: Judge | null,
  budgetMs: number,
  options?: HookOptions,
): Promise<HookDecision | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { decision: "deny", reason: "hook input is not json" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<HookDecision>((resolve) => {
    timer = setTimeout(() => resolve({ decision: "deny", reason: "authorization timed out" }), budgetMs);
  });
  try {
    return await Promise.race([decideHook(parsed, judge, options), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
