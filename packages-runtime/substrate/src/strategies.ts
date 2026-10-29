import { isToolMisuseError, renderRetryExpr } from "./doors.js";
import { synthesizeExampleCall } from "./example-call.js";
import type { ToolJsonSchema } from "./tool-schema.js";

/** The membrane metadata a rejection can carry (design doc §2.2 "where sentArgs come from",
 *  source 1) — the decoded JS args at the moment the tool's `invoke` rejected. */
export interface ArgsRejectionMetadata {
  qualifiedName: string;
  sentArgs: Record<string, unknown>;
}

/** True iff an error message is an argument/validation/kwarg/arity failure — as opposed to a
 *  tool that ran and failed on domain grounds. Default (kwargs world): `isToolMisuseError`'s
 *  `TOOL_MISUSE_SHAPES` regex family. A positional-tuple consumer (arrival-mcp) matches
 *  `z.tuple().parse()`'s error text instead, which does not overlap the kwargs shapes
 *  ("Invalid input: expected number, received…" does not match `TOOL_MISUSE_SHAPES`) —
 *  this pluggability is load-bearing, not speculative. */
export type IsMisuseErrorStrategy = (message: string) => boolean;

/** Builds a full working example call string from a tool's JSON Schema. Default (kwargs world):
 *  `synthesizeExampleCall`. A positional consumer's variant reuses the same `stubValue` logic
 *  (exported from example-call.ts) via `z.toJSONSchema()` per tuple element, which already
 *  re-emits the exact `JsonSchemaProperty` shape stub-synthesis speaks. */
export type SynthesizeExampleStrategy = (qualifiedName: string, schema: ToolJsonSchema | undefined) => string;

/** The exact retry expr for a bare tool call, or `undefined` when no faithful call exists.
 *  Default (kwargs world): `renderRetryExpr` (interleaved `:key value` kwargs). A positional
 *  consumer renders a plain argument list instead. */
export type RenderRetryExprStrategy = (
  qualifiedName: string,
  args: Record<string, unknown> | undefined,
) => string | undefined;

/** Recover a rejection's membrane metadata off the caught error object, or `undefined` when
 *  it carries none. OPTIONAL — the binder that attaches the metadata owns the read path too
 *  (arrival-manifold's `findArgsRejection` walks the evaluator's `Error.cause` wrap); a
 *  consumer without it still localizes the schema-only clue families (zod-path/own-decode/
 *  required-key) and correctly declines the sent-args-walking ones. */
export type ArgsOfErrorStrategy = (error: unknown) => ArgsRejectionMetadata | undefined;

export interface DoorStrategies {
  isMisuseError: IsMisuseErrorStrategy;
  synthesizeExample: SynthesizeExampleStrategy;
  renderRetryExpr: RenderRetryExprStrategy;
  /** Absent ⇒ no sent-args ground truth; localization runs schema-only. */
  argsOfError?: ArgsOfErrorStrategy;
}

/** Default strategies for the conventional keyword-argument tool calling shape. */
export const KWARGS_STRATEGIES: DoorStrategies = {
  isMisuseError: isToolMisuseError,
  synthesizeExample: synthesizeExampleCall,
  renderRetryExpr,
};
