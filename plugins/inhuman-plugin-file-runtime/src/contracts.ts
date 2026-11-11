import type { ToolContext } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

export const transcriptFileSchema = z.object({
  id: z.string().min(1).max(256),
  revision: z.string().min(1).max(256),
  name: z.string().min(1).max(512),
  mime: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TranscriptFile = z.infer<typeof transcriptFileSchema>;

export const environmentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  revision: z.string().min(1).max(256),
  image: z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/, "Build and pin the runtime image by its OCI digest."),
  description: z.string().min(1).max(2000),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]+$/)).min(1),
  libraries: z.array(z.string().min(1).max(256)).max(32),
  limitations: z.array(z.string().min(1).max(512)).max(16),
});
export type FileEnvironment = Readonly<
  Omit<z.infer<typeof environmentSchema>, "extensions" | "libraries" | "limitations">
> & {
  readonly extensions: readonly string[];
  readonly libraries: readonly string[];
  readonly limitations: readonly string[];
};

export const limitsSchema = z.object({
  timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
  memoryMiB: z.number().int().min(128).max(8192).default(512),
  cpus: z.number().int().min(1).max(8).default(1),
  diskMiB: z.number().int().min(32).max(4096).default(256),
  inputBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  outputBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  logBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(64 * 1024),
  resultBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024)
    .default(64 * 1024),
  concurrency: z.number().int().min(1).max(64).default(2),
});
export type ExecutionLimits = Readonly<z.infer<typeof limitsSchema>>;

const fileSelectionSchema = transcriptFileSchema.pick({ id: true, revision: true });
const outputNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (name) => !name.startsWith(".") && !/[\\/\u0000-\u001f]/.test(name),
    "Use a plain output filename, without directories, control characters, or a leading dot.",
  );
export const executionInputSchema = z
  .object({
    environment: z.string().min(1),
    revision: z.string().min(1),
    files: z.array(fileSelectionSchema).max(8),
    code: z.string().min(1).max(100_000),
    outputs: z
      .array(z.object({ name: outputNameSchema, mime: z.string().min(1).max(256) }))
      .max(8)
      .default([]),
  })
  .superRefine((input, ctx) => {
    for (const [field, names] of [
      ["files", input.files.map((file) => file.id)],
      ["outputs", input.outputs.map((file) => file.name)],
    ] as const) {
      if (new Set(names).size !== names.length)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `Choose each ${field === "files" ? "input file" : "output filename"} once.`,
        });
    }
  });
export type ExecutionInput = z.infer<typeof executionInputSchema>;

export type OutputArtifact = {
  readonly name: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
};
export type FileProvenance = {
  readonly operationId: string;
  readonly environment: Pick<FileEnvironment, "id" | "revision" | "image">;
  readonly inputs: readonly TranscriptFile[];
  readonly codeSha256: string;
  readonly processor: "file-runtime-v1";
};

/** Bound by the host to the actual invocation; no model-supplied session identity. */
export type SessionFileAccess = {
  readonly operationId: string;
  list(signal: AbortSignal): Promise<readonly TranscriptFile[]>;
  /** Recheck current authorization and return the exact requested revision, within maxBytes. */
  read(file: TranscriptFile, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  /** Atomically publish the batch, rechecking access and quotas. Retry by operationId is idempotent. */
  publish(
    outputs: readonly OutputArtifact[],
    provenance: FileProvenance,
    signal: AbortSignal,
  ): Promise<readonly TranscriptFile[]>;
};
export type FileRuntimeHost = {
  /** Validate the invocation's identity before returning these session-bound capabilities. */
  open(context: ToolContext): Promise<SessionFileAccess>;
  /** Report a VM that could not be removed after its creation outlived cancellation. */
  cleanupFailed?(name: string, error: unknown): void;
};

export type GuestInput = TranscriptFile & { readonly path: string };
export type ExecutionEvent =
  | { readonly kind: "stdout" | "stderr"; readonly data: Uint8Array }
  | { readonly kind: "exited"; readonly code: number };
export type FileSandbox = {
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string, maxBytes: number): Promise<Uint8Array>;
  execute(code: string, inputs: readonly GuestInput[]): AsyncIterable<ExecutionEvent>;
  /** Force-stop and remove the whole VM, including descendants and private storage. */
  destroy(): Promise<void>;
};
export type SandboxExecutor = {
  start(name: string, environment: FileEnvironment, limits: ExecutionLimits): Promise<FileSandbox>;
};

export type ExecutionOutcome = {
  readonly status: "succeeded" | "program-error" | "cancelled" | "timed-out" | "limit-exceeded" | "failed" | "unknown";
  readonly operationId: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
  readonly value: unknown;
  readonly artifacts: readonly TranscriptFile[];
};

export class FileRuntimeLimitError extends Error {}
