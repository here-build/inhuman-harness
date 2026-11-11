import { randomUUID } from "node:crypto";

import { expect, it } from "vitest";

import {
  documentEnvironment,
  createFileRuntimePlugin,
  type FileProvenance,
  type OutputArtifact,
  type TranscriptFile,
} from "../index.js";
import { sha256 } from "../runtime.js";

it.runIf(process.env.FILE_RUNTIME_MICROVM === "1")(
  "runs CSV → XLSX/PDF in a real offline microVM and destroys it",
  { timeout: 180_000 },
  async () => {
    const image = process.env.FILE_RUNTIME_IMAGE;
    if (!image) throw new Error("Set FILE_RUNTIME_IMAGE to a built, cached image reference pinned with @sha256:...");
    const { Sandbox } = await import("microsandbox");
    const existing = await Sandbox.listWith((list) => list.label("inhuman", "file-runtime"));
    const before = new Set(existing.sandboxes.map((sandbox) => sandbox.id));
    const bytes = Buffer.from(`amount\n${Array.from({ length: 1500 }, (_, index) => index + 1).join("\n")}\n`);
    const file: TranscriptFile = {
      id: "csv",
      revision: "r1",
      name: "amounts.csv",
      mime: "text/csv",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    };
    const outputs: OutputArtifact[] = [];
    const receipts: FileProvenance[] = [];
    const invocation = {};
    const { runtime } = createFileRuntimePlugin({
      environments: [documentEnvironment(image)],
      limits: { timeoutMs: 120_000, memoryMiB: 1024 },
      host: {
        async open(context) {
          if (context.invocation !== invocation) throw new Error("Unknown invocation");
          return {
            operationId: randomUUID(),
            list: async () => [file],
            async read(selected) {
              expect(selected).toEqual(file);
              return bytes;
            },
            async publish(batch, provenance, signal) {
              signal.throwIfAborted();
              outputs.push(...batch);
              receipts.push(provenance);
              return batch.map((output, index) => ({
                ...file,
                id: `out-${index}`,
                name: output.name,
                mime: output.mime,
                bytes: output.bytes.byteLength,
                sha256: output.sha256,
              }));
            },
          };
        },
      },
    });
    const outcome = await runtime.execute(
      {
        environment: "deno-documents",
        revision: "deno-documents-v1",
        files: [{ id: "csv", revision: "r1" }],
        code: `
const { parse } = await import("@std/csv");
const ExcelJS = (await import("exceljs")).default;
const { PDFDocument } = await import("pdf-lib");
const records = parse(await Deno.readTextFile(inputs[0].path), { skipFirstRow: true });
const total = records.reduce((sum, row) => sum + Number(row.amount), 0);
const workbook = new ExcelJS.Workbook();
workbook.addWorksheet("Summary").addRows([["rows", "total"], [records.length, total]]);
await Deno.writeFile(outputDir + "/summary.xlsx", new Uint8Array(await workbook.xlsx.writeBuffer()));
const pdf = await PDFDocument.create();
pdf.addPage().drawText("Rows: " + records.length + ", total: " + total);
await Deno.writeFile(outputDir + "/summary.pdf", await pdf.save());
const reopened = new ExcelJS.Workbook();
await reopened.xlsx.load(await Deno.readFile(outputDir + "/summary.xlsx"));
if (reopened.getWorksheet("Summary").getCell("B2").value !== total) throw new Error("Workbook verification failed");
if ((await PDFDocument.load(await Deno.readFile(outputDir + "/summary.pdf"))).getPageCount() !== 1) throw new Error("PDF verification failed");
let blocked = 0;
try { await fetch("https://example.com"); } catch { blocked++; }
try { Deno.env.get("HOME"); } catch { blocked++; }
try { await Deno.readTextFile("/etc/passwd"); } catch { blocked++; }
try { await new Deno.Command("sh", { args: ["-c", "true"] }).output(); } catch { blocked++; }
return { rows: records.length, total, blocked, coverage: "all CSV rows" };
`,
        outputs: [
          { name: "summary.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
          { name: "summary.pdf", mime: "application/pdf" },
        ],
      },
      { invocation },
    );
    expect(outcome, JSON.stringify(outcome)).toMatchObject({
      status: "succeeded",
      value: { rows: 1500, total: 1125750, blocked: 4, coverage: "all CSV rows" },
      artifacts: [{ name: "summary.xlsx" }, { name: "summary.pdf" }],
    });
    expect(outputs.map((output) => output.sha256)).toEqual(outputs.map((output) => sha256(output.bytes)));
    expect(receipts).toHaveLength(1);
    const stalled = createFileRuntimePlugin({
      environments: [documentEnvironment(image)],
      limits: { timeoutMs: 2500 },
      host: {
        async open() {
          return {
            operationId: randomUUID(),
            list: async () => [],
            async read() {
              throw new Error("No inputs were selected");
            },
            async publish() {
              throw new Error("Timed-out output must not be published");
            },
          };
        },
      },
    });
    const timedOut = await stalled.runtime.execute(
      {
        environment: "deno-documents",
        revision: "deno-documents-v1",
        files: [],
        code: 'console.log("entered infinite loop"); for (;;) {}',
        outputs: [],
      },
      {},
    );
    expect(timedOut).toMatchObject({
      status: "timed-out",
      stdout: expect.stringContaining("entered infinite loop"),
      artifacts: [],
    });
    const page = await Sandbox.listWith((list) => list.label("inhuman", "file-runtime"));
    expect(page.sandboxes.filter((sandbox) => !before.has(sandbox.id))).toEqual([]);
  },
);
