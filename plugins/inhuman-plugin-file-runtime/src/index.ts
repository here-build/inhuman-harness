import { InhumanPlugin, InhumanTool, z } from "@inhuman.tools/plugin-sdk";

import {
  executionInputSchema,
  type ExecutionLimits,
  type FileEnvironment,
  type FileRuntimeHost,
  type SandboxExecutor,
} from "./contracts.js";
import { MicrosandboxExecutor } from "./microsandbox.js";
import { FileRuntime } from "./runtime.js";

export * from "./contracts.js";
export { MicrosandboxExecutor } from "./microsandbox.js";
export { FileRuntime } from "./runtime.js";
export { documentEnvironment } from "./environment.js";

export function createFileRuntimePlugin(options: {
  readonly host: FileRuntimeHost;
  readonly environments: readonly FileEnvironment[];
  readonly limits?: Partial<ExecutionLimits>;
  readonly executor?: SandboxExecutor;
}): { readonly plugin: InhumanPlugin; readonly runtime: FileRuntime } {
  const runtime = new FileRuntime(
    options.host,
    options.executor ?? new MicrosandboxExecutor(),
    options.environments,
    options.limits,
  );
  const describe = new InhumanTool({
    name: "file_runtime_describe",
    description:
      "List complex files accessible in this transcript and their configured environments, pinned revisions, libraries and limitations. Discovery does not read file contents. Files with no environment are reported explicitly.",
    class: "meta",
    representation: "both",
    input: z.object({}).strict(),
    output: z.unknown(),
    run: (_input, context) => runtime.describe(context),
  });
  const execute = new InhumanTool({
    name: "file_runtime_execute",
    description:
      "Run TypeScript in a fresh, offline Deno microVM over explicitly selected transcript file revisions. Call file_runtime_describe first. Code receives inputs (metadata and guest paths) and outputDir. Return a JSON value; write requested output files into outputDir. Only requested regular files are published, after successful execution and VM destruction. No host APIs or shell are exposed. Variables do not survive calls.",
    class: "effect",
    representation: "both",
    input: executionInputSchema,
    output: z.unknown(),
    run: (input, context) => runtime.execute(input, context),
  });
  return { plugin: new InhumanPlugin({ tools: [describe, execute] }), runtime };
}
