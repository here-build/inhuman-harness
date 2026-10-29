/* eslint-disable security/detect-non-literal-fs-filename -- catalog dir is a CLI argument */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCovered, isSerializerCovered, optsSchemaForTool } from "./schema.js";
import type {
  CalibratedServer,
  CalibratedTool,
  Calibration,
  CatalogFile,
  CatalogTool,
  UncoveredSerializer,
  UncoveredTool,
} from "./types.js";

export function catalogSlug(id: string): string {
  return id.replaceAll("/", "__").replaceAll(":", "__");
}

export function catalogPath(catalogDir: string, id: string): string {
  return path.join(catalogDir, `${catalogSlug(id)}.json`);
}

function sortTools(tools: Record<string, CatalogTool>): Record<string, CatalogTool> {
  return Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)));
}

export function candidateFromCalibrated(tool: CalibratedTool, previous?: CatalogTool): CatalogTool {
  const next: CatalogTool = {
    description: tool.description,
    opts: optsSchemaForTool(tool.inputSchema, tool.args),
    question: previous?.question ?? null,
    effect: previous?.effect ?? null,
    result: {
      schema: tool.outputSchema ?? previous?.result.schema ?? null,
      serializer: previous?.result.serializer ?? null,
    },
  };
  return next;
}

export function fileFromServer(server: CalibratedServer, previous?: CatalogFile): CatalogFile {
  const incoming = new Map(server.tools.map((tool) => [tool.name, tool]));
  const tools: Record<string, CatalogTool> = {};
  for (const [name, tool] of incoming) {
    tools[name] = candidateFromCalibrated(tool, previous?.tools[name]);
  }
  if (previous !== undefined) {
    for (const [name, tool] of Object.entries(previous.tools)) {
      if (incoming.has(name)) continue;
      tools[name] = { ...tool, stale: true };
    }
  }
  return {
    id: server.id,
    displayName: server.displayName,
    source: server.source,
    description: server.description,
    tools: sortTools(tools),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseCatalogFile(raw: unknown): CatalogFile {
  if (!isRecord(raw)) throw new Error("catalog file must be an object");
  if (typeof raw.id !== "string" || !isRecord(raw.tools)) {
    throw new Error("catalog file missing id/tools");
  }
  return raw as CatalogFile;
}

export function parseCalibration(raw: unknown): Calibration {
  if (!isRecord(raw)) throw new Error("calibration must be an object");
  if (typeof raw.asOf !== "string" || !Array.isArray(raw.servers)) {
    throw new TypeError("calibration missing asOf/servers");
  }
  return raw as Calibration;
}

export async function readCatalogFile(filePath: string): Promise<CatalogFile | undefined> {
  if (!existsSync(filePath)) return undefined;
  return parseCatalogFile(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}

export async function writeCatalogFile(filePath: string, file: CatalogFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`);
}

export async function loadCatalogDir(catalogDir: string): Promise<Map<string, CatalogFile>> {
  const out = new Map<string, CatalogFile>();
  if (!existsSync(catalogDir)) return out;
  const names = await readdir(catalogDir);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = await readCatalogFile(path.join(catalogDir, name));
    if (file !== undefined) out.set(file.id, file);
  }
  return out;
}

/** Catalog JSON next to this package (src or dist). */
export function installedCatalogDir(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "catalog");
}

export function loadCatalogDirSync(catalogDir: string): Map<string, CatalogFile> {
  const out = new Map<string, CatalogFile>();
  if (!existsSync(catalogDir)) return out;
  for (const name of readdirSync(catalogDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const file = parseCatalogFile(JSON.parse(readFileSync(path.join(catalogDir, name), "utf8")) as unknown);
      out.set(file.id, file);
    } catch {
      /* skip unreadable rows */
    }
  }
  return out;
}

export type CatalogIndex = {
  readonly byId: ReadonlyMap<string, CatalogFile>;
};

let installed: CatalogIndex | undefined;

export function catalogIndex(dir = installedCatalogDir()): CatalogIndex {
  if (installed !== undefined && dir === installedCatalogDir()) return installed;
  const index = { byId: loadCatalogDirSync(dir) };
  if (dir === installedCatalogDir()) installed = index;
  return index;
}

/** Exact id, then case-insensitive id / displayName. */
export function lookupCatalogTool(index: CatalogIndex, server: string, tool: string): CatalogTool | undefined {
  if (server === "" || tool === "") return undefined;
  const exact = index.byId.get(server)?.tools[tool];
  if (exact !== undefined) return exact;
  const needle = server.toLowerCase();
  for (const file of index.byId.values()) {
    if (file.id.toLowerCase() === needle || file.displayName.toLowerCase() === needle) {
      return file.tools[tool];
    }
  }
  return undefined;
}

export async function generateCatalog(
  calibration: Calibration,
  catalogDir: string,
): Promise<{ written: number; covered: number; uncovered: number; stale: number }> {
  let written = 0;
  let covered = 0;
  let uncovered = 0;
  let stale = 0;
  for (const server of calibration.servers) {
    const dest = catalogPath(catalogDir, server.id);
    const previous = await readCatalogFile(dest);
    const next = fileFromServer(server, previous);
    await writeCatalogFile(dest, next);
    written += 1;
    for (const tool of Object.values(next.tools)) {
      if (tool.stale === true) stale += 1;
      else if (isCovered(tool.question, tool.effect)) covered += 1;
      else uncovered += 1;
    }
  }
  return { written, covered, uncovered, stale };
}

export function uncoveredFrom(calibration: Calibration, catalog: Map<string, CatalogFile>): UncoveredTool[] {
  const out: UncoveredTool[] = [];
  for (const server of calibration.servers) {
    const file = catalog.get(server.id);
    for (const tool of server.tools) {
      const row = file?.tools[tool.name];
      if (row !== undefined && isCovered(row.question, row.effect)) continue;
      out.push({
        server: server.id,
        tool: tool.name,
        description: row?.description ?? tool.description,
        opts: row?.opts ?? optsSchemaForTool(tool.inputSchema, tool.args),
      });
    }
  }
  return out;
}

export function uncoveredSerializersFrom(
  calibration: Calibration,
  catalog: Map<string, CatalogFile>,
): UncoveredSerializer[] {
  const out: UncoveredSerializer[] = [];
  for (const server of calibration.servers) {
    const file = catalog.get(server.id);
    for (const tool of server.tools) {
      const row = file?.tools[tool.name];
      if (row === undefined || !isCovered(row.question, row.effect)) continue;
      if (isSerializerCovered(row.result.serializer)) continue;
      out.push({
        server: server.id,
        tool: tool.name,
        description: row.description,
        schema: row.result.schema,
      });
    }
  }
  return out;
}

export async function loadCalibration(filePath: string): Promise<Calibration> {
  if (!existsSync(filePath)) throw new Error(`no calibration at ${filePath}; run retrieve`);
  return parseCalibration(JSON.parse(await readFile(filePath, "utf8")) as unknown);
}
