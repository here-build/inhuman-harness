import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";

import { SkillSpec, ToolSpec } from "../prompt-parts.js";
import { SessionSystemPrompt, type SystemPromptParts } from "../SessionSystemPrompt.js";
import { SessionSystemPromptDerivation } from "../SessionSystemPromptDerivation.js";
import { SessionTurn } from "./session-turn.js";
import type { SessionUnit } from "./types.js";

export function systemPartsOf(unit: SessionUnit): SystemPromptParts {
  return unit instanceof SessionSystemPrompt ? unit.parts() : unit.systemParts;
}

export function emitSystemPrompt(
  turn: SessionTurn,
  patch: {
    readonly reason: string;
    readonly constitution?: SystemPrompt | null;
    readonly note?: SystemPrompt;
    readonly env?: Record<string, string | null>;
    readonly tools?: readonly ToolSpec[];
    readonly skills?: readonly SkillSpec[];
  },
): SessionSystemPromptDerivation {
  const derivation = new SessionSystemPromptDerivation({
    reason: patch.reason,
    constitution: patch.constitution ?? null,
    note: patch.note ?? prompt.system``,
    env: patch.env == null ? {} : { ...patch.env },
    tools: patch.tools == null ? [] : patch.tools.map((tool) => tool.clone()),
    skills: patch.skills == null ? [] : patch.skills.map((skill) => skill.clone()),
  });
  turn.derivation = derivation;
  return derivation;
}

/**
 * Env facts that are fixed for the life of a session once the prompt has them.
 * The env block sits inside the cached prompt prefix, so a date that rolls over
 * or a branch that is switched must not rewrite it mid-session. A key the
 * session does not have yet is still adopted, once.
 */
export const SESSION_STABLE_ENV_KEYS: readonly string[] = ["date", "branch"];

/** Emit only when constitution or env packets actually differ from the inherited snapshot. */
export function refreshSystemPrompt(
  turn: SessionTurn,
  captured: { readonly constitution: SystemPrompt; readonly env: Record<string, string> },
): SessionSystemPromptDerivation | null {
  const current = systemPartsOf(turn);
  const stableEnv = { ...captured.env };
  for (const key of SESSION_STABLE_ENV_KEYS) {
    const held = current.env[key];
    if (held !== undefined && held !== "") stableEnv[key] = held;
  }
  const next = { constitution: captured.constitution, env: stableEnv };
  const constitutionChanged = current.constitution !== "" && current.constitution !== next.constitution;
  // Env overlay: keys that differ, `null` for dropped. Reason prefers cwd.
  const keys = new Set([...Object.keys(current.env), ...Object.keys(next.env)]);
  const env: Record<string, string | null> = {};
  let envChanged = false;
  for (const key of keys) {
    if (current.env[key] === next.env[key]) continue;
    env[key] = next.env[key] === undefined ? null : next.env[key];
    envChanged = true;
  }
  if (!constitutionChanged && !envChanged) return null;
  let reason = "env changed";
  if (constitutionChanged) reason = "constitution changed";
  else if ((current.env.cwd ?? "") !== (next.env.cwd ?? "")) reason = "cwd changed";
  return emitSystemPrompt(turn, {
    reason,
    constitution: constitutionChanged ? next.constitution : undefined,
    env: envChanged ? env : undefined,
  });
}
