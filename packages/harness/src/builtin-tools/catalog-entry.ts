/**
 * Catalog row from an InhumanTool. Host plugins go through this —
 * parameters from the input zod, work through tool.execute.
 */
import { InhumanTool } from "@inhuman.tools/plugin-sdk";
import { z } from "zod";

import type { CatalogEntry, CatalogSource } from "@/tool-catalog";

export function parametersFromZod(input: z.ZodType): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(input) as Record<string, unknown>;
    const { $schema: _drop, ...rest } = schema;
    if (rest.type === undefined && rest.properties === undefined) {
      return { type: "object", properties: {} };
    }
    return rest;
  } catch {
    return { type: "object", properties: {} };
  }
}

export function catalogEntryFromTool(tool: InhumanTool, source: CatalogSource): CatalogEntry {
  return {
    wireName: tool.name,
    description: tool.description ?? tool.name,
    parameters: parametersFromZod(tool.input),
    class: tool.class,
    representation: tool.representation,
    source,
    execute: (raw, ctx) => tool.execute(raw, ctx),
    triggersReactLoop: tool.triggersReactLoop,
    isSideChannel: tool.isSideChannel,
    tapeHidden: tool.tapeHidden,
    exam: tool.exam,
  };
}

/** Wire/schema row without an execute door — orchestration, not catalog work. */
export function catalogProjectionFromTool(tool: InhumanTool, source: CatalogSource): CatalogEntry {
  const { execute: _drop, ...row } = catalogEntryFromTool(tool, source);
  return row;
}
