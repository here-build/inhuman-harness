/**
 * Text-only continuation intern (A). Isolated json_schema, judge wire,
 * one shot. Fail-seal. Not remainder license. Not on ReACT tape.
 */
import {
  clipSpeech,
  INTERN_SYSTEM,
  LENGTH_CONTINUE_NOTE as CORE_LENGTH_NOTE,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE as CORE_RE_ACT_NOTE,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS,
  THOUGHT_CONTINUE_NOTE as CORE_THOUGHT_NOTE,
  THOUGHT_WITHOUT_ANSWER_STREAK_MAX,
  verdictOf,
  type ReActLoopIntentDetectedTriggerVerdict,
} from "@inhuman.tools/continuation";
import { prompt } from "@inhuman.tools/harness-commons";
import {
  CompletionExpectation,
  CompletionJob,
  flattenOverviewLine,
  GLANCE_ASK_LINE_MAX_CHARS,
  isJsonSchemaUnsupported,
  jobTriggersReactLoop,
  ProgrammaticJob,
  ReACTChunk,
  SessionTurn,
  tapeCompletion,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import {
  parseTextOnlyContinueVote,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA,
} from "@inhuman.tools/harness-model/shared";
import type { CompleteRequest, CompleteResult } from "@inhuman.tools/harness-provider-sdk";
import { splitThink } from "@inhuman.tools/tool-call-normalize";

import { promptMessageOf } from "./prompt-message-of.js";

export {
  clipSpeech,
  INTERN_SYSTEM,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_SPEECH_CHARS,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS,
  THOUGHT_WITHOUT_ANSWER_STREAK_MAX,
  verdictOf,
  type ReActLoopIntentDetectedTriggerVerdict,
} from "@inhuman.tools/continuation";

export const RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE = prompt.system`${CORE_RE_ACT_NOTE}`;

export const THOUGHT_CONTINUE_NOTE = prompt.system`${CORE_THOUGHT_NOTE}`;

export const LENGTH_CONTINUE_NOTE = prompt.system`${CORE_LENGTH_NOTE}`;

export type InternJudgeWire = {
  readonly connection: string;
  readonly model: string;
  readonly key: string;
};

export function internJudgeWire(
  kvs: Readonly<Record<string, string>>,
  fallback: Readonly<Record<string, string>>,
  configuredModel: (connectionId: string) => string,
): InternJudgeWire | null {
  const connection = (kvs.judgeConnection || fallback.judgeConnection || "").trim();
  const named = (kvs.judgeModel || fallback.judgeModel || "").trim();
  const configured = connection !== "" ? configuredModel(connection).trim() : "";
  const model = (named || configured).trim();
  if (connection === "" || model === "") return null;
  return { connection, model, key: `${connection}\n${model}` };
}

export function questionLineFromSpeech(text: string): string {
  const line = flattenOverviewLine(splitThink(text).content, GLANCE_ASK_LINE_MAX_CHARS);
  return line === "" ? "has a question" : line;
}

/**
 * A thinking channel with no spoken answer. The round has not finished.
 * Visible CoT, a think-tag that is the whole message, encrypted reasoning,
 * billed reasoning tokens, or a stamped thought kind (redacted / empty
 * thinking part) are the same event: thought without an answer.
 */
export function thoughtWithoutAnswer(pew: CompletionExpectation): boolean {
  const split = splitThink(pew.responseText);
  if (split.content.trim() !== "") return false;
  if (`${pew.responseThought}\n${split.reasoning}`.trim() !== "") return true;
  if (pew.responseReasoningEncrypted.trim() !== "") return true;
  if ((pew.reasoningTokens ?? 0) > 0) return true;
  return pew.responseThoughtKind != null;
}

/** Consecutive thought-only actor rounds on the tape, including the latest. */
export function consecutiveThoughtWithoutAnswer(turn: SessionTurn): number {
  let count = 0;
  for (let index = turn.doneWork.length - 1; index >= 0; index -= 1) {
    const cell = turn.doneWork[index];
    const pew = tapeCompletion(cell);
    if (pew != null) {
      if (pew.completionMode === "isolated") continue;
      if (!thoughtWithoutAnswer(pew)) break;
      count += 1;
      continue;
    }
    if (cell instanceof ToolCallJob && jobTriggersReactLoop(cell)) break;
    if (cell instanceof ProgrammaticJob) break;
  }
  return count;
}

export function thoughtWithoutAnswerCapped(turn: SessionTurn): boolean {
  return consecutiveThoughtWithoutAnswer(turn) > THOUGHT_WITHOUT_ANSWER_STREAK_MAX;
}

/**
 * Intern continue nudges since the last work tool. A continue after a
 * thought-only round is the thought nudge, not the intern's.
 */
export function internContinueStreak(turn: SessionTurn): number {
  let count = 0;
  let nudged = false;
  for (let index = turn.doneWork.length - 1; index >= 0; index -= 1) {
    const cell = turn.doneWork[index];
    const pew = tapeCompletion(cell);
    if (pew != null) {
      if (pew.completionMode === "isolated") continue;
      if (nudged && !thoughtWithoutAnswer(pew)) count += 1;
      nudged = false;
      continue;
    }
    if (cell instanceof ReACTChunk && cell.intentContinue) nudged = true;
    if (cell instanceof ToolCallJob && jobTriggersReactLoop(cell)) break;
    if (cell instanceof ProgrammaticJob) break;
  }
  return count;
}

export type ReActLoopIntentDetectedTriggerComplete = (req: CompleteRequest) => Promise<CompleteResult>;

export async function runTextOnlyContinueIntern(opts: {
  readonly speech: string;
  readonly wire: InternJudgeWire;
  readonly haltKeys: Set<string>;
  readonly home: SessionTurn;
  readonly complete: ReActLoopIntentDetectedTriggerComplete;
  readonly signal: AbortSignal;
}): Promise<ReActLoopIntentDetectedTriggerVerdict> {
  if (opts.haltKeys.has(opts.wire.key)) return "seal";
  const speech = clipSpeech(splitThink(opts.speech).content);
  const intern = new CompletionExpectation({
    connectionId: opts.wire.connection,
    model: opts.wire.model,
    completionMode: "isolated",
    reasoningEffort: "none",
    promptMessages: [promptMessageOf("system", INTERN_SYSTEM), promptMessageOf("user", speech)],
    responseSchema: RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_RESPONSE_SCHEMA,
  });
  const job = new CompletionJob({ expectation: intern });
  opts.home.pushChild(job);
  const internAbort = AbortSignal.any([
    opts.signal,
    AbortSignal.timeout(RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS),
  ]);
  try {
    await opts.complete({
      connectionId: opts.wire.connection,
      model: opts.wire.model,
      promptText: intern.userPrompt,
      responseSchemaJson: intern.responseSchema == null ? undefined : JSON.stringify(intern.responseSchema),
      round: intern,
      signal: internAbort,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isJsonSchemaUnsupported(message)) opts.haltKeys.add(opts.wire.key);
    if (intern.outcome == null) {
      intern.failReason = message;
      intern.fail("crash", message, "null");
    }
    return "seal";
  } finally {
    job.completed = true;
  }
  if (intern.outcome !== "successful") {
    if (intern.failReason != null && isJsonSchemaUnsupported(intern.failReason)) opts.haltKeys.add(opts.wire.key);
    return "seal";
  }
  const vote = parseTextOnlyContinueVote(intern.responseText);
  if (vote == null) return "seal";
  return verdictOf(vote);
}
