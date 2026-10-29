/**
 * Catalog dispatch. Registered tools work through CatalogEntry.execute
 * (InhumanTool.execute). Failures are doors except ToolError containment throws.
 */
import { z } from "@inhuman.tools/plugin-sdk";

import { ToolError, asToolResult, type ToolResult } from "@/builtin-tools";
import { requireCatalog } from "@/tool-catalog";

import { type KernelToolCatalog } from "./tool-table.js";

export interface ToolContext {
  readonly root: string;
  readonly catalog: KernelToolCatalog;
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly turn?: unknown;
  readonly completion?: unknown | null;
  readonly invocation?: unknown;
  readonly storage?: {
    readonly session: unknown;
    readonly invocation: unknown;
    propose(action: unknown): void;
  };
  readonly onPriorContent?: (text: string | null) => void;
  readonly shellTailBytes?: number;
  readonly onTail?: (frame: { readonly text: string; readonly totalBytes: number }) => void;
}

function doorText(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.map(String).join(".") ?? "";
    const message = issue?.message ?? "invalid arguments";
    return path === "" ? message : `${path}: ${message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Validate against catalog then run. Truncation is admit's bound, not here. */
export async function runTool(name: string, rawArgs: unknown, context: ToolContext): Promise<ToolResult> {
  const catalog = requireCatalog(context.catalog, name);
  const entry = catalog.catalogEntry(name);

  if (entry?.execute !== undefined) {
    try {
      const out = await entry.execute(rawArgs, {
        ...context,
        catalog,
        invocation: context.invocation,
      });
      return asToolResult(out);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      return { ok: false, text: error instanceof z.ZodError ? doorText(error) : `${name}: ${doorText(error)}` };
    }
  }

  ToolError.invariant(
    !name.startsWith("mcp__"),
    `unknown MCP tool "${name}" — connection missing, disabled, or not expanded`,
  );

  const available = catalog.catalogWireNames().join(", ");
  throw new ToolError(`unknown tool "${name}" — available: ${available}`);
}
