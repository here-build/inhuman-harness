/** `null` on the entity means not done. Cancel is `failed`, not a fourth state. */
export type ExpectationOutcome = "successful" | "failed";

export type EndCause = "settled" | "cancel" | "crash";
