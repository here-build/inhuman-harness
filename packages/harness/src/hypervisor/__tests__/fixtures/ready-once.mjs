// Ready on the first spawn; every later spawn hangs unready — a restart that never comes up.
import { existsSync, writeFileSync } from "node:fs";

import { runSupervisedProcess } from "../../../../dist/hypervisor/child-runtime.js";

const [marker, ...rest] = process.argv.slice(2);
const again = existsSync(marker);
writeFileSync(marker, "");
process.exit(await runSupervisedProcess({ argv: again ? [...rest, "--unready"] : rest }));
