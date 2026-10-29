/**
 * Scripted session model. Every completion says `this is assistant message #n`.
 * The user prompt is `this is user prompt.` plus an optional second sentence
 * `execute tools sequence: [4,3,5]`. Each number is how many `scheme_repl`
 * calls that round emits (`tool call i, round n`), so the transcript can tell
 * them apart. No second sentence, or an empty array, means speech only.
 * `n` counts scripted assistant lines after the latest such user prompt.
 */
import type { CompatReply } from "./compat-server.js";
import { asRecord, readField } from "../util/read-field.js";

const USER_MARK = "this is user prompt.";
const ASSISTANT_MARK = /^this is assistant message #\d+$/;

type Line = { readonly role: "user" | "assistant"; readonly text: string };

export function sequenceReply(post: unknown): CompatReply {
  const lines = linesOf(post);
  const planAt = lastPlanIndex(lines);
  const plan = planAt === -1 ? null : toolPlan(lines[planAt]!.text);
  const prior = lines.slice(planAt + 1).filter((line) => line.role === "assistant" && ASSISTANT_MARK.test(line.text));
  const round = prior.length + 1;
  const content = `this is assistant message #${round}`;
  const count = plan != null && plan.length > 0 ? plan[round - 1] : undefined;
  if (count == null || count < 1) return { content, finish_reason: "stop" };
  return {
    content,
    finish_reason: "tool_calls",
    tool_calls: Array.from({ length: count }, (_, index) => schemeCall(round, index + 1)),
  };
}

function schemeCall(
  round: number,
  index: number,
): {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
} {
  const phrase = `tool call ${index}, round ${round}`;
  return {
    id: `call_r${round}_${index}`,
    type: "function",
    function: {
      name: "scheme_repl",
      // A Scheme string, so the phrase is the value and stays visible in the message.
      arguments: JSON.stringify({ expr: `"${phrase}"`, description: phrase }),
    },
  };
}

/** Numbers after the second sentence. `[]` is no tools. `null` is not this prompt. */
function toolPlan(text: string): number[] | null {
  const at = text.indexOf(USER_MARK);
  if (at === -1) return null;
  const rest = text.slice(at + USER_MARK.length).trim();
  if (rest === "") return [];
  const match = /^execute tools sequence:\s*\[([^\]]*)]/.exec(rest);
  if (match == null) return [];
  const body = match[1]!.trim();
  if (body === "") return [];
  const nums: number[] = [];
  for (const piece of body.split(",")) {
    const trimmed = piece.trim();
    if (!/^\d+$/.test(trimmed)) return [];
    nums.push(Number(trimmed));
  }
  return nums;
}

function lastPlanIndex(lines: readonly Line[]): number {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.role === "user" && toolPlan(line.text) !== null) return i;
  }
  return -1;
}

function linesOf(post: unknown): Line[] {
  const record = asRecord(post);
  if (record == null) return [];
  const messages = readField(record, "messages");
  const input = readField(record, "input");
  const rows = Array.isArray(messages) ? messages : Array.isArray(input) ? input : [];
  const lines: Line[] = [];
  for (const row of rows) {
    const rec = asRecord(row);
    if (rec == null) continue;
    const role = readField(rec, "role");
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(readField(rec, "content"));
    if (text === "") continue;
    lines.push({ role, text });
  }
  return lines;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const rec = asRecord(part);
    if (rec == null) continue;
    const text = readField(rec, "text");
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("");
}
