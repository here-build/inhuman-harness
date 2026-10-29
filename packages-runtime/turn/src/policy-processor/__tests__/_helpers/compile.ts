/**
 * Matcher tests compile through the session intern, then drop the scope.
 * The returned Policy is plain functions over the term.
 */
import { SessionRoot } from "@inhuman.tools/harness-model";
import type { Policy, Which } from "@inhuman.tools/policy/floor";

import { LicenseScope } from "../../scope.js";

export async function compile(source: string, which?: Which): Promise<Policy> {
  const scope = new LicenseScope(
    new SessionRoot({
      sessionId: "compile",
      path: "/tmp/compile",
    }),
  );
  scope.which = which ?? (() => undefined);
  try {
    return await scope.compiledPolicy(source);
  } finally {
    scope.close();
  }
}
