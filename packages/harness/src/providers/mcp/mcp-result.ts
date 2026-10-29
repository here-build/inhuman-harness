/** `tools/call` payload. `Client.callTool` would drop content on outputSchema throw. */
import { asRecord, readField } from "./json.js";

export type RawMcpToolResult = {
  readonly ok: boolean;
  readonly text?: string;
  readonly raw?: unknown;
  readonly value?: unknown;
};

export function mcpCallResult(res: unknown): RawMcpToolResult {
  const value = callResultValue(res);
  if (res != null && typeof res === "object" && readField(res, "isError") === true) {
    return { ok: false, text: diagnosticText(res, value), raw: res, value };
  }
  return { ok: true, raw: res, value };
}

export function parseMcpArgsJson(argumentsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argumentsJson.trim() === "" ? "{}" : argumentsJson);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function withMcpStderr(text: string, tail: string): string {
  return tail && !text.includes("--- stderr ---") ? `${text}\n--- stderr ---\n${tail}` : text;
}

function callResultValue(res: unknown): unknown {
  if (res == null || typeof res !== "object") return res;
  const structured = readField(res, "structuredContent");
  if (structured !== undefined) return structured;
  const content = readField(res, "content");
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0];
    if (typeof block === "object" && block !== null && readField(block, "type") === "text") {
      return String(readField(block, "text") ?? "");
    }
  }
  if (content !== undefined) return content;
  return res;
}

function diagnosticText(res: unknown, value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (res == null || typeof res !== "object") return "mcp: tool reported failure";
  const content = readField(res, "content");
  if (Array.isArray(content)) {
    const texts = content
      .filter((block) => typeof block === "object" && block !== null && readField(block, "type") === "text")
      .map((block) => (typeof block === "object" && block !== null ? String(readField(block, "text") ?? "") : ""));
    if (texts.some((text) => text !== "")) return texts.join("\n");
  }
  return "mcp: tool reported failure";
}
