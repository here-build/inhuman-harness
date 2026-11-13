export type ModelArguments =
  | { readonly kind: "complete"; readonly json: string }
  | {
      readonly kind: "omitted";
      readonly ref: string;
      readonly summary: Readonly<Record<string, unknown>>;
    };

export type ModelToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: ModelArguments;
};

export const MODEL_OMISSION_GUIDANCE =
  "History abbreviation, not literal file content or executable arguments. Do not copy or replay these summaries as tool input. Original arguments remain available through context_recall; page through the full args before reusing them. If unavailable, re-read or generate actual content.";

/** Omission is metadata about arguments, never a replacement value inside them. */
export function projectModelArguments(
  args: Readonly<Record<string, unknown>>,
  ref: string,
  minChars: number,
): ModelArguments {
  const json = JSON.stringify(args);
  if (json.length < minChars) return { kind: "complete", json };
  const retained: Record<string, unknown> = {};
  const omitted: Array<{ field: string; characters: number; lines: number }> = [];
  for (const [field, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 200) {
      omitted.push({ field, characters: value.length, lines: value.split("\n").length });
    } else retained[field] = value;
  }
  return omitted.length === 0 ? { kind: "complete", json } : { kind: "omitted", ref, summary: { retained, omitted } };
}

export function modelCallSummary(
  call: ModelToolCall & { readonly arguments: Extract<ModelArguments, { kind: "omitted" }> },
): string {
  return `[Historical tool call ${call.id}: ${call.name}]\n${JSON.stringify(call.arguments.summary)}\nOriginal arguments: context_recall ${JSON.stringify({ ref: call.arguments.ref })}`;
}
