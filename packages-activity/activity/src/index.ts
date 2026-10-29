/**
 * Session state reporting. The model calls `update_metadata` to say what is
 * going on in the session: a title and a short description of the current
 * state. This is not a per-action description like a shell tool's.
 *
 * The call is cheap because it forces no extra ReAct round when the model
 * also speaks. Pure TS: no runtime dependencies, no node: imports.
 */

export const UPDATE_METADATA_TOOL_NAME = "update_metadata";
export const CONTEXT_NEED_TOOL_NAME = "context_need";

export const SESSION_TITLE_MAX_CHARS = 80;
export const SESSION_DESCRIPTION_MAX_CHARS = 400;

/** Host note when the model reported state in a round by itself, without speaking. */
export const METADATA_SAME_ROUND_TEXT =
  "Call update_metadata in the same completion as your other tool calls, last among them — not as its own round.";

/** Tool description shown to the model. */
export const UPDATE_METADATA_DESCRIPTION = `Record this turn's title and a short description. ${METADATA_SAME_ROUND_TEXT} Do not address the user.`;

export const TITLE_FIELD_DESCRIPTION = "Session-list title, one line.";
export const DESCRIPTION_FIELD_DESCRIPTION = "What this turn is doing.";

export type UpdateMetadataInput = {
  readonly current_turn_title: string;
  readonly current_turn_description?: string;
};

/** JSON Schema of {@link UpdateMetadataInput}. */
export const UPDATE_METADATA_INPUT_SCHEMA = {
  type: "object",
  properties: {
    current_turn_title: { type: "string", description: TITLE_FIELD_DESCRIPTION },
    current_turn_description: { type: "string", description: DESCRIPTION_FIELD_DESCRIPTION },
  },
  required: ["current_turn_title"],
} as const;

/**
 * Context expectation. `context_need` is a one-way signal: the model says what
 * the next stretch of work needs from working context. It does not report
 * occupancy and does not compact anything by itself.
 */
export type ContextNeedPreserve = {
  readonly user_turns?: number;
  readonly rounds?: number;
};

export type ContextNeed = {
  readonly min_remaining_tokens?: number;
  readonly preserve?: ContextNeedPreserve;
  readonly focus?: string;
  readonly current_phase_settled?: true;
};

export const CONTEXT_NEED_FOCUS_MAX_CHARS = 400;
export const CONTEXT_NEED_PRESERVE_MAX = 10_000;
export const CONTEXT_NEED_TOKENS_MAX = 100_000_000;

/** Tool description shown to the model. */
export const CONTEXT_NEED_DESCRIPTION =
  "Declare what the next stretch of work needs from working context. min_remaining_tokens is a conservative request for free tokens, not an estimate of how much context remains. preserve and focus name what should survive if the runtime reshapes older context. Set current_phase_settled when the current reasoning phase has reached a clean boundary. One-way control signal: do not wait for a result, do not infer whether context was reshaped, and do not use this tool to guess runtime capacity.";

export const CONTEXT_NEED_MIN_REMAINING_DESCRIPTION =
  "Conservative number of free tokens needed for the next stretch of work, not an estimate of tokens currently available.";
export const CONTEXT_NEED_PRESERVE_DESCRIPTION =
  "Minimum amounts of recent history to preserve if older context is reorganized.";
export const CONTEXT_NEED_USER_TURNS_DESCRIPTION = "Keep at least this many recent user turns.";
export const CONTEXT_NEED_ROUNDS_DESCRIPTION = "Keep at least this many recent tool rounds.";
export const CONTEXT_NEED_FOCUS_DESCRIPTION = "Information to emphasize if older context is reorganized.";
export const CONTEXT_NEED_SETTLED_DESCRIPTION = "Current reasoning phase reached a clean boundary.";

/** JSON Schema of the `context_need` input. */
export const CONTEXT_NEED_INPUT_SCHEMA = {
  type: "object",
  properties: {
    min_remaining_tokens: {
      type: "integer",
      minimum: 0,
      description: CONTEXT_NEED_MIN_REMAINING_DESCRIPTION,
    },
    preserve: {
      type: "object",
      properties: {
        user_turns: { type: "integer", minimum: 0, description: CONTEXT_NEED_USER_TURNS_DESCRIPTION },
        rounds: { type: "integer", minimum: 0, description: CONTEXT_NEED_ROUNDS_DESCRIPTION },
      },
      description: CONTEXT_NEED_PRESERVE_DESCRIPTION,
    },
    focus: { type: "string", description: CONTEXT_NEED_FOCUS_DESCRIPTION },
    current_phase_settled: { const: true, description: CONTEXT_NEED_SETTLED_DESCRIPTION },
  },
} as const;

function boundedInt(value: unknown, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, max);
}

/**
 * Raw call arguments to a {@link ContextNeed}, or null when they are not
 * valid. Counts clamp to their maxima, focus is trimmed and clamped, an empty
 * preserve or focus is dropped. A need must carry `min_remaining_tokens` or
 * `current_phase_settled`.
 */
export function normalizeContextNeed(raw: unknown): ContextNeed | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const min = boundedInt(rec.min_remaining_tokens, CONTEXT_NEED_TOKENS_MAX);
  if (min === null) return null;
  const settled = rec.current_phase_settled;
  if (settled !== undefined && settled !== true) return null;
  if (min === undefined && settled !== true) return null;

  let preserve: ContextNeedPreserve | undefined;
  if (rec.preserve !== undefined) {
    if (typeof rec.preserve !== "object" || rec.preserve === null || Array.isArray(rec.preserve)) return null;
    const p = rec.preserve as Record<string, unknown>;
    const turns = boundedInt(p.user_turns, CONTEXT_NEED_PRESERVE_MAX);
    const rounds = boundedInt(p.rounds, CONTEXT_NEED_PRESERVE_MAX);
    if (turns === null || rounds === null) return null;
    if (turns !== undefined || rounds !== undefined) {
      preserve = { ...(turns === undefined ? {} : { user_turns: turns }), ...(rounds === undefined ? {} : { rounds }) };
    }
  }

  let focus: string | undefined;
  if (rec.focus !== undefined) {
    if (typeof rec.focus !== "string") return null;
    const trimmed = rec.focus.trim();
    if (trimmed !== "") focus = clampChars(trimmed, CONTEXT_NEED_FOCUS_MAX_CHARS);
  }

  return {
    ...(min === undefined ? {} : { min_remaining_tokens: min }),
    ...(preserve === undefined ? {} : { preserve }),
    ...(focus === undefined ? {} : { focus }),
    ...(settled === true ? { current_phase_settled: true as const } : {}),
  };
}

/** Code-point clamp. No ellipsis. */
export function clampChars(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

/** Trim and clamp a call's input to the limits. */
export function normalizeMetadata(input: UpdateMetadataInput): { title: string; description: string } {
  return {
    title: clampChars(input.current_turn_title.trim(), SESSION_TITLE_MAX_CHARS),
    description: clampChars((input.current_turn_description ?? "").trim(), SESSION_DESCRIPTION_MAX_CHARS),
  };
}

/** Text a person would read: reasoning blocks stripped, trimmed. */
export function spokenResponseText(text: string): string {
  return text.replaceAll(/<\s*(think|thinking|reason|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").trim();
}

/** Side-channel calls that never earn a follow-up round on their own. */
const NO_FOLLOW_UP_BY_DEFAULT: ReadonlySet<string> = new Set([CONTEXT_NEED_TOOL_NAME]);

/**
 * A completion whose calls are all side-channel, with no speech, and at least
 * one that is not in `noFollowUpNames`: the host owes the model one more round.
 * Side-channel calls named in `noFollowUpNames` (by default `context_need`)
 * never ask for a follow-up on their own.
 */
export function isTitledOnlyCompletion(
  chunk: {
    readonly responseText: string;
    readonly responseCalls: readonly { readonly name: string; readonly isSideChannel?: boolean }[];
  },
  noFollowUpNames: ReadonlySet<string> = NO_FOLLOW_UP_BY_DEFAULT,
): boolean {
  if (spokenResponseText(chunk.responseText) !== "") return false;
  if (chunk.responseCalls.length === 0) return false;
  let needsFollowup = false;
  for (const call of chunk.responseCalls) {
    if (call.isSideChannel !== true) return false;
    if (!noFollowUpNames.has(call.name)) needsFollowup = true;
  }
  return needsFollowup;
}
