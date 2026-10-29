import { ResponseCall } from "@inhuman.tools/harness-model";
import type { ToolCall } from "@inhuman.tools/tool-call-normalize";

import { readField } from "./json-read.js";

export function parseStoredToolCall(item: unknown): ToolCall | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const id = readField(item, "id");
  const type = readField(item, "type");
  const fn = readField(item, "function");
  if (typeof id !== "string" || id === "") return undefined;
  if (type !== undefined && type !== "function") return undefined;
  if (typeof fn !== "object" || fn === null) return undefined;
  const name = readField(fn, "name");
  const args = readField(fn, "arguments");
  if (typeof name !== "string" || name === "") return undefined;
  if (typeof args !== "string") return undefined;
  return {
    id,
    type: "function",
    function: { name, arguments: args },
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
