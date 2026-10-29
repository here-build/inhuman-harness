import type { ToolJsonSchema, ToolSignature } from "./tool-schema.js";

/** Collapses the binder's current 5 qualifiedName-keyed structures (`signatures[]`,
 *  `signatureByName`, `toolParts`, `bypassResolution` (keyed by bare-name forms — does NOT
 *  subsume), `toolSchemasByAmbient`) into ONE registry entry per tool. `signature()` is lazy — the
 *  binder computes it its own way (kwargs `:key value` text today; a positional binder renders
 *  differently later) and the runner never needs to know how. */
export interface BoundTool {
  readonly qualifiedName: string;
  /** The connected-server identity (`ToolIdentityParts` pre-split: `{slug, tool}`) — used by
   *  doors.ts's did-you-mean / namespace / implicated-tool logic. */
  readonly slug: string;
  readonly tool: string;
  readonly schema?: ToolJsonSchema;
  readonly outputSchema?: ToolJsonSchema;
  signature(): ToolSignature;
}

/** Replaces doors.ts's direct `names.ts` import (`ARG_NAME`/`TOOL_NAME`) — arrival-mcp's
 *  DiscoveryTool has its own public tool identity, injected the same way. */
export interface ToolNaming {
  readonly toolName: string;
  readonly argName: string;
}
