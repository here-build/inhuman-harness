import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  clampChars,
  CONTEXT_NEED_DESCRIPTION,
  CONTEXT_NEED_INPUT_SCHEMA,
  CONTEXT_NEED_TOOL_NAME,
  type ContextNeed,
  METADATA_SAME_ROUND_TEXT,
  normalizeContextNeed,
  normalizeMetadata,
  spokenResponseText,
  UPDATE_METADATA_DESCRIPTION,
  UPDATE_METADATA_INPUT_SCHEMA,
  UPDATE_METADATA_TOOL_NAME,
  type UpdateMetadataInput,
} from "@inhuman.tools/activity";

/** The footer slot. pi sorts statuses by key. */
export const STATUS_KEY = "activity";
export const SETTINGS_FILE = "activity-pi.json";

/** One line for the system prompt's guidelines while the tool is active. */
export const GUIDELINE =
  "Call update_metadata when the state of the session changes, in the same completion as your other tool calls, last among them.";

/** The slice of pi's extension API this package uses (earendil-works/pi `core/extensions/types.ts`). */
export type PiCtx = {
  readonly ui: {
    setStatus(key: string, text: string | undefined): void;
    setWorkingMessage(message?: string): void;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
  /** `ExtensionContext.getContextUsage()`; `tokens` is null right after a compaction. */
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  /** `ExtensionContext.compact()`: starts a compaction without awaiting it. */
  compact?(options?: {
    customInstructions?: string;
    onComplete?: (result: unknown) => void;
    onError?: (error: Error) => void;
  }): void;
};

type Part = { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string };
export type PiMessage = { readonly role: string; readonly content?: unknown };

/** A pi `Component`: lines for a width. */
export type PiComponent = { render(width: number): string[]; invalidate(): void };
export type PiTheme = { fg(color: string, text: string): string };

export type ToolResult<D = { title: string; description: string }> = {
  content: { type: "text"; text: string }[];
  details: D;
  terminate: boolean;
};

export type PiTool<P = UpdateMetadataInput, D = { title: string; description: string }> = {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
  renderShell: "self";
  executionMode: "parallel";
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: PiCtx,
  ): Promise<ToolResult<D>>;
  renderCall(args: Partial<P> | undefined, theme: PiTheme): PiComponent;
  renderResult(): PiComponent;
};

/** The slice of a `SessionEntry` this package reads (`core/session-manager.ts`). */
export type PiEntry = { readonly id?: string; readonly type: string; readonly message?: PiMessage };

export type CompactEvent = {
  readonly branchEntries: readonly PiEntry[];
  readonly preparation: { readonly firstKeptEntryId: string };
  readonly customInstructions?: string;
  readonly reason: "manual" | "threshold" | "overflow";
};

export type ContextNeedDetails = { need: ContextNeed | null };

/** Raw `context_need` arguments as pi hands them over; validated by {@link normalizeContextNeed}. */
export type ContextNeedInput = {
  min_remaining_tokens?: number;
  preserve?: { user_turns?: number; rounds?: number };
  focus?: string;
  current_phase_settled?: true;
};

export type PiHost = {
  registerTool(tool: PiTool): void;
  registerTool(tool: PiTool<ContextNeedInput, ContextNeedDetails>): void;
  setSessionName(name: string): void;
  on(event: "message_end", handler: (event: { message: PiMessage }, ctx: PiCtx) => void): unknown;
  on(event: "session_before_compact", handler: (event: CompactEvent, ctx: PiCtx) => void): unknown;
  on(
    event: "agent_end" | "agent_settled" | "session_shutdown" | "session_compact" | "session_compact_failed",
    handler: (event: unknown, ctx: PiCtx) => void,
  ): unknown;
};

export type Options = {
  readonly agentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly readFile?: (file: string) => string | undefined;
};

export function agentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const trimmed = env.PI_CODING_AGENT_DIR?.trim();
  return trimmed === undefined || trimmed === "" ? path.join(home, ".pi", "agent") : trimmed;
}

export function readEnabled(text: string | undefined): boolean {
  if (text === undefined) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "enabled" in parsed) return parsed.enabled !== false;
  } catch {
    // An unreadable settings file counts as absent.
  }
  return true;
}

function readQuietly(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** What an assistant message that issued tool calls looked like. */
type Issued = { readonly spoken: boolean; readonly alone: boolean };

/** Map each tool call id in an assistant message to how its message looked. */
export function issuedCalls(message: PiMessage): Map<string, Issued> {
  const out = new Map<string, Issued>();
  if (message.role !== "assistant" || !Array.isArray(message.content)) return out;
  const parts = message.content as Part[];
  const calls = parts.filter((part) => part.type === "toolCall" && typeof part.id === "string");
  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  const spoken = spokenResponseText(text) !== "";
  const alone = calls.every((call) => call.name === UPDATE_METADATA_TOOL_NAME);
  for (const call of calls) out.set(call.id as string, { spoken, alone });
  return out;
}

const ELLIPSIS = "…";

export function summaryLine(args: Partial<UpdateMetadataInput> | undefined): string {
  const title = (args?.current_turn_title ?? "").trim();
  if (title === "") return "";
  const description = (args?.current_turn_description ?? "").replaceAll(/\s+/g, " ").trim();
  return description === "" ? title : `${title} — ${description}`;
}

function line(text: string, theme: PiTheme): PiComponent {
  return {
    render: (width) => {
      if (text === "") return [];
      const fitted = [...text].length > width ? clampChars(text, Math.max(0, width - 1)) + ELLIPSIS : text;
      return [theme.fg("muted", fitted)];
    },
    invalidate: () => {},
  };
}

/** One transcript line for a (possibly still streaming) `context_need` call. */
export function contextNeedLine(args: Partial<ContextNeedInput> | undefined): string {
  if (args === undefined) return "";
  const parts: string[] = [];
  const preserve: string[] = [];
  if (typeof args.preserve?.user_turns === "number") preserve.push(`${args.preserve.user_turns} turns`);
  if (typeof args.preserve?.rounds === "number") preserve.push(`${args.preserve.rounds} rounds`);
  if (preserve.length > 0) parts.push(`keep ${preserve.join(", ")}`);
  if (typeof args.min_remaining_tokens === "number") parts.push(`need ${args.min_remaining_tokens} tokens`);
  const focus = typeof args.focus === "string" ? args.focus.replaceAll(/\s+/g, " ").trim() : "";
  if (focus !== "") parts.push(`focus ${focus}`);
  if (args.current_phase_settled === true) parts.push("phase settled");
  return parts.length === 0 ? "" : `context: ${parts.join(" · ")}`;
}

/** Recent history from `firstKeptEntryId` on: user turns and tool rounds (assistant messages with tool calls). */
export function keptHistory(
  entries: readonly PiEntry[],
  firstKeptEntryId: string,
): { kept: { userTurns: number; rounds: number }; total: { userTurns: number; rounds: number } } {
  const kept = { userTurns: 0, rounds: 0 };
  const total = { userTurns: 0, rounds: 0 };
  let inKept = false;
  for (const entry of entries) {
    if (entry.id === firstKeptEntryId) inKept = true;
    if (entry.type !== "message" || entry.message === undefined) continue;
    const isUser = entry.message.role === "user";
    const isRound =
      entry.message.role === "assistant" &&
      Array.isArray(entry.message.content) &&
      (entry.message.content as Part[]).some((part) => part.type === "toolCall");
    if (isUser) total.userTurns += 1;
    if (isRound) total.rounds += 1;
    if (inKept && isUser) kept.userTurns += 1;
    if (inKept && isRound) kept.rounds += 1;
  }
  return { kept, total };
}

/**
 * Whether the model asked for compaction now: its phase is settled, it named a
 * free-token floor, and the measured free context is below it.
 */
export function wantsCompaction(
  need: ContextNeed | null,
  usage: { tokens: number | null; contextWindow: number } | undefined,
): boolean {
  if (need?.current_phase_settled !== true || need.min_remaining_tokens === undefined) return false;
  if (usage === undefined || usage.tokens === null) return false;
  return usage.contextWindow - usage.tokens < need.min_remaining_tokens;
}

export function register(pi: PiHost, options: Options = {}): void {
  const agentDir = options.agentDir ?? agentDirectory(options.env ?? process.env, options.home ?? homedir());
  const read = options.readFile ?? readQuietly;
  if (!readEnabled(read(path.join(agentDir, SETTINGS_FILE)))) return;

  // message_end of the issuing assistant message fires before its tools run
  // (agent-loop.ts streamAssistantResponse, then executeToolCalls).
  const issued = new Map<string, Issued>();

  pi.on("message_end", (event) => {
    for (const [id, info] of issuedCalls(event.message)) issued.set(id, info);
  });

  // Latest valid context_need of this session. Cleared once a compaction has run.
  let need: ContextNeed | null = null;
  let compacting = false;

  const clearWorking = (_event: unknown, ctx: PiCtx): void => {
    try {
      ctx.ui.setWorkingMessage();
    } catch {
      // Never throw into pi.
    }
  };
  pi.on("agent_end", clearWorking);
  pi.on("session_shutdown", (_event, ctx) => {
    issued.clear();
    need = null;
    compacting = false;
    clearWorking(_event, ctx);
  });

  pi.registerTool({
    name: UPDATE_METADATA_TOOL_NAME,
    label: "Session state",
    description: UPDATE_METADATA_DESCRIPTION,
    promptSnippet: "Report the session's state: a title and a short description",
    promptGuidelines: [GUIDELINE],
    parameters: UPDATE_METADATA_INPUT_SCHEMA,
    renderShell: "self",
    executionMode: "parallel",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { title, description } = normalizeMetadata(params);
      try {
        if (title !== "") pi.setSessionName(title);
        ctx.ui.setWorkingMessage(title === "" ? undefined : title);
        ctx.ui.setStatus(STATUS_KEY, description === "" ? undefined : description);
      } catch {
        // Never throw into pi.
      }
      const info = issued.get(toolCallId);
      issued.delete(toolCallId);
      // Mirror the harness: speech ends the turn; a lone silent call earns
      // exactly one more round, with the note; beside real tools pi continues
      // by itself because those results do not terminate.
      const terminate = info?.spoken === true;
      const nudge = info !== undefined && !info.spoken && info.alone;
      return {
        content: [{ type: "text", text: nudge ? `Recorded. ${METADATA_SAME_ROUND_TEXT}` : "Recorded." }],
        details: { title, description },
        terminate,
      };
    },
    renderCall: (args, theme) => line(summaryLine(args), theme),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
  });

  const contextNeedTool: PiTool<ContextNeedInput, ContextNeedDetails> = {
    name: CONTEXT_NEED_TOOL_NAME,
    label: "Context need",
    description: CONTEXT_NEED_DESCRIPTION,
    promptSnippet: "Declare what the next stretch of work needs from context",
    promptGuidelines: [],
    parameters: CONTEXT_NEED_INPUT_SCHEMA,
    renderShell: "self",
    executionMode: "parallel",
    async execute(toolCallId, params) {
      const parsed = normalizeContextNeed(params);
      if (parsed !== null) need = parsed;
      const info = issued.get(toolCallId);
      issued.delete(toolCallId);
      // Speech ends the turn. Without speech nothing is owed: pi continues
      // by itself and no note is sent, unlike update_metadata.
      return {
        content: [{ type: "text", text: "Recorded." }],
        details: { need: parsed },
        terminate: info?.spoken === true,
      };
    },
    renderCall: (args, theme) => line(contextNeedLine(args), theme),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
  };
  pi.registerTool(contextNeedTool);

  // pi's session_before_compact result can only cancel or supply a whole
  // summary, so the need cannot steer the cut or the summary of a compaction
  // pi started itself. All that can be done here is to say what was not honoured.
  pi.on("session_before_compact", (event, ctx) => {
    if (need === null) return;
    const notes: string[] = [];
    if (need.preserve !== undefined) {
      const { kept, total } = keptHistory(event.branchEntries, event.preparation.firstKeptEntryId);
      const wantTurns = Math.min(need.preserve.user_turns ?? 0, total.userTurns);
      const wantRounds = Math.min(need.preserve.rounds ?? 0, total.rounds);
      if (kept.userTurns < wantTurns || kept.rounds < wantRounds) {
        notes.push(
          `keeps ${kept.userTurns} user turns and ${kept.rounds} rounds, ${need.preserve.user_turns ?? 0} and ${need.preserve.rounds ?? 0} were asked; pi sizes the kept tail by compaction.keepRecentTokens`,
        );
      }
    }
    if (need.focus !== undefined && event.customInstructions !== need.focus) {
      notes.push(
        "focus was not passed to the summary; pi takes summary instructions only from /compact or ctx.compact()",
      );
    }
    if (notes.length === 0) return;
    try {
      ctx.ui.notify?.(`context_need not fully honoured: ${notes.join("; ")}`, "warning");
    } catch {
      // Never throw into pi.
    }
  });

  pi.on("session_compact", () => {
    need = null;
    compacting = false;
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
  });

  // Compact on the model's word once the run has settled: calling ctx.compact()
  // from inside a tool would abort the running turn.
  pi.on("agent_settled", (event, ctx) => {
    if ((event as { aborted?: boolean } | undefined)?.aborted === true) return;
    if (compacting || ctx.compact === undefined || ctx.getContextUsage === undefined) return;
    try {
      if (!wantsCompaction(need, ctx.getContextUsage())) return;
      compacting = true;
      ctx.compact({
        ...(need?.focus === undefined ? {} : { customInstructions: need.focus }),
        onError: () => {
          // A failed or refused compaction (for example "Already compacted") ends this request.
          compacting = false;
          need = null;
        },
      });
    } catch {
      compacting = false;
    }
  });
}

export default register;
