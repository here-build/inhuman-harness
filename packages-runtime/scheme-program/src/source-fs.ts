/**
 * Disk `require` jail. Replay never imports this: it reads `job.modules`.
 */
import { readFile, realpath } from "node:fs/promises";
import { join as posixJoin } from "node:path/posix";

import { makeFsLoader, type Loader } from "@here.build/arrival-modules";
import type { ProgrammaticJob } from "@inhuman.tools/harness-model";
import { runInAction } from "mobx";

export function programSourceLoader(root: string, job?: ProgrammaticJob): Loader {
  return makeFsLoader({
    async readFile(key: string) {
      if (job !== undefined) {
        const recorded = job.modules[key];
        if (recorded !== undefined) return recorded;
      }
      const abs = posixJoin(root, key);
      const realRoot = await realpath(root);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        throw new Error(`no such file: ${key}`);
      }
      const prefix = realRoot.endsWith("/") ? realRoot : `${realRoot}/`;
      if (real !== realRoot && !real.startsWith(prefix)) {
        throw new Error(`require path escapes program source root: ${key}`);
      }
      const text = await readFile(real, "utf8");
      if (job !== undefined) runInAction(() => (job.modules[key] = text));
      return text;
    },
  });
}
