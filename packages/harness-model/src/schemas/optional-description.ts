import { z } from "zod";

/**
 * Optional `description` on shell / scheme_repl / scheme_watch. Non-string → omitted so
 * execute cannot Zod-door. Never required. Never .max() — clamp is paint.
 */
export function optionalDescription(shownNextTo: string) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value : undefined),
    z
      .string()
      .optional()
      .describe(
        `Optional one-line summary of what this ${shownNextTo} does. Shown on the collapsed row instead of the ${shownNextTo}; the ${shownNextTo} is on expand. Omit when already obvious.`,
      ),
  );
}
