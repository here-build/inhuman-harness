import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

/** A plugin program broke the surface contract. Callers match `message`. */
export class PluginSurfaceError extends ErrorWithInvariant {}

export class ExamProgramError extends Error {
  readonly owner = "exam";
  readonly tier = "explain-route";

  constructor(
    readonly phase: "capture" | "apply",
    cause: Error,
  ) {
    super(`Scheme exam program: ${cause.message}`, { cause });
    this.name = "ExamProgramError";
  }

  get code(): "exam/program-syntax" | "exam/unbound-name" {
    return this.phase === "capture" ? "exam/program-syntax" : "exam/unbound-name";
  }
}
