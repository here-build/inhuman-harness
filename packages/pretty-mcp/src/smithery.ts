/* eslint-disable security/detect-non-literal-fs-filename -- cache path is a CLI argument */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CalibratedTool, SmitheryDetail, ToolArg } from "./types.js";

export const SMITHERY_UA = "pretty-mcp/0.1 (+https://here.build)";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function fetchText(url: string, accept = "text/plain"): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url, { headers: { Accept: accept, "User-Agent": SMITHERY_UA } });
    if (response.ok) return response.text();
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`${url} → ${response.status}`);
  }
  throw new Error(url);
}

async function getJson(url: string): Promise<unknown> {
  const text = await fetchText(url, "application/json");
  return JSON.parse(text);
}

function parseArg(raw: unknown): ToolArg | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string") return undefined;
  return {
    name: raw.name,
    type: typeof raw.type === "string" ? raw.type : "unknown",
    required: raw.required === true,
    description: typeof raw.description === "string" ? raw.description : "",
  };
}

/** Smithery wire tool, or an already-slimmed cache row. */
export function slimTool(raw: unknown): CalibratedTool | undefined {
  if (!isRecord(raw)) return undefined;
  const name = typeof raw.name === "string" ? raw.name : undefined;
  if (name === undefined) return undefined;
  const inputSchema = isRecord(raw.inputSchema) ? raw.inputSchema : undefined;
  const outputSchema = isRecord(raw.outputSchema) ? raw.outputSchema : undefined;
  if (Array.isArray(raw.args)) {
    return {
      name,
      description: typeof raw.description === "string" ? raw.description.trim() : "",
      args: raw.args.map(parseArg).filter((arg): arg is ToolArg => arg !== undefined),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
    };
  }
  const schema = isRecord(raw.inputSchema) ? raw.inputSchema : {};
  const props = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const args: ToolArg[] = [];
  for (const [argName, spec] of Object.entries(props)) {
    const rec = isRecord(spec) ? spec : {};
    args.push({
      name: argName,
      type: typeof rec.type === "string" ? rec.type : rec.enum === undefined ? "unknown" : "enum",
      required: required.includes(argName),
      description: typeof rec.description === "string" ? rec.description.trim() : "",
    });
  }
  return {
    name,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    args,
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

async function listPages(pageSize: number, extraQ?: string): Promise<Record<string, unknown>[]> {
  const servers: Record<string, unknown>[] = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (extraQ !== undefined) qs.set("q", extraQ);
    const data = await getJson(`https://registry.smithery.ai/servers?${qs}`);
    if (!isRecord(data) || !Array.isArray(data.servers)) break;
    const chunk = data.servers.filter(isRecord);
    const pag = isRecord(data.pagination) ? data.pagination : {};
    process.stderr.write(`  list page=${page} n=${chunk.length}\n`);
    if (chunk.length === 0) break;
    servers.push(...chunk);
    const totalPages = typeof pag.totalPages === "number" ? pag.totalPages : page;
    if (page >= totalPages) break;
    page += 1;
    await sleep(50);
  }
  return servers;
}

export async function fetchSmithery(cachePath: string): Promise<SmitheryDetail[]> {
  process.stderr.write("listing Smithery featured + verified…\n");
  const featured = await listPages(100);
  const verified = await listPages(50, "is:verified");
  const byName = new Map<string, Record<string, unknown>>();
  for (const server of [...featured, ...verified]) {
    const name = typeof server.qualifiedName === "string" ? server.qualifiedName : undefined;
    if (name === undefined) continue;
    const prev = byName.get(name);
    const use = typeof server.useCount === "number" ? server.useCount : 0;
    const prevUse = prev !== undefined && typeof prev.useCount === "number" ? prev.useCount : -1;
    if (prev === undefined || use > prevUse) byName.set(name, server);
  }
  const listing = [...byName.values()].toSorted((a, b) => {
    const au = typeof a.useCount === "number" ? a.useCount : 0;
    const bu = typeof b.useCount === "number" ? b.useCount : 0;
    return bu - au;
  });
  const details: SmitheryDetail[] = [];
  for (const [i, server] of listing.entries()) {
    const q = String(server.qualifiedName);
    const data = await getJson(
      `https://registry.smithery.ai/servers/${q.split("/").map(encodeURIComponent).join("/")}`,
    );
    const tools =
      isRecord(data) && Array.isArray(data.tools)
        ? data.tools.map(slimTool).filter((tool): tool is CalibratedTool => tool !== undefined)
        : [];
    details.push({
      qualifiedName: isRecord(data) && typeof data.qualifiedName === "string" ? data.qualifiedName : q,
      displayName: isRecord(data) && typeof data.displayName === "string" ? data.displayName : undefined,
      description: isRecord(data) && typeof data.description === "string" ? data.description.trim() : "",
      useCount: typeof server.useCount === "number" ? server.useCount : 0,
      verified: server.verified === true,
      toolCount: tools.length,
      tools,
    });
    process.stderr.write(`  [${i + 1}/${listing.length}] ${q} tools=${tools.length}\n`);
    await sleep(40);
  }
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(details, null, 2)}\n`);
  return details;
}

export function parseSmitheryCache(raw: unknown): SmitheryDetail[] {
  if (!Array.isArray(raw)) throw new Error("smithery cache must be an array");
  return raw.map((item) => {
    if (!isRecord(item) || typeof item.qualifiedName !== "string") {
      throw new Error("smithery cache row missing qualifiedName");
    }
    const tools = Array.isArray(item.tools)
      ? item.tools.map(slimTool).filter((tool): tool is CalibratedTool => tool !== undefined)
      : [];
    return {
      qualifiedName: item.qualifiedName,
      displayName: typeof item.displayName === "string" ? item.displayName : undefined,
      description: typeof item.description === "string" ? item.description : "",
      useCount: typeof item.useCount === "number" ? item.useCount : 0,
      verified: item.verified === true,
      toolCount: typeof item.toolCount === "number" ? item.toolCount : tools.length,
      tools,
    };
  });
}
