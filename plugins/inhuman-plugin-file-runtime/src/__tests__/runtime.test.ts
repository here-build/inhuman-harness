import { describe, expect, it, vi } from "vitest";

import {
  FileRuntimeLimitError,
  type FileEnvironment,
  type FileSandbox,
  type GuestInput,
  type OutputArtifact,
  type FileProvenance,
  type ExecutionEvent,
  type TranscriptFile,
} from "../contracts.js";
import { createFileRuntimePlugin } from "../index.js";
import { FileRuntime, sha256 } from "../runtime.js";

const environment: FileEnvironment = {
  id: "documents",
  revision: "v1",
  image: `example/runtime@sha256:${"a".repeat(64)}`,
  description: "Deno, CSV/XLSX and structural PDF operations",
  extensions: [".csv", ".xlsx", ".pdf"],
  libraries: ["@std/csv@1.0.6", "exceljs@4.4.0", "pdf-lib@1.17.1"],
  limitations: ["No OCR or PDF text extraction"],
};
const source = Buffer.from("amount\n10\n20\n");
const file: TranscriptFile = {
  id: "f1",
  revision: "r1",
  name: "invoices.csv",
  mime: "text/csv",
  bytes: source.byteLength,
  sha256: sha256(source),
};
const input = {
  environment: "documents",
  revision: "v1",
  files: [{ id: "f1", revision: "r1" }],
  code: "return 30",
  outputs: [],
};

function fixture(
  options: {
    exitCode?: number;
    events?: readonly ExecutionEvent[];
    files?: readonly TranscriptFile[];
    value?: string;
  } = {},
) {
  const order: string[] = [];
  const published: { outputs: readonly OutputArtifact[]; provenance: FileProvenance }[] = [];
  const stored = new Map<string, Uint8Array>([
    ["/outputs/.result.json", Buffer.from(options.value ?? "30")],
    ["/outputs/report.csv", Buffer.from("total\n30\n")],
  ]);
  const destroy = vi.fn(async () => {
    order.push("destroy");
  });
  const execute = vi.fn(async function* (_code: string, _inputs: readonly GuestInput[]): AsyncIterable<ExecutionEvent> {
    yield* options.events ?? [
      { kind: "stdout", data: Buffer.from("done") },
      { kind: "exited", code: options.exitCode ?? 0 },
    ];
  });
  const sandbox: FileSandbox = {
    write: vi.fn(async (path, bytes) => {
      stored.set(path, bytes);
    }),
    read: vi.fn(async (path, limit) => {
      const bytes = stored.get(path);
      if (bytes === undefined) throw new Error("Output not found");
      if (bytes.byteLength > limit) throw new FileRuntimeLimitError("Output exceeds byte budget");
      return bytes;
    }),
    execute,
    destroy,
  };
  const start = vi.fn(async () => sandbox);
  const read = vi.fn(async () => source);
  const publish = vi.fn(async (outputs: readonly OutputArtifact[], provenance: FileProvenance) => {
    order.push("publish");
    published.push({ outputs, provenance });
    return outputs.map((output) => ({
      id: "output1",
      revision: "r1",
      name: output.name,
      mime: output.mime,
      bytes: output.bytes.byteLength,
      sha256: output.sha256,
    }));
  });
  const open = vi.fn(async () => ({
    operationId: "host-call-1",
    list: async () => options.files ?? [file],
    read,
    publish,
  }));
  const host = { open };
  return { host, start, sandbox, destroy, execute, read, publish, published, order, stored };
}

describe("transcript file environments", () => {
  it("offers structured CSV and PDF files, leaves plain text/images alone, and names unsupported formats", async () => {
    const f = fixture({
      files: [
        file,
        { ...file, id: "pdf", name: "contract.pdf", mime: "application/pdf" },
        { ...file, id: "plain", mime: "text/plain" },
        { ...file, id: "image", mime: "image/png" },
        { ...file, id: "unknown", name: "document.pages", mime: "application/octet-stream" },
      ],
    });
    const { runtime, plugin } = createFileRuntimePlugin({
      host: f.host,
      executor: { start: f.start },
      environments: [environment],
    });
    const offers = await runtime.describe({});
    expect(offers.map((offer) => [offer.file.id, offer.environments.length])).toEqual([
      ["f1", 1],
      ["pdf", 1],
      ["unknown", 0],
    ]);
    expect(await runtime.contextNotes({})).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("has not been read yet") })]),
    );
    expect(plugin.tools.map((tool) => tool.name)).toEqual(["file_runtime_describe", "file_runtime_execute"]);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(JSON.stringify(offers)).not.toContain("sha256:aaaa");
  });

  it("rejects mutable images, ambiguous revisions, and output traversal before execution", async () => {
    const f = fixture();
    expect(
      () => new FileRuntime(f.host, { start: f.start }, [{ ...environment, image: "example/runtime:latest" }]),
    ).toThrow("OCI digest");
    const runtime = new FileRuntime(f.host, { start: f.start }, [environment]);
    await expect(
      runtime.execute({ ...input, outputs: [{ name: "../secret", mime: "text/plain" }] }, {}),
    ).rejects.toThrow("plain output filename");
    await expect(runtime.execute({ ...input, files: [input.files[0], input.files[0]] }, {})).rejects.toThrow("once");
    await expect(runtime.execute({ ...input, revision: "old" }, {})).rejects.toThrow("file_runtime_describe");
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe("execution and publication", () => {
  it("materializes only selected revisions, destroys the VM, then publishes a verified artifact with provenance", async () => {
    const f = fixture();
    const runtime = new FileRuntime(f.host, { start: f.start }, [environment]);
    const result = await runtime.execute({ ...input, outputs: [{ name: "report.csv", mime: "text/csv" }] }, {});
    expect(result).toMatchObject({
      status: "succeeded",
      operationId: "host-call-1",
      value: 30,
      stdout: "done",
      artifacts: [{ id: "output1", name: "report.csv" }],
    });
    expect(f.stored.get("/inputs/0.csv")).toEqual(source);
    expect(f.read).toHaveBeenCalledWith(file, source.byteLength, expect.any(AbortSignal));
    expect(f.order).toEqual(["destroy", "publish"]);
    expect(f.published[0]?.provenance).toEqual({
      operationId: "host-call-1",
      environment: { id: environment.id, revision: "v1", image: environment.image },
      inputs: [file],
      codeSha256: sha256(input.code),
      processor: "file-runtime-v1",
    });
    expect(f.published[0]?.outputs[0]?.sha256).toBe(sha256("total\n30\n"));
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["other-file", "stale-revision", "changed-bytes"])("refuses %s without starting a VM", async (failure) => {
    const f = fixture();
    if (failure === "changed-bytes") f.read.mockResolvedValue(Buffer.from("wrong"));
    const runtime = new FileRuntime(f.host, { start: f.start }, [environment]);
    const files =
      failure === "other-file"
        ? [{ id: "other-session-file", revision: "r1" }]
        : failure === "stale-revision"
          ? [{ id: "f1", revision: "r0" }]
          : input.files;
    expect(await runtime.execute({ ...input, files }, {})).toMatchObject({ status: "failed", artifacts: [] });
    expect(f.start).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("keeps partial files private after a program error", async () => {
    const f = fixture({ exitCode: 1 });
    const result = await new FileRuntime(f.host, { start: f.start }, [environment]).execute(
      { ...input, outputs: [{ name: "report.csv", mime: "text/csv" }] },
      {},
    );
    expect(result.status).toBe("program-error");
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.sandbox.read).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it.each(["logs", "artifacts", "json"])("enforces the %s budget without publishing partial output", async (budget) => {
    const f = fixture();
    const runtime = new FileRuntime(
      f.host,
      { start: f.start },
      [environment],
      budget === "logs" ? { logBytes: 2 } : budget === "json" ? { resultBytes: 1 } : { outputBytes: 2 },
    );
    expect(await runtime.execute({ ...input, outputs: [{ name: "report.csv", mime: "text/csv" }] }, {})).toMatchObject({
      status: "limit-exceeded",
      artifacts: [],
    });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not publish when VM destruction fails", async () => {
    const f = fixture();
    f.destroy.mockRejectedValue(new Error("hypervisor unavailable"));
    const runtime = new FileRuntime(f.host, { start: f.start }, [environment], { concurrency: 1 });
    const result = await runtime.execute(input, {});
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("cleanup failed") });
    expect(f.publish).not.toHaveBeenCalled();
    await expect(runtime.execute(input, {})).rejects.toThrow("slots are occupied");
  });

  it("retains an uncertain publication for host reconciliation", async () => {
    const f = fixture();
    f.publish.mockRejectedValue(new Error("ack lost after commit"));
    expect(await new FileRuntime(f.host, { start: f.start }, [environment]).execute(input, {})).toMatchObject({
      status: "unknown",
      operationId: "host-call-1",
      message: expect.stringContaining("Reconcile"),
    });
  });
});

describe("cancellation and admission", () => {
  it("Stop before admission does not read or create a VM", async () => {
    const f = fixture();
    const result = await new FileRuntime(f.host, { start: f.start }, [environment]).execute(input, {
      signal: AbortSignal.abort(),
    });
    expect(result.status).toBe("cancelled");
    expect(f.host.open).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("destroys a VM whose creation completed after cancellation without ever running code", async () => {
    const f = fixture();
    const ready = Promise.withResolvers<FileSandbox>();
    const controller = new AbortController();
    const runtime = new FileRuntime(f.host, { start: () => ready.promise }, [environment], { concurrency: 1 });
    const pending = runtime.execute(input, { signal: controller.signal });
    await vi.waitFor(() => expect(f.read).toHaveBeenCalled());
    controller.abort();
    const cancelled = await pending;
    expect(cancelled.status).toBe("cancelled");
    await expect(runtime.execute(input, {})).rejects.toThrow("slots are occupied");
    ready.resolve(f.sandbox);
    await vi.waitFor(() => expect(f.destroy).toHaveBeenCalledTimes(1));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("times out a stalled execution, releases the slot and destroys the whole VM", async () => {
    const f = fixture();
    const ended = Promise.withResolvers<void>();
    f.execute.mockImplementation(async function* () {
      await ended.promise;
      yield { kind: "exited", code: 0 };
    });
    const runtime = new FileRuntime(f.host, { start: f.start }, [environment], { timeoutMs: 100, concurrency: 1 });
    const pending = runtime.execute(input, {});
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalled());
    await expect(runtime.execute(input, {})).rejects.toThrow("slots are occupied");
    const timedOut = await pending;
    expect(timedOut.status).toBe("timed-out");
    expect(f.destroy).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
    ended.resolve();
    f.execute.mockImplementation(async function* () {
      yield { kind: "exited", code: 0 };
    });
    const completed = await runtime.execute(input, {});
    expect(completed.status).toBe("succeeded");
  });
});
