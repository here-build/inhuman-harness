import { assessTextOnlyContinueIntern as runtimeAssessTextOnlyContinueIntern } from "@inhuman.tools/turn/runtime";

import { promptMessageOf } from "./prompt-message-of.js";

export {
  clipSpeech,
  INTERN_SYSTEM,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_SPEECH_CHARS,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_TIMEOUT_MS,
  THOUGHT_WITHOUT_ANSWER_STREAK_MAX,
  verdictOf,
  type ReActLoopIntentDetectedTriggerVerdict,
  RE_ACT_LOOP_INTENT_DETECTED_TRIGGER_NOTE,
  THOUGHT_CONTINUE_NOTE,
  LENGTH_CONTINUE_NOTE,
  type InternJudgeWire,
  internJudgeWire,
  questionLineFromSpeech,
  thoughtWithoutAnswer,
  type ReActLoopIntentDetectedTriggerComplete,
} from "@inhuman.tools/turn/runtime";

export function assessTextOnlyContinueIntern(
  opts: Parameters<typeof runtimeAssessTextOnlyContinueIntern>[0],
): ReturnType<typeof runtimeAssessTextOnlyContinueIntern> {
  return runtimeAssessTextOnlyContinueIntern({ ...opts, message: opts.message ?? promptMessageOf });
}
