import type { ContentBlock } from "./content-block.js";

/** Wraps manifold's `AttachmentCollector` (which stays binder-side — it's
 *  `CallToolResult`-binary-shaped and threaded through `unwrapToolResult`, an SDK-facing
 *  concern) so the runner can drain captured binary blocks without importing the concrete
 *  class or the MCP SDK. arrival-mcp's positional/native-verb world has no equivalent
 *  binary-leak problem today; a no-op sink is a valid implementation there. */
export interface AttachmentSink {
  beginCall(quota?: number): void;
  drainBlocks(): readonly ContentBlock[];
  drainNote(): string | undefined;
}
