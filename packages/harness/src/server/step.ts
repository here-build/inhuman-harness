import { join } from "node:path";

import { openLog as openProcessLog } from "@inhuman.tools/harness-diagnostics";

/** Same layout as `daemonLogPath`; diagnostics must not import the SDK barrel. */
export function openLog(cwd = process.cwd()): string {
  return openProcessLog(join(cwd, "harness.log"));
}
