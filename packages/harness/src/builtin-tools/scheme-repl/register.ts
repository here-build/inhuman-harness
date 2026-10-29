/**
 * Catalog faces for the scheme tools.
 *
 * The row is always-on so the model can issue the call. `run` is the body:
 * it reads `job` and `host` off the tool context and calls the scheme
 * package. Catalog `execute` stays unwired — the system-tool runner would
 * license this bag and seal the return value. A watch job must call
 * `runWatch`: the first `prepare` wins, and only that call roots
 * meta-reactivity.
 */
import { ProgrammaticJob, SCHEME_REPL_TOOL_NAME, SCHEME_WATCH_TOOL_NAME } from "@inhuman.tools/harness-model";
import { callArgsSchema, callResultSchema, watchArgsSchema } from "@inhuman.tools/harness-model/schemas";
import { InhumanTool, type ToolContext } from "@inhuman.tools/plugin-sdk";
import { type ProgramHost, runProgram } from "@inhuman.tools/scheme-program";
import { runWatch } from "@inhuman.tools/scheme-watch";
import { z } from "zod";

/** Snap schema, plus void: the package seals the job and returns nothing. */
const schemeRunOutput = z.union([callResultSchema, z.void()]);

function isProgramHost(value: unknown): value is ProgramHost {
  if (value === null || typeof value !== "object") return false;
  if (!("prepare" in value) || typeof value.prepare !== "function") return false;
  if (!("tools" in value) || typeof value.tools !== "function") return false;
  if (!("doors" in value) || value.doors == null || typeof value.doors !== "object") return false;
  return "root" in value && typeof value.root === "string";
}

function programCall(ctx: ToolContext): { readonly job: ProgrammaticJob; readonly host: ProgramHost } {
  const { job, host } = ctx;
  if (!(job instanceof ProgrammaticJob) || !isProgramHost(host)) {
    throw new Error("scheme program: job and host are required");
  }
  return { job, host };
}

export const schemeReplTool = new InhumanTool({
  name: SCHEME_REPL_TOOL_NAME,
  description:
    "Evaluate a Scheme program once. `description` is optional and must be one line when set — the transcript shows it in place of the program, which is only visible on expand. Omit it and the program is the collapsed row. Use scheme_watch only for requested recurring monitoring. Live bound-tool catalog is projected at list time.",
  // Fail-reducerExited: not `read`. Inner tool Work still classifies itself.
  class: "effect",
  representation: "tool",
  input: callArgsSchema,
  output: schemeRunOutput,
  run(_input, ctx) {
    const { job, host } = programCall(ctx);
    return runProgram(job, host);
  },
});

export const schemeWatchTool = new InhumanTool({
  name: SCHEME_WATCH_TOOL_NAME,
  description: `Monitor over time by re-evaluating a sandboxed Scheme program at the required period. \`description\` is optional and must be one line when set — the transcript shows it in place of the program, which is only visible on expand. Omit it and the program is the collapsed row. Use only when the user requests ongoing monitoring or repeated checks, for example watching GitHub comments for new activity. Use scheme_repl for one-shot work, including agent requests; background execution alone does not require a watcher. The harness schedules checks without a new model turn per check, saving context and tokens compared with a conversational loop.
All scheme_repl symbols, tools, calling conventions, and worker APIs are available here; see scheme_repl for their shared definitions and live catalog. Watcher-only additions:
(meta-reactivity/done-condition pred [result]) ends the watcher when pred is true. Each iteration must call it on a reachable path; quoted forms, unapplied lambdas, and unreachable branches do not count. Use a predicate matching the requested stopping condition, not constant true just to satisfy validation. For ongoing monitoring until cancelled, use #f.
(meta-reactivity/added|removed|changed list [:identity fn]) tracks differences across iterations.
Use the shared (self/notify message) to send an update without ending the watcher. For “wake me when something new appears,” notify on the event and then set the done condition true. For “keep notifying me about new comments,” notify on new events and keep the done condition false. Use background: true for notifications to arrive in the conversation while monitoring continues; inside a worker request, updates attach to that request.
Each iteration runs in a fresh Scheme scope; reactivity state persists across iterations. There is no inner-call or time limit unless maxInternalCalls or timeoutMs is set. Idle time between checks does not count. An iteration stops at its first error.`,
  class: "effect",
  representation: "tool",
  input: watchArgsSchema,
  output: schemeRunOutput,
  run(_input, ctx) {
    const { job, host } = programCall(ctx);
    return runWatch(job, host);
  },
});
