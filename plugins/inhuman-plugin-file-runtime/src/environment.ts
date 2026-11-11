import { environmentSchema, type FileEnvironment } from "./contracts.js";

/** Matches runtime/Dockerfile. The host supplies the digest of its own built image. */
export function documentEnvironment(image: string): FileEnvironment {
  return environmentSchema.parse({
    id: "deno-documents",
    revision: "deno-documents-v1",
    image,
    description:
      "Offline Deno 2.8.3. CSV/TSV calculations, XLSX reading and creation, PDF page/form manipulation and creation.",
    extensions: [".csv", ".tsv", ".xlsx", ".pdf"],
    libraries: ["@std/csv@1.0.6", "exceljs@4.4.0", "pdf-lib@1.17.1"],
    limitations: [
      "PDF text extraction, rendering and OCR are not included.",
      "Spreadsheet formulas are not recalculated; inspect formulas and cached results separately.",
      "No DOC/Pages/Numbers support in this image.",
      "Return row/page coverage explicitly; a sample is not a complete read.",
    ],
  });
}
