import { fail } from "@inhuman.tools/harness-diagnostics";

import { runSupervisedProcess } from "./child-runtime.js";

try {
  process.exit(await runSupervisedProcess());
} catch (error) {
  fail("supervised-child", error);
  process.exit(1);
}
