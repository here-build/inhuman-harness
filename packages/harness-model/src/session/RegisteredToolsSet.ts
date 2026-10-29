/**
 * Frozen tools choice for a turn. Not a live catalog row and not a
 * system-prompt packet. The first turn holds the set; later turns inherit
 * until their tail has `reloadTools` or kernel MCP ids drift from
 * `mcpConnections`.
 */
import { PlexusModel, syncing } from "@here.build/plexus";

import { ToolSpec } from "./prompt-parts.js";

@syncing("harness:session:registered-tools-set")
export class RegisteredToolsSet extends PlexusModel {
  @syncing.child.list accessor entries: ToolSpec[] = [];
  /**
   * The tools paragraph of the system prompt, frozen with the set it describes so a
   * catalog edit cannot rewrite the cached prefix between turns. Empty: read the live catalog.
   */
  @syncing accessor addendum: string = "";
  /** MCP connection ids frozen with this choice. Successor mint compares to kernel. */
  @syncing.list accessor mcpConnections: string[] = [];

  constructor(
    props?:
      | {
          readonly entries?: readonly ToolSpec[];
          readonly mcpConnections?: readonly string[];
          readonly addendum?: string;
        }
      | symbol,
  ) {
    super(props);
  }
}

/** Same ids, any order. */
export function mcpConnectionsEqual(left: readonly string[], right: readonly string[]): boolean {
  const have = new Set(left);
  const want = new Set(right);
  return have.size === want.size && [...want].every((id) => have.has(id));
}
