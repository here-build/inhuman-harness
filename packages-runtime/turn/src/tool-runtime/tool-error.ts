import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

/** Failure the model is meant to read and correct — never a turn-killer. */
export class ToolError extends ErrorWithInvariant {
  readonly name = "ToolError";
}
