/**
 * IR helpers: assemble stream events → batch NormalizeMessageResult.
 * Target: normalizeMessage = assembleEvents(session ingest/close)
 * (audit-011 C5 — by construction when stream path is complete).
 */
import type {
  FinishReason,
  NormalizeEvent,
  NormalizeMessageResult,
  NormalizeMeta,
  StreamFinishReason,
  ToolCall,
} from "./types.js";

function emptyMeta(dialect = "unknown"): NormalizeMeta {
  return {
    dialect,
    estimated: false,
    toolsInThinkingCount: 0,
    dropped: [],
    ambiguous: [],
    partial: [],
    untypedArgs: false,
    renamed: [],
  };
}

/**
 * Fold IR events into a batch-shaped result.
 *
 * Laws:
 * - tool_calls = tool_call_end events in order (skip partial if dropPartials)
 * - content = concat text_delta. How the network happened to slice the SSE
 *   stream must never change what the user reads: stream and batch content
 *   identity is the contract (conservation.test.ts, split-invariance.test.ts).
 *   The require-known/drop-unknown seam (assemble used to reject-replay
 *   dropped-unknown markup as live text while batch stripped it) is closed:
 *   name-certainty decides fate (normalize-stream.ts's `commit`) — a span
 *   that reached name-certainty is machinery and is never painted, whether
 *   its terminal fate is call or dropped, matching batch's unconditional
 *   cleanupContent() strip of every extracted toolSpan. Two pre-existing
 *   suites (channels.stream.test.ts's two "unknown tool span"/"reject after
 *   unterminated think" cases, live-tools.stream.test.ts's "strict gates
 *   live probe" case) still assert the superseded reject-replay behavior for
 *   this exact seam and are currently red pending their own update — not a
 *   license to reintroduce the strip-vs-paint gap this note used to track.
 * - reasoning = concat reasoning_delta
 * - meta from last meta event, or synthesized from drops
 * - finish_reason from finish event
 */
export function assembleEvents(events: NormalizeEvent[], opts?: { dropPartials?: boolean }): NormalizeMessageResult {
  const dropPartials = opts?.dropPartials ?? true;
  let content = "";
  let reasoning = "";
  const tool_calls: ToolCall[] = [];
  const partial: number[] = [];
  let meta: NormalizeMeta = emptyMeta();
  let finish_reason: FinishReason = null;
  let sawMeta = false;

  for (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        content += ev.text;
        break;
      case "reasoning_delta":
        reasoning += ev.text;
        break;
      case "tool_call_start":
        // open only — end carries args
        break;
      case "tool_call_args_delta":
        // preview only — not assembled into arguments
        break;
      case "tool_call_end": {
        if (ev.partial && dropPartials) {
          // Partial at EOS: not executed; record for consumers that assemble without
          // a prior meta event that already listed partial indices.
          meta.dropped.push({
            name: ev.name,
            reason: "truncated",
          });
          break;
        }
        if (ev.partial) partial.push(tool_calls.length);
        tool_calls.push({
          id: ev.id,
          type: "function",
          function: { name: ev.name, arguments: ev.arguments },
        });
        meta.estimated = true;
        break;
      }
      case "tool_call_drop": {
        // Map stream-only reasons into DropReason for batch meta
        const batchReason =
          ev.reason === "duplicate_native" || ev.reason === "duplicate_recovered" || ev.reason === "fenced"
            ? ("unknown_name" as const)
            : ev.reason === "irreparable_args"
              ? ("unparseable_args" as const)
              : ev.reason === "aborted"
                ? ("truncated" as const)
                : ev.reason;
        meta.dropped.push({
          name: ev.name ?? "",
          reason: batchReason,
        });
        break;
      }
      case "meta": {
        // Preserve drops already recorded from tool_call_drop / partial ends
        // (meta event may be assembled before those were known).
        const streamDropped = meta.dropped;
        meta = { ...ev.meta, partial: [...ev.meta.partial] };
        if (streamDropped.length > 0) {
          meta.dropped = [...streamDropped, ...meta.dropped];
        }
        sawMeta = true;
        break;
      }
      case "finish":
        finish_reason = ev.finish_reason;
        break;
      case "error":
      case "usage":
        break;
    }
  }

  if (!sawMeta && partial.length > 0) {
    meta.partial = partial;
  } else if (sawMeta && partial.length > 0 && meta.partial.length === 0) {
    meta.partial = partial;
  }

  const contentOut = content.trimEnd();
  return {
    content: contentOut.length > 0 ? contentOut : null,
    tool_calls,
    reasoning_content: reasoning.trimEnd().length > 0 ? reasoning.trimEnd() : null,
    finish_reason,
    meta,
  };
}

/** Map provider finish_reason into stream finish enum (includes content_filter). */
export function streamFinishReason(raw: string | null | undefined, toolsFound: boolean): StreamFinishReason {
  if (raw === "content_filter") return "content_filter";
  if (raw === "length") return "length";
  if (raw === "error" || raw === "aborted") {
    return raw === "aborted" ? "aborted" : "error";
  }
  if (raw === "tool_calls" || toolsFound) return toolsFound ? "tool_calls" : "stop";
  return "stop";
}
