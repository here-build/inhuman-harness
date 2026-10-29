import type { JobResolution } from "@inhuman.tools/plexus-expectations";

import { deepFreeze, syncingText } from "../json-record.js";
import { toolOutcomeSnapSchema, type ToolOutcomeSnap } from "../schemas/tool-outcome.js";

export const EVAL_FAILURE_CODES = [
  "interaction_required",
  "policy_denied",
  "policy_error",
  "policy_unavailable",
] as const;
export type EvalFailureCode = (typeof EVAL_FAILURE_CODES)[number];

/** One tool call as a message reducer can emit. `result` is the only field that shrinks. */
export type ToolCallRepresentation = {
  readonly id: string;
  readonly name: string;
  readonly args: string;
  readonly result: string;
};

export function parseToolOutcome(json: unknown): ToolOutcomeSnap | undefined {
  const text = syncingText(json);
  if (text == null || text === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const snap = toolOutcomeSnapSchema.safeParse(parsed);
    if (!snap.success) return undefined;
    deepFreeze(snap.data);
    return snap.data;
  } catch {
    return undefined;
  }
}

/** What `await` yields for a sealed receipt. Null until the job's clock ends; no receipt fulfills `undefined`. */
export function receiptResult(
  endedAtMs: number | null,
  snap: ToolOutcomeSnap | undefined,
): JobResolution<unknown, string> | null {
  if (endedAtMs == null) return null;
  if (snap == null) return { status: "fulfilled", value: undefined };
  if (snap.ok) return { status: "fulfilled", value: "value" in snap ? snap.value : snap.text };
  if (snap.text != null && snap.text !== "") return { status: "rejected", reason: snap.text };
  if (snap.code != null && snap.code !== "") return { status: "rejected", reason: snap.code };
  return { status: "rejected", reason: "failed" };
}

/** A snapshot as one line of text: the text, else the value. */
export function outcomeText(outcome: ToolOutcomeSnap): string {
  if (typeof outcome.text === "string" && outcome.text.trim() !== "") return outcome.text;
  if (typeof outcome.value === "string") return outcome.value;
  if (outcome.value == null) return "";
  return JSON.stringify(outcome.value);
}

/**
 * A background job's result line when it completes without having posted one.
 * Its release ack is not a result, so an uncancelled job with only the ack says nothing.
 */
export function finishedText(
  job: { readonly cancelled: boolean; readonly toolCallId: string },
  snap: ToolOutcomeSnap | undefined,
  text: () => string,
): string {
  if (job.cancelled) return "cancelled";
  const value: unknown = snap?.ok === true ? snap.value : undefined;
  const ack = value != null && typeof value === "object" && (value as { job_id?: unknown }).job_id === job.toolCallId;
  return ack ? "" : text();
}
