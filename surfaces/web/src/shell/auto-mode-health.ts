import type { KernelRoot, SessionRoot } from "@inhuman.tools/harness-model";
import { classifierRoute, configuredCompletionModel } from "@inhuman.tools/harness-model/shared";

export function autoModeProblem(session: SessionRoot | undefined, kernel: KernelRoot | undefined): string | null {
  if (kernel == null || session?.autoModeProblems == null || Object.keys(session.autoModeProblems).length === 0) {
    return null;
  }
  const wire = classifierRoute(session.kvs, {
    fallback: kernel.kvs,
    configuredModel: (id) => configuredCompletionModel(id, session.kvs, kernel.kvs, kernel.connections[id]),
  });
  const problem = session.autoModeProblems[wire.key];
  return problem
    ? `Automatic approvals are unavailable. Check the configured judge connection and model. ${problem}`
    : null;
}
