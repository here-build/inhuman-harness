import type { ResponseCall } from "@inhuman.tools/harness-model/session";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";

export function toolCallFromResponse(call: ResponseCall): ToolCall {
  return {
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  };
}
