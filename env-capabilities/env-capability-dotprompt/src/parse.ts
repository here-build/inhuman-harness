/**
 * Parsed `.prompt` file. Frontmatter `output:` is lowered to JSON Schema by
 * `picoschema` from the `dotprompt` package and stored as `responseSchema`.
 * JSON text is produced where a job or completion request is written.
 * Own fields remain readable through Arrival's object membrane.
 */
import { z } from "zod";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type PromptRole = "system" | "user" | "assistant";

export type PromptSection = {
  readonly role: PromptRole;
  readonly source: string;
};

/** Named capture groups and `:meta` records. Not an array, not null. */
export const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** Same enum for frontmatter `reasoningEffort:` and a call-site `:meta`. */
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS, {
  error: ".prompt: reasoningEffort must be none, minimal, low, medium, high, xhigh, or max",
});

export class ParsedPrompt {
  constructor(
    public readonly mode: "instruct" | "chat",
    public readonly model: string | null,
    public readonly reasoningEffort: ReasoningEffort | null,
    /** Frontmatter key is `output:`. Null returns text; a schema returns parsed JSON. */
    public readonly responseSchema: Record<string, unknown> | null,
    public readonly faceName: string,
    /** Null inherits the caller catalog; an empty list is an explicit empty overlay. */
    public readonly tools: readonly string[] | null,
    public readonly sections: readonly PromptSection[],
  ) {}
}
