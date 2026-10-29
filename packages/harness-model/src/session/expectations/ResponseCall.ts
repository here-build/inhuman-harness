/**
 * Native tool_call the model authored on this completion. Facts only —
 * correlator, name, args JSON string. Not the Chat Completions
 * `{ type, function: {} }` envelope and not a ToolCallJob (admit mints that).
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto } from "../../json-record.js";

@syncing("harness:expectation:response-call")
export class ResponseCall extends PlexusModel {
  @syncing accessor toolCallId: string = "";
  @syncing accessor name: string = "";
  @syncing accessor argsJson: string | null = "{}";
  /**
   * Why the args cannot be trusted: the stream ended inside the call (`truncated`) or
   * the arguments did not parse. Empty for a call that arrived whole. A flagged call
   * is never run; its receipt tells the model to issue it again.
   */
  @syncing accessor dropReason: string = "";

  constructor(
    props?:
      | {
          readonly toolCallId?: string;
          readonly name?: string;
          readonly argsJson?: string | null;
          readonly dropReason?: string;
        }
      | symbol,
  ) {
    super(props);
  }

  @serializingInto("argsJson")
  accessor args: ReadonlyDeep<Record<string, unknown>> | null = null;
}

export function responseCall(toolCallId: string, name: string, argsJson = "{}"): ResponseCall {
  return new ResponseCall({ toolCallId, name, argsJson });
}
