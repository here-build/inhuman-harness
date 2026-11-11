import {
  FileRuntimeLimitError,
  type FileEnvironment,
  type ExecutionEvent,
  type ExecutionLimits,
  type FileSandbox,
  type GuestInput,
  type SandboxExecutor,
} from "./contracts.js";

const GUEST_ENV_KEYS = [
  "READABLE_STREAM",
  "NODE_DEBUG",
  "NODE_ENV",
  "GRACEFUL_FS_PLATFORM",
  "TEST_GRACEFUL_FS_GLOBAL_PATCH",
  "BLUEBIRD_DEBUG",
  "BLUEBIRD_WARNINGS",
  "BLUEBIRD_LONG_STACK_TRACES",
  "BLUEBIRD_W_FORGOTTEN_RETURN",
];

/** The user program receives only guest paths; host paths and credentials never enter its source. */
export function guestProgram(code: string): string {
  return `const inputs = JSON.parse(await Deno.readTextFile("/work/inputs.json"));
const outputDir = "/outputs";
const value = await (async () => {\n${code}\n})();
await Deno.writeTextFile("/outputs/.result.json", JSON.stringify(value === undefined ? null : value));
`;
}

export class MicrosandboxExecutor implements SandboxExecutor {
  async start(name: string, environment: FileEnvironment, limits: ExecutionLimits): Promise<FileSandbox> {
    // Lazy: discovery and disabled installations do not load a native addon or boot a VM.
    const { Sandbox, defaultBackendKind } = await import("microsandbox");
    if (defaultBackendKind() !== "local")
      throw new Error(
        "This executor requires the local Microsandbox backend. Configure MSB_BACKEND=local on the execution server; cloud routing is not enabled by this plugin.",
      );
    const sandbox = await Sandbox.builder(name)
      .image(environment.image)
      .rootDisk(limits.diskMiB)
      .cpus(limits.cpus)
      .memory(limits.memoryMiB)
      .disableNetwork()
      .security("restricted")
      .deploymentProfile("multi-tenant")
      .label("inhuman", "file-runtime")
      .user("1000:1000")
      .maxDuration(Math.ceil(limits.timeoutMs / 1000) + 10)
      .rlimit("nofile", 128)
      .rlimit("nproc", 64)
      .rlimit("fsize", limits.outputBytes)
      .rlimit("core", 0)
      .patch((patch) =>
        patch.mkdir("/inputs", { mode: 0o755 }).mkdir("/work", { mode: 0o755 }).mkdir("/outputs", { mode: 0o777 }),
      )
      .create();
    const fs = sandbox.fs();
    return {
      write: (path, bytes) => fs.write(path, bytes),
      async read(path, maxBytes) {
        const stat = await fs.stat(path);
        if (stat.kind !== "file")
          throw new Error(`The output ${path} is not a regular file. Write a regular file in outputDir and retry.`);
        if (stat.size > maxBytes)
          throw new FileRuntimeLimitError(
            `The output ${path} exceeds the remaining ${maxBytes}-byte budget. Produce a smaller file and retry.`,
          );
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const stream = await fs.readStream(path);
        try {
          for await (const chunk of stream) {
            bytes += chunk.byteLength;
            if (bytes > maxBytes)
              throw new FileRuntimeLimitError(
                `The output ${path} grew beyond its byte budget. Produce a smaller file and retry.`,
              );
            chunks.push(chunk);
          }
        } finally {
          await stream[Symbol.asyncDispose]();
        }
        return Buffer.concat(chunks, bytes);
      },
      async *execute(code: string, inputs: readonly GuestInput[]): AsyncIterable<ExecutionEvent> {
        await fs.write("/work/inputs.json", JSON.stringify(inputs));
        await fs.write("/work/code.ts", guestProgram(code));
        const execution = await sandbox.execStreamWith("deno", (options) =>
          options
            .args([
              "run",
              "--no-prompt",
              "--cached-only",
              "--frozen",
              "--config=/runtime/deno.json",
              "--deny-net",
              `--allow-env=${GUEST_ENV_KEYS.join(",")}`,
              "--deny-run",
              "--deny-ffi",
              "--allow-read=/inputs,/work,/runtime,/outputs",
              "--allow-write=/outputs",
              "/work/code.ts",
            ])
            .cwd("/runtime")
            .timeout(limits.timeoutMs),
        );
        for await (const event of execution) {
          if (event.kind !== "started") yield event;
        }
      },
      destroy: () => sandbox.destroy({ force: true, timeoutMs: 5000 }),
    };
  }
}
