/**
 * pretty-mcp tape paint. Compact is the identity line; expand adds the
 * block. Question while live/ask; effect when sealed. Uncovered tools
 * stay on the hand identity. Gutter chrome is not this file.
 */
import { MCPToolJob, ProgrammaticJob, FileMutateToolJob, ToolCallJob } from "@inhuman.tools/harness-model";
import { catalogIndex, renderTool, splitIdentity, type CatalogTool, type RenderKind } from "@inhuman.tools/pretty-mcp";

import { parseMcpWireName } from "./mcp-identity.js";
import { sugarcoatProgram } from "./sugarcoat.js";

export type PrettyPaint = {
  readonly line: string;
  readonly block: string;
};

const TOOLKIT = "harness-toolkit";
/** Tape paint: toolkit + playwright. Other Smithery catalogs stay lookup-later. */
const TAPE_SERVERS = new Set(["harness-toolkit", "playwright"]);

function paintArgs(work: ToolCallJob, args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const name = work.name;
  let next = args;
  if ((name === "glob" || name === "fff_search") && args.cwd === undefined && typeof args.path === "string") {
    next = { ...args, cwd: args.path };
  }
  if (name === "write_file") {
    const existed = writeFileExisted(work);
    if (existed !== undefined) next = { ...next, existed };
  }
  return next;
}

/** Host-only. dist-tools.ts seals `created ` / `replaced `. Not a model argument. */
function writeFileExisted(work: ToolCallJob): boolean | undefined {
  if (work.completed) {
    const text = work.outcomeSnap?.ok === true ? work.outcomeSnap?.text : undefined;
    if (typeof text === "string") {
      if (text.startsWith("created ")) return false;
      if (text.startsWith("replaced ")) return true;
    }
  }
  if (work instanceof FileMutateToolJob) {
    if (work.existed === true) return true;
    if (work.existed === false) return false;
  }
  return undefined;
}

function argsOf(work: ToolCallJob): Record<string, unknown> {
  return { ...(work.args ?? {}) };
}

function catalogTool(server: string, tool: string): CatalogTool | undefined {
  const needle = server.toLowerCase();
  for (const file of catalogIndex().byId.values()) {
    if (!TAPE_SERVERS.has(file.id)) continue;
    if (file.id === server || file.id.toLowerCase() === needle || file.displayName.toLowerCase() === needle) {
      return file.tools[tool];
    }
  }
  return undefined;
}

function paint(
  server: string,
  tool: string,
  kind: RenderKind,
  args: Record<string, unknown>,
  result?: unknown,
): PrettyPaint | null {
  const row = catalogTool(server, tool);
  if (row === undefined) return null;
  const rendered = renderTool(row, kind, args, result);
  if (!rendered.ok || rendered.markdown.trim() === "") return null;
  return splitIdentity(rendered.markdown);
}

export function prettyIdentity(work: ToolCallJob | ProgrammaticJob, kind: "question" | "effect"): PrettyPaint | null {
  if (work instanceof ProgrammaticJob) {
    return paint(TOOLKIT, "scheme_repl", kind, { expr: sugarcoatProgram(work.expr) });
  }
  const args = paintArgs(work, argsOf(work));
  if (work instanceof MCPToolJob) {
    const wired = parseMcpWireName(work.name);
    const tool = work.serverToolName.trim() || wired.tool;
    for (const server of [work.connectionKey.trim(), wired.server]) {
      if (server === "") continue;
      const hit = paint(server, tool, kind, args);
      if (hit !== null) return hit;
    }
    return null;
  }
  return paint(TOOLKIT, work.name, kind, args);
}

export function prettyResult(work: ToolCallJob | ProgrammaticJob, result: unknown): string | null {
  if (work instanceof ProgrammaticJob) {
    const hit = paint(TOOLKIT, "scheme_repl", "result", { expr: sugarcoatProgram(work.expr) }, result);
    return hit === null ? null : [hit.line, hit.block].filter((part) => part !== "").join("\n");
  }
  const args = paintArgs(work, argsOf(work));
  if (work instanceof MCPToolJob) {
    const wired = parseMcpWireName(work.name);
    const tool = work.serverToolName.trim() || wired.tool;
    for (const server of [work.connectionKey.trim(), wired.server]) {
      if (server === "") continue;
      const hit = paint(server, tool, "result", args, result);
      if (hit !== null) return [hit.line, hit.block].filter((part) => part !== "").join("\n");
    }
    return null;
  }
  const hit = paint(TOOLKIT, work.name, "result", args, result);
  return hit === null ? null : [hit.line, hit.block].filter((part) => part !== "").join("\n");
}

/** Question templates end in `?`. The gutter owns that mark, not the sentence. */
export function stripQuestion(line: string): string {
  return line.endsWith("?") ? line.slice(0, -1).trimEnd() : line;
}
