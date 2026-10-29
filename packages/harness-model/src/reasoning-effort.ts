/**
 * Closed effort vocabulary. Owned here so the document model does not
 * depend on plugin-sdk or the dotprompt capability.
 */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Unknown, empty, and non-strings become null (omit on the wire). */
export function reasoningEffortOf(value: unknown): ReasoningEffort | null {
  return value === "none" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : null;
}
