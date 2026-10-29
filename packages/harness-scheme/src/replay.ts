/**
 * Rebuild one program's trace from the children on the job. The daemon does
 * not serve a graph: the same verbs run here, and a crossing reads the child
 * it stamped instead of admitting a new one.
 */
import type { EvalTrace } from "@here.build/arrival/provenance";
import { ProgrammaticJob, SCHEME_WATCH_TOOL_NAME } from "@inhuman.tools/harness-model";
import { replayEvaluation } from "@inhuman.tools/scheme-program";
import { watchHost } from "@inhuman.tools/scheme-watch";
import type { BoundTool } from "@inhuman.tools/substrate/bound-tool";
import { DoorSession } from "@inhuman.tools/substrate/doors";

import { programHostOf, type SchemeReplHost } from "./env.js";

function toolsFrom(job: ProgrammaticJob): Map<string, BoundTool> {
  const tools = new Map<string, BoundTool>();
  for (const name of Object.keys(job.boundTools)) {
    if (name === "") continue;
    tools.set(name, {
      qualifiedName: name,
      slug: "",
      tool: name,
      signature: () => ({ params: [], signatureText: name }),
    });
  }
  return tools;
}

export async function replayScheme(job: ProgrammaticJob, trace: EvalTrace, signal: AbortSignal): Promise<void> {
  const source = job.args?.source;
  const host: SchemeReplHost = {
    replayOnly: true,
    replayTools: toolsFrom(job),
    root: "",
    doors: new DoorSession(() => {}),
    signal,
    evalProgram: typeof source === "string",
    admit() {
      throw new Error("replay does not admit");
    },
    observe: (run) => run(trace),
  };
  const program = programHostOf(host);
  const watching = job.toolName === SCHEME_WATCH_TOOL_NAME ? watchHost(program) : program;
  await replayEvaluation(job, watching, trace);
}
