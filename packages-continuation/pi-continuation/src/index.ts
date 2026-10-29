import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  decideContinuation,
  INTERN_SYSTEM,
  LENGTH_CONTINUATIONS_MAX,
  parseTextOnlyContinueVote,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS,
  verdictOf,
} from "@inhuman.tools/continuation";

export const SETTINGS_FILE = "continuation-pi.json";

/** `customType` of the nudges this extension appends. Streaks are counted from them. */
export const INTENT_TYPE = "continuation-intent";
export const THOUGHT_TYPE = "continuation-thought";
export const LENGTH_TYPE = "continuation-length";

/** Appended to INTERN_SYSTEM: pi's `complete` has no json_schema, so the shape is asked for in words. */
export const JUDGE_FORMAT = 'Reply with only a JSON object: {"intent": boolean, "awaiting_user": boolean}.';

/** The slice of pi's extension API this package uses (earendil-works/pi `core/extensions/types.ts`). */
type Part = {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly redacted?: boolean;
  readonly thinkingSignature?: string;
};
export type PiMessage = {
  readonly role: string;
  readonly content?: unknown;
  readonly stopReason?: string;
  readonly customType?: string;
};

export type PiAssistantMessage = {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly stopReason: string;
  readonly errorMessage?: string;
};

export type PiModelRegistry = {
  complete(
    model: unknown,
    context: {
      readonly systemPrompt?: string;
      readonly messages: readonly { readonly role: "user"; readonly content: string; readonly timestamp: number }[];
    },
    options?: { readonly signal?: AbortSignal },
  ): Promise<PiAssistantMessage>;
  find?(provider: string, modelId: string): unknown;
};

export type PiCtx = {
  readonly hasUI?: boolean;
  /** Pi's current model; undefined when none is selected. */
  readonly model?: unknown;
  readonly modelRegistry?: PiModelRegistry;
  readonly ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
};

export type SettleDraft = {
  readonly type: "custom_message";
  readonly customType: string;
  readonly content: string;
  readonly display: boolean;
};

export type SettleEvent = {
  readonly type: "agent_before_settle";
  readonly entries: readonly SettleDraft[];
  readonly continue: boolean;
  readonly outcome: "completed" | "aborted" | "error";
  readonly context: { readonly contextMessages: readonly PiMessage[] };
};

export type SettleResult = { entries: SettleDraft[]; continue: true } | undefined;

export type PiHost = {
  on(
    event: "agent_before_settle",
    handler: (event: SettleEvent, ctx: PiCtx) => Promise<SettleResult> | SettleResult,
  ): unknown;
};

export type Options = {
  readonly agentDir?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly readFile?: (file: string) => string | undefined;
  /** Judge deadline; defaults to the harness's 30 s. */
  readonly timeoutMs?: number;
};

export type Settings = { readonly enabled: boolean; readonly judgeModel?: string };

export function agentDirectory(env: NodeJS.ProcessEnv, home: string): string {
  const trimmed = env.PI_CODING_AGENT_DIR?.trim();
  return trimmed === undefined || trimmed === "" ? path.join(home, ".pi", "agent") : trimmed;
}

export function readSettings(text: string | undefined): Settings {
  if (text === undefined) return { enabled: true };
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return { enabled: true };
    const rec = parsed as Record<string, unknown>;
    const judge = typeof rec.judgeModel === "string" ? rec.judgeModel.trim() : "";
    return { enabled: rec.enabled !== false, ...(judge === "" ? {} : { judgeModel: judge }) };
  } catch {
    // An unreadable settings file counts as absent.
    return { enabled: true };
  }
}

function readQuietly(file: string): string | undefined {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

function parts(message: PiMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : [];
}

export function hasToolCalls(message: PiMessage): boolean {
  return parts(message).some((part) => part.type === "toolCall");
}

export function spokenText(message: PiMessage): string {
  return parts(message)
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** A thinking part (visible, redacted or encrypted) exists. */
export function hasThinking(message: PiMessage): boolean {
  return parts(message).some((part) => part.type === "thinking");
}

export type Streaks = {
  /** Intent nudges since the last work tool or user prompt. */
  readonly intent: number;
  /** Consecutive thought-only rounds, this one included. */
  readonly thought: number;
  /** Consecutive output-limit rounds, this one included. */
  readonly length: number;
};

/**
 * Streaks, counted from the context rather than kept in memory: walk back from the
 * final assistant message to the last work (an assistant message with tool calls, or a
 * tool result) or the last user message. A new prompt therefore resets everything.
 */
export function streaksOf(messages: readonly PiMessage[], last: number): Streaks {
  let intent = 0;
  let thought = 1;
  let length = 1;
  let thoughtOpen = true;
  let lengthOpen = true;
  for (let index = last - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "toolResult") break;
    if (message.role === "assistant") {
      if (hasToolCalls(message)) break;
      if (spokenText(message).trim() !== "") thoughtOpen = false;
      if (message.stopReason !== "length") lengthOpen = false;
      continue;
    }
    if (message.role !== "custom") continue;
    if (message.customType === INTENT_TYPE) intent += 1;
    else if (message.customType === THOUGHT_TYPE && thoughtOpen) thought += 1;
    else if (message.customType === LENGTH_TYPE && lengthOpen) length += 1;
  }
  return { intent, thought, length };
}

function nudge(customType: string, note: string, event: SettleEvent): SettleResult {
  return {
    entries: [...event.entries, { type: "custom_message", customType, content: note, display: false }],
    continue: true,
  };
}

function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

function judgeModelOf(settings: Settings, ctx: PiCtx, warn: (message: string) => void): unknown {
  if (settings.judgeModel === undefined) return ctx.model;
  const slash = settings.judgeModel.indexOf("/");
  const found =
    slash > 0 && ctx.modelRegistry?.find !== undefined
      ? ctx.modelRegistry.find(settings.judgeModel.slice(0, slash), settings.judgeModel.slice(slash + 1))
      : undefined;
  if (found !== undefined && found !== null) return found;
  warn(`continuation-pi: judge model "${settings.judgeModel}" not found; using the current model`);
  return ctx.model;
}

export function register(pi: PiHost, options: Options = {}): void {
  const agentDir = options.agentDir ?? agentDirectory(options.env ?? process.env, options.home ?? homedir());
  const read = options.readFile ?? readQuietly;
  const settings = readSettings(read(path.join(agentDir, SETTINGS_FILE)));
  if (!settings.enabled) return;
  const timeoutMs = options.timeoutMs ?? RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS;
  let warned = false;

  /** One small call. Anything but a clean vote seals. */
  async function judge(speech: string, ctx: PiCtx): Promise<"continue" | "question" | "seal"> {
    const registry = ctx.modelRegistry;
    if (registry === undefined) return "seal";
    const model = judgeModelOf(settings, ctx, (message) => {
      if (warned) return;
      warned = true;
      if (ctx.hasUI === true) ctx.ui?.notify(message, "warning");
    });
    if (model === undefined || model === null) return "seal";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reply = await registry.complete(
        model,
        {
          systemPrompt: `${INTERN_SYSTEM}\n\n${JUDGE_FORMAT}`,
          messages: [{ role: "user", content: speech, timestamp: Date.now() }],
        },
        { signal: controller.signal },
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") return "seal";
      const text = reply.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
      const vote = parseTextOnlyContinueVote(extractJson(text));
      return vote === null ? "seal" : verdictOf(vote);
    } finally {
      clearTimeout(timer);
    }
  }

  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      if (event.outcome !== "completed" || event.continue) return undefined;
      const messages = event.context.contextMessages;
      const last = messages.length - 1;
      const message = messages[last];
      if (message === undefined || message.role !== "assistant" || hasToolCalls(message)) return undefined;
      if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;

      const streaks = streaksOf(messages, last);
      const decision = decideContinuation({
        lengthStopped: message.stopReason === "length",
        text: spokenText(message),
        reasoned: hasThinking(message),
        lengthStreak: streaks.length,
        lengthContinuations: LENGTH_CONTINUATIONS_MAX,
        thoughtStreak: streaks.thought,
        intentStreak: streaks.intent,
      });
      if (decision.action === "settle") return undefined;
      if (decision.action === "continue") {
        return nudge(decision.reason === "length" ? LENGTH_TYPE : THOUGHT_TYPE, decision.note, event);
      }
      if (decision.speech === "") return undefined;
      const verdict = await judge(decision.speech, ctx);
      return verdict === "continue" ? nudge(INTENT_TYPE, RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE, event) : undefined;
    } catch {
      // Fail-seal: a broken check never keeps the agent running and never throws into pi.
      return undefined;
    }
  });
}

export default register;
