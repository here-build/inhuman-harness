/**
 * One rendered `.prompt` call, and the host port for an isolated completion.
 * A ProgrammaticJob parents an omitted-spec AgentCallJob instead of calling the port.
 */
import type { ReasoningEffort } from "@inhuman.tools/env-capability-dotprompt";
import type { CompletionExpectation, PromptMessageRole } from "@inhuman.tools/harness-model";

/** Session/research intern port. Homed `round` is mutated in place. `responseSchemaJson` is the serialized schema, matching CompleteFields. */
export type PromptCompleteRequest = {
  readonly connectionId: string;
  readonly model: string;
  readonly promptText?: string;
  readonly responseSchemaJson?: string;
  readonly signal?: AbortSignal;
  readonly round: CompletionExpectation;
};

export type PromptComplete = (
  req: PromptCompleteRequest,
) => Promise<{ readonly text: string; readonly thought?: string; readonly thoughtKind?: string }>;

export class RenderedPrompt {
  constructor(
    public readonly model: string | null,
    public readonly reasoningEffort: ReasoningEffort | null,
    public readonly responseSchema: Record<string, unknown> | null,
    public readonly faceName: string,
    /** Null inherits the caller catalog; an empty list is an explicit empty overlay. */
    public readonly tools: readonly string[] | null,
    public readonly messages: readonly [PromptMessageRole, string][],
  ) {}
}
