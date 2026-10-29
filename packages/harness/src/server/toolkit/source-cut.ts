/**
 * Bounded source cut from live Plexus entities at bot-call acceptance.
 * Captures tool-result text before later siblings can mutate shared refs.
 */
import { createHash } from "node:crypto";

import {
  CompletionExpectation,
  owningTurn,
  SessionRoot,
  tapeCompletion,
  ToolCallJob,
  TurnApprovalNoteChunk,
  TurnNotificationChunk,
  TurnSteerChunk,
  reactChunks,
} from "@inhuman.tools/harness-model";

import { squeezeToolCall } from "@/context";

import { workspaceIdFromRoot } from "./plugin-workspace.js";

export type SourceRef = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly completionId: string;
  readonly entityId: string;
  readonly field: "prompt" | "response" | "tool-result";
  readonly start: number;
  readonly end: number;
};

export type SourceSlice = {
  readonly ref: SourceRef;
  readonly text: string;
  readonly digest: string;
};

export type SourceCut = {
  readonly version: 1;
  readonly workspaceId: string;
  readonly callerSessionId: string;
  readonly originTurnId: string;
  readonly originCompletionId: string;
  readonly invocationId: string;
  readonly callIndex: number;
  readonly slices: readonly SourceSlice[];
  readonly marker: { readonly wireName: string; readonly argsJson: string };
  readonly truncated: boolean;
  readonly digest: string;
};

const ACCEPTED_WORK_CHAR_LIMIT = 8000 * 4;
const TURN_CHAR_LIMIT = 2000 * 4;

export function sourceCutCharLimit(lifetime: "turn" | "call"): number {
  return lifetime === "turn" ? TURN_CHAR_LIMIT : ACCEPTED_WORK_CHAR_LIMIT;
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sliceText(
  ref: Omit<SourceRef, "start" | "end">,
  text: string,
  budget: { remaining: number; truncated: boolean },
): SourceSlice | null {
  if (text === "") return null;
  let body = text;
  if (body.length > budget.remaining) {
    body = body.slice(0, budget.remaining);
    budget.truncated = true;
  }
  budget.remaining -= body.length;
  return {
    ref: { ...ref, start: 0, end: body.length },
    text: body,
    digest: digestJson(body),
  };
}

function tapeIndexOf(tape: readonly unknown[], pew: CompletionExpectation): number {
  for (let i = 0; i < tape.length; i += 1) {
    const cell = tape[i];
    if (cell === pew || tapeCompletion(cell) === pew) return i;
  }
  return -1;
}

function followingToolJobs(completion: CompletionExpectation): ToolCallJob[] {
  const turn = owningTurn(completion);
  if (turn == null) return [];
  const tape = reactChunks(turn);
  const start = tapeIndexOf(tape, completion);
  if (start === -1) return [];
  const out: ToolCallJob[] = [];
  for (let index = start + 1; index < tape.length; index += 1) {
    const cell = tape[index];
    if (tapeCompletion(cell) != null) break;
    if (cell instanceof ToolCallJob) out.push(cell);
  }
  return out;
}

function appendCompletionSlices(
  root: SessionRoot,
  completion: CompletionExpectation,
  slices: SourceSlice[],
  budget: { remaining: number; truncated: boolean },
  stopBefore?: ToolCallJob,
): void {
  const turn = owningTurn(completion);
  const turnId = turn?.uuid ?? "";
  for (const cell of completion.messages) {
    if (cell instanceof TurnNotificationChunk) {
      const row = sliceText(
        {
          sessionId: root.sessionId,
          turnId,
          completionId: completion.uuid,
          entityId: cell.uuid,
          field: "prompt",
        },
        cell.notificationText(),
        budget,
      );
      if (row != null) slices.push(row);
    }
    if (cell instanceof TurnApprovalNoteChunk) {
      const row = sliceText(
        {
          sessionId: root.sessionId,
          turnId,
          completionId: completion.uuid,
          entityId: cell.uuid,
          field: "prompt",
        },
        cell.approvalNoteText(),
        budget,
      );
      if (row != null) slices.push(row);
    }
    if (cell instanceof TurnSteerChunk) {
      const row = sliceText(
        {
          sessionId: root.sessionId,
          turnId,
          completionId: completion.uuid,
          entityId: cell.uuid,
          field: "prompt",
        },
        cell.completionMessage,
        budget,
      );
      if (row != null) slices.push(row);
    }
  }
  if (completion.userPrompt !== "") {
    const row = sliceText(
      {
        sessionId: root.sessionId,
        turnId,
        completionId: completion.uuid,
        entityId: completion.uuid,
        field: "prompt",
      },
      completion.userPrompt,
      budget,
    );
    if (row != null) slices.push(row);
  }
  if (completion.responseText !== "") {
    const row = sliceText(
      {
        sessionId: root.sessionId,
        turnId,
        completionId: completion.uuid,
        entityId: completion.uuid,
        field: "response",
      },
      completion.responseText,
      budget,
    );
    if (row != null) slices.push(row);
  }
  for (const job of followingToolJobs(completion)) {
    if (stopBefore != null && job.uuid === stopBefore.uuid) break;
    const text = job.completed ? squeezeToolCall(job, "compact") : "";
    const row = sliceText(
      {
        sessionId: root.sessionId,
        turnId,
        completionId: completion.uuid,
        entityId: job.uuid,
        field: "tool-result",
      },
      text,
      budget,
    );
    if (row != null) slices.push(row);
  }
}

function callIndexOf(completion: CompletionExpectation, invocation: ToolCallJob): number {
  const jobs = followingToolJobs(completion);
  const index = jobs.findIndex((job) => job.uuid === invocation.uuid);
  return index === -1 ? jobs.length : index;
}

/** Build the authoritative source cut pinned at acceptance time. */
export function buildSourceCut(
  root: SessionRoot,
  completion: CompletionExpectation,
  invocation: ToolCallJob,
  markerWireName: string,
  args: Readonly<Record<string, unknown>> | null,
  budgetChars: number,
): SourceCut {
  const charLimit = budgetChars;
  const budget = { remaining: charLimit, truncated: false };
  const slices: SourceSlice[] = [];
  const spine = completion.spine();
  for (const prior of spine) {
    if (prior === completion) {
      appendCompletionSlices(root, prior, slices, budget, invocation);
      break;
    }
    appendCompletionSlices(root, prior, slices, budget);
    if (budget.remaining <= 0) break;
  }
  const turn = owningTurn(completion);
  return {
    version: 1,
    workspaceId: workspaceIdFromRoot(root),
    callerSessionId: root.sessionId,
    originTurnId: turn?.uuid ?? "",
    originCompletionId: completion.uuid,
    invocationId: invocation.uuid,
    callIndex: callIndexOf(completion, invocation),
    slices,
    marker: { wireName: markerWireName, argsJson: JSON.stringify(args ?? {}) },
    truncated: budget.truncated,
    digest: digestJson(slices),
  };
}
