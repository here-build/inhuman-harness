/**
 * Stream / IR test DX (Phase A — collect mode).
 * See audit-011-stream-test-dx.md: Turbine-style collect first; probe later.
 *
 * Collection drives createStreamSession.ingest/close — the live consumer path
 * (openai-compat-driver), not a test-only async wrapper.
 */
import invariant from "tiny-invariant";
import { expect } from "vitest";

import {
  createStreamSession,
  assembleEvents,
  type NormalizeEvent,
  type NormalizeOptions,
  type OpenAiChatChunk,
  type StreamDropReason,
  type StreamFinishReason,
} from "../index.js";

export type Chunk = string | OpenAiChatChunk;

export type EventMatcher =
  | { type: "text_delta"; text?: string | RegExp; textIncludes?: string; textExcludes?: string }
  | { type: "reasoning_delta"; text?: string | RegExp; textIncludes?: string }
  | { type: "tool_call_start"; name: string; index?: number; id?: string | RegExp }
  | {
      type: "tool_call_args_delta";
      argumentsDeltaIncludes?: string;
      index?: number;
    }
  | {
      type: "tool_call_end";
      name: string;
      arguments?: unknown;
      argumentsRaw?: string | RegExp;
      partial?: boolean;
      index?: number;
    }
  | {
      type: "tool_call_drop";
      reason: StreamDropReason | StreamDropReason[];
      name?: string | null;
      index?: number;
    }
  | { type: "finish"; finish_reason: StreamFinishReason }
  | { type: "meta" }
  | { type: "error"; messageIncludes?: string; recoverable?: boolean };

export const text = (t: string | RegExp | { includes?: string; excludes?: string }): EventMatcher =>
  typeof t === "object" && !(t instanceof RegExp)
    ? {
        type: "text_delta",
        textIncludes: t.includes,
        textExcludes: t.excludes,
      }
    : { type: "text_delta", text: t };

export const reasoning = (t: string | RegExp): EventMatcher => ({
  type: "reasoning_delta",
  text: t,
});

export const start = (name: string, extra?: { index?: number; id?: string }): EventMatcher => ({
  type: "tool_call_start",
  name,
  ...extra,
});

export const end = (name: string, args?: unknown, extra?: { partial?: boolean; index?: number }): EventMatcher => ({
  type: "tool_call_end",
  name,
  arguments: args,
  ...extra,
});

export const drop = (
  reason: StreamDropReason | StreamDropReason[],
  extra?: { name?: string | null },
): EventMatcher => ({ type: "tool_call_drop", reason, ...extra });

export const finish = (finish_reason: StreamFinishReason): EventMatcher => ({
  type: "finish",
  finish_reason,
});

function matchText(
  actual: string,
  m: { text?: string | RegExp; textIncludes?: string; textExcludes?: string },
): boolean {
  if (m.text instanceof RegExp) return m.text.test(actual);
  if (typeof m.text === "string" && actual !== m.text) return false;
  if (m.textIncludes !== undefined && !actual.includes(m.textIncludes)) return false;
  if (m.textExcludes !== undefined && actual.includes(m.textExcludes)) return false;
  return true;
}

function matchOne(ev: NormalizeEvent, m: EventMatcher): boolean {
  if (ev.type !== m.type) return false;
  switch (m.type) {
    case "text_delta":
      return ev.type === "text_delta" && matchText(ev.text, m);
    case "reasoning_delta":
      return ev.type === "reasoning_delta" && matchText(ev.text, m);
    case "tool_call_start":
      return (
        ev.type === "tool_call_start" &&
        ev.name === m.name &&
        (m.index === undefined || ev.index === m.index) &&
        (m.id === undefined || (typeof m.id === "string" ? ev.id === m.id : m.id.test(ev.id)))
      );
    case "tool_call_args_delta":
      return (
        ev.type === "tool_call_args_delta" &&
        (m.argumentsDeltaIncludes === undefined || ev.argumentsDelta.includes(m.argumentsDeltaIncludes)) &&
        (m.index === undefined || ev.index === m.index)
      );
    case "tool_call_end": {
      if (ev.type !== "tool_call_end" || ev.name !== m.name) return false;
      if (m.partial !== undefined && Boolean(ev.partial) !== m.partial) return false;
      if (m.index !== undefined && ev.index !== m.index) return false;
      if (m.argumentsRaw !== undefined) {
        if (m.argumentsRaw instanceof RegExp) return m.argumentsRaw.test(ev.arguments);
        return ev.arguments === m.argumentsRaw;
      }
      if (m.arguments !== undefined) {
        try {
          return JSON.stringify(JSON.parse(ev.arguments)) === JSON.stringify(m.arguments);
        } catch {
          return false;
        }
      }
      return true;
    }
    case "tool_call_drop": {
      if (ev.type !== "tool_call_drop") return false;
      const reasons = Array.isArray(m.reason) ? m.reason : [m.reason];
      if (!reasons.includes(ev.reason)) return false;
      if (m.name !== undefined && ev.name !== m.name) return false;
      return true;
    }
    case "finish":
      return ev.type === "finish" && ev.finish_reason === m.finish_reason;
    case "meta":
      return ev.type === "meta";
    case "error":
      return (
        ev.type === "error" &&
        (m.messageIncludes === undefined || ev.message.includes(m.messageIncludes)) &&
        (m.recoverable === undefined || ev.recoverable === m.recoverable)
      );
    default:
      return false;
  }
}

function dumpEvents(events: NormalizeEvent[]): string {
  return events
    .map((e, i) => {
      if (e.type === "text_delta") return `${i}: text ${JSON.stringify(e.text.slice(0, 80))}`;
      if (e.type === "tool_call_start") return `${i}: start ${e.name} #${e.index}`;
      if (e.type === "tool_call_end") return `${i}: end ${e.name} partial=${Boolean(e.partial)}`;
      if (e.type === "tool_call_drop") return `${i}: drop ${e.name} ${e.reason}`;
      if (e.type === "finish") return `${i}: finish ${e.finish_reason}`;
      return `${i}: ${e.type}`;
    })
    .join("\n");
}

/**
 * Collect stream and assert a subsequence of matchers in order
 * (other events may appear between — use expectSequenceExact for tight).
 */
export function expectSequence(
  events: NormalizeEvent[],
  matchers: EventMatcher[],
  opts?: { exact?: boolean; skipOrdering?: boolean },
): void {
  if (!opts?.skipOrdering) {
    try {
      assertIrOrdering(events);
    } catch (error) {
      throw new Error(`${(error as Error).message}\nEvents:\n${dumpEvents(events)}`);
    }
  }
  if (opts?.exact) {
    expect(events.length, dumpEvents(events)).toBe(matchers.length);
    for (let i = 0; i < matchers.length; i++) {
      if (!matchOne(events[i]!, matchers[i]!)) {
        expect.fail(
          `event[${i}] mismatch\nexpected ${JSON.stringify(matchers[i])}\ngot ${JSON.stringify(events[i])}\n\n${dumpEvents(events)}`,
        );
      }
    }
    return;
  }
  let j = 0;
  for (let i = 0; i < events.length && j < matchers.length; i++) {
    if (matchOne(events[i]!, matchers[j]!)) j++;
  }
  if (j < matchers.length) {
    expect.fail(
      `sequence incomplete: matched ${j}/${matchers.length}\n` +
        `next expected: ${JSON.stringify(matchers[j])}\n\n${dumpEvents(events)}`,
    );
  }
}

/** Assert IR ordering laws. */
export function assertIrOrdering(events: NormalizeEvent[]): void {
  const open = new Map<number, "start">();
  let finished = false;
  let metaAt = -1;
  let finishAt = -1;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    invariant(!finished, `event after finish at ${i}: ${ev.type}`);
    switch (ev.type) {
      case "tool_call_start":
        invariant(!open.has(ev.index), `duplicate start for index ${ev.index}`);
        open.set(ev.index, "start");
        break;
      case "tool_call_args_delta":
        invariant(open.has(ev.index), `args_delta without start index ${ev.index}`);
        break;
      case "tool_call_end":
      case "tool_call_drop":
        invariant(open.has(ev.index), `${ev.type} without start index ${ev.index}`);
        open.delete(ev.index);
        break;
      case "meta":
        metaAt = i;
        break;
      case "finish":
        finishAt = i;
        finished = true;
        break;
      case "text_delta":
      case "reasoning_delta":
      case "error":
      case "usage":
        break;
    }
  }
  invariant(open.size === 0, `unclosed tool indices: ${[...open.keys()].join(",")}`);
  invariant(
    finishAt < 0 || metaAt < 0 || metaAt === finishAt - 1,
    `meta must immediately precede finish (meta@${metaAt} finish@${finishAt})`,
  );
}

/** Collect IR events via createStreamSession.ingest/close. */
export function collectEvents(chunks: Iterable<Chunk>, opts?: NormalizeOptions): NormalizeEvent[] {
  const session = createStreamSession(opts);
  const out: NormalizeEvent[] = [];
  for (const chunk of chunks) {
    for (const ev of session.ingest(chunk)) out.push(ev);
  }
  for (const ev of session.close()) out.push(ev);
  return out;
}

export async function runStream(chunks: Chunk[], opts?: NormalizeOptions): Promise<NormalizeEvent[]> {
  return collectEvents(chunks, opts);
}

/** tools + finish_reason parity (content seams ignored). */
export function assertToolsFinishParity(
  streamEvents: NormalizeEvent[],
  batch: {
    tool_calls: Array<{ function: { name: string; arguments: string } }>;
    finish_reason: string | null;
  },
): void {
  const assembled = assembleEvents(streamEvents);
  expect(
    assembled.tool_calls.map((t) => ({
      name: t.function.name,
      arguments: JSON.parse(t.function.arguments),
    })),
  ).toEqual(
    batch.tool_calls.map((t) => ({
      name: t.function.name,
      arguments: JSON.parse(t.function.arguments),
    })),
  );
  const streamFin = streamEvents.find((e) => e.type === "finish");
  if (streamFin?.type === "finish" && batch.finish_reason) {
    // batch null → stop-like
    const want =
      batch.finish_reason === "tool_calls" ||
      batch.finish_reason === "length" ||
      batch.finish_reason === "content_filter" ||
      batch.finish_reason === "error" ||
      batch.finish_reason === "aborted"
        ? batch.finish_reason
        : batch.finish_reason === null
          ? streamFin.finish_reason
          : "stop";
    if (
      want !== streamFin.finish_reason &&
      batch.finish_reason !== null && // allow stream tool_calls vs batch tool_calls when both have tools
      !(
        batch.tool_calls.length > 0 &&
        streamFin.finish_reason === "tool_calls" &&
        (batch.finish_reason === "tool_calls" || batch.finish_reason === "stop")
      )
    ) {
      expect(streamFin.finish_reason).toBe(batch.finish_reason);
    }
  }
}
