import type { CompactJob } from "../jobs/CompactJob.js";
import type { CompletionJob } from "../jobs/CompletionJob.js";
import type { ProgrammaticJob } from "../jobs/ProgrammaticJob.js";
import type { ToolCallJob } from "../jobs/ToolCallJob.js";
import type { SessionSystemPrompt } from "../SessionSystemPrompt.js";
import type { TurnApprovalNoteChunk } from "./approval-note-chunk.js";
import type { TurnNotificationChunk } from "./notification-chunk.js";
import type { TurnPromptChunk } from "./prompt-chunk.js";
import type { ReACTChunk } from "./react-chunk.js";
import type { SessionTurn } from "./session-turn.js";
import type { TurnSteerChunk } from "./steer-chunk.js";

/**
 * Mixed tape rows on `doneWork`/`queue`. `Job.children` is the Jobs only:
 * completion, tool, program, and `CompactJob` (the turn loop runs it;
 * nothing else executes it). Prompt/steer/notify/approval-note/ReACT
 * are not children.
 */
export type TurnChunk =
  | CompletionJob
  | ToolCallJob
  | ProgrammaticJob
  | CompactJob
  | TurnPromptChunk
  | ReACTChunk
  | TurnNotificationChunk
  | TurnSteerChunk
  | TurnApprovalNoteChunk;

export type SessionUnit = SessionSystemPrompt | SessionTurn;
