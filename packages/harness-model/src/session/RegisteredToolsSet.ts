/**
 * Frozen tools choice for a turn. Not a live catalog row and not a
 * system-prompt packet. The first turn holds the set; later turns inherit
 * until their tail has `reloadTools` or kernel MCP ids drift from
 * `mcpConnections`.
 */
import { Model, model, state } from "@inhuman.tools/model";

import { ToolSpec } from "./prompt-parts.js";

@model("harness:session:registered-tools-set")
export class RegisteredToolsSet extends Model {
  @state.childList accessor entries: ToolSpec[] = [];
  /**
   * The tools paragraph of the system prompt, frozen with the set it describes so a
   * catalog edit cannot rewrite the cached prefix between turns. Empty: read the live catalog.
   */
  @state accessor addendum: string = "";
  /** MCP connection ids frozen with this choice. Successor mint compares to kernel. */
  @state.list accessor mcpConnections: string[] = [];

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
