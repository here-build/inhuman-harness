import type { FinishReason } from "./types.js";

export function clampFinishIn(raw: string | null | undefined): FinishReason {
  if (raw === "length" || raw === "content_filter" || raw === "error" || raw === "aborted") {
    return raw;
  }
  if (raw === "tool_calls") return "tool_calls";
  // null, "", eos_token, function_call, tool_use, abort, unknown → stop
  if (raw === "abort" || raw === "cancelled") return "aborted";
  return "stop";
}

export function repairFinish(
  mode: "pass" | "detect" | "repair" | "strict",
  finishIn: string | null | undefined,
  toolsFound: boolean,
): FinishReason {
  const clamped = clampFinishIn(finishIn);
  if (mode === "pass" || mode === "detect") {
    return clamped;
  }
  // Terminal provider reasons win over toolsFound (audit-014 H1).
  // aborted/cancelled generation must not become tool_calls and execute mutators.
  if (clamped === "length") return "length";
  if (clamped === "content_filter" || clamped === "error" || clamped === "aborted") {
    return clamped;
  }
  if (toolsFound) return "tool_calls";
  // clamped tool_calls but no tools → stop
  return "stop";
}
