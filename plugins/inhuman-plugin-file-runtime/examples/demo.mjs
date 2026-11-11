import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileRuntimePlugin, documentEnvironment } from "../dist/index.js";

const image = process.argv[2];
if (!image) throw new Error("Usage: node examples/demo.mjs image@sha256:...");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.from(`amount\n${Array.from({ length: 1500 }, (_, index) => index + 1).join("\n")}\n`);
const file = { id: "amounts", revision: "1", name: "amounts.csv", mime: "text/csv", bytes: bytes.byteLength, sha256: hash(bytes) };
const operationId = randomUUID();
const invocation = {};
const context = { invocation };
const directory = await mkdtemp(join(tmpdir(), "inhuman-file-runtime-demo-"));
const { runtime, plugin } = createFileRuntimePlugin({
  environments: [documentEnvironment(image)],
  host: {
    async open(ctx) {
      if (ctx.invocation !== invocation) throw new Error("This invocation has no access to the demo transcript.");
      return {
        operationId,
        async list() { return [file]; },
        async read(selected, maxBytes, signal) {
          signal.throwIfAborted();
          if (selected.id !== file.id || selected.revision !== file.revision || bytes.byteLength > maxBytes) throw new Error("The selected revision is unavailable.");
          return bytes;
        },
        async publish(outputs, provenance, signal) {
          const committed = join(directory, operationId);
          try { return JSON.parse(await readFile(join(committed, "artifacts.json"), "utf8")); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          const stage = await mkdtemp(join(directory, ".stage-"));
          try {
            const artifacts = [];
            for (const output of outputs) {
              if (hash(output.bytes) !== output.sha256) throw new Error("Output checksum mismatch.");
              await writeFile(join(stage, output.name), output.bytes);
              artifacts.push({ id: `${operationId}/${output.name}`, revision: "1", name: output.name, mime: output.mime, bytes: output.bytes.byteLength, sha256: output.sha256 });
            }
            await writeFile(join(stage, "provenance.json"), JSON.stringify(provenance, null, 2));
            await writeFile(join(stage, "artifacts.json"), JSON.stringify(artifacts, null, 2));
            signal.throwIfAborted();
            await rename(stage, committed);
            return artifacts;
          } finally { await rm(stage, { recursive: true, force: true }); }
        },
      };
    },
  },
});

for (const note of await runtime.contextNotes(context)) console.log(note.text);
const execute = plugin.tools.find((tool) => tool.name === "file_runtime_execute");
if (!execute) throw new Error("The plugin did not register its execution tool.");
const outcome = await execute.execute({
  environment: "deno-documents", revision: "deno-documents-v1", files: [{ id: file.id, revision: file.revision }],
  code: `const { parse } = await import("@std/csv");
const rows = parse(await Deno.readTextFile(inputs[0].path), { skipFirstRow: true });
const total = rows.reduce((sum, row) => sum + Number(row.amount), 0);
await Deno.writeTextFile(outputDir + "/summary.csv", "rows,total\\n" + rows.length + "," + total + "\\n");
return { rows: rows.length, total, coverage: "all CSV rows" };`,
  outputs: [{ name: "summary.csv", mime: "text/csv" }],
}, context);
console.log(JSON.stringify({ outcome, outputDirectory: join(directory, operationId) }, null, 2));
