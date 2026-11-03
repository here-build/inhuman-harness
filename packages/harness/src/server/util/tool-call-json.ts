import { ResponseCall } from "@inhuman.tools/harness-model";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";

export function toolCallFromResponse(call: ResponseCall): ToolCall {
  return {
    id: call.toolCallId,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  };
}

export function responseCallsFromToolCalls(calls: readonly ToolCall[]): ResponseCall[] {
  return calls.map(
    (call) =>
      new ResponseCall({
        toolCallId: call.id,
        name: call.function.name,
        argsJson: call.function.arguments,
      }),
  );
}
