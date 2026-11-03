import { fail } from "@inhuman.tools/harness-diagnostics";
import { startAmbientCompact as runtimeStartAmbientCompact } from "@inhuman.tools/turn/runtime";

import { promptMessageOf } from "./prompt-message-of.js";

export { ambientCutoff, ambientKey, ambientModel } from "@inhuman.tools/turn/runtime";

export function startAmbientCompact(opts: Parameters<typeof runtimeStartAmbientCompact>[0]): Promise<void> {
  return runtimeStartAmbientCompact({
    ...opts,
    message: opts.message ?? promptMessageOf,
    diagnostics: opts.diagnostics ?? { fail },
  });
}
