/**
 * ProgrammaticJob body. SessionTurn waits on the bag. Not PEW and not
 * catalog `execute`.
 *
 * `runProgram` and `runWatch` own the evaluation. This builds the ProgramHost
 * — vocabulary lands on the first `prepare` — and calls one of them with the
 * job. A watch job must take `runWatch`: the first prepare wins, and only
 * that call roots meta-reactivity.
 */
import { ProgrammaticJob, SCHEME_WATCH_TOOL_NAME } from "@inhuman.tools/harness-model";
import { runProgram } from "@inhuman.tools/scheme-program";
import { programSourceLoader } from "@inhuman.tools/scheme-program/fs";
import { runWatch } from "@inhuman.tools/scheme-watch";

import { programHostOf, type SchemeReplHost } from "./env.js";

export async function interpretSchemeRepl(chunk: ProgrammaticJob, host: SchemeReplHost): Promise<void> {
  if (host.loadSource == null && host.replayOnly !== true) {
    Object.assign(host, {
      loadSource: (root: string, job: ProgrammaticJob) => programSourceLoader(root, job),
    });
  }
  const programHost = programHostOf(host);
  if (chunk.toolName === SCHEME_WATCH_TOOL_NAME) return runWatch(chunk, programHost);
  return runProgram(chunk, programHost);
}
