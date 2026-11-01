/** Authoring guidance only: caller messages are delivered without rewriting. */
export const AGENT_BRIEF_GUIDANCE =
  "Write a self-contained brief in readable sentences with normal word spacing and punctuation. " +
  "State the goal, relevant context and constraints, owned scope, and completion criteria. " +
  "Include exact paths, identifiers, and useful evidence; do not assume a new worker has the caller's history. " +
  "For a continuation, distinguish verified progress, remaining work, and the observed failure or interruption. " +
  "A timeout or exhausted budget does not establish completion or prove the worker stopped; check its current state before assigning overlapping work. " +
  "Keep briefs concise by removing repetition, not by joining words or dropping relationships. Preserve literal values and quoted user text.";

export const AGENT_STATUS_GUIDANCE =
  "Use readable sentences with normal word spacing. Report completed work with evidence, remaining work, and blockers separately. " +
  "Describe failures, interruptions, and uncertainty truthfully; a response or timeout alone is not evidence that the task succeeded.";
