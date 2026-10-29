import type { Dialect, ExtractResult, RawToolCall } from "../types.js";
import {
  closeMarkersForOpen,
  createMarkupStepState,
  extractJsonNameCertain,
  findCloseEnd,
  findCloseMarkerLen,
  maskArgValues,
  stepMarkup,
  type MarkupStepState,
} from "./step-common.js";

const WRAP_OPEN = /<tool_call\s*>/i;
const FN_OPEN = /<function\s*=\s*([^>\s]+)\s*>/i;
const PARAM = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;

/** Value delimiter (task D1): declared data, host masks — see step-common.ts. */
const QW_VALUE_DELIMS = [{ open: /<parameter\s*=\s*[^>\s]+\s*>/i, close: /<\/parameter\s*>/i }];

function parseParams(maskedBody: string, originalBody: string): Record<string, string> {
  const argsTagged: Record<string, string> = {};
  const pre = new RegExp(PARAM.source, "gi");
  let pm: RegExpExecArray | null;
  while ((pm = pre.exec(maskedBody)) !== null) {
    const full = pm[0]!;
    const openEnd = full.search(/>/) + 1;
    const closeTag = full.match(/<\/parameter\s*>$/i);
    const closeLen = closeTag ? closeTag[0].length : 0;
    const vStart = pm.index + openEnd;
    const vEnd = pm.index + full.length - closeLen;
    let v = originalBody.slice(vStart, vEnd);
    if (v.startsWith("\n")) v = v.slice(1);
    if (v.endsWith("\n")) v = v.slice(0, -1);
    argsTagged[pm[1]!.trim()] = v;
  }
  return argsTagged;
}

const QW_OPENS = ["<function=", "<tool_call>"];
const QW_CLOSES = ["</function>", "</tool_call>"];

/** Earliest of the two top-level open forms at/after `from`, or null. */
function nextOpen(
  text: string,
  from: number,
): { start: number; family: "wrap" | "bare"; openLen: number; name?: string } | null {
  const rest = text.slice(from);
  const wrapM = WRAP_OPEN.exec(rest);
  const fnM = FN_OPEN.exec(rest);
  if (!wrapM && !fnM) return null;
  if (wrapM && (!fnM || wrapM.index <= fnM.index)) {
    return { start: from + wrapM.index, family: "wrap", openLen: wrapM[0].length };
  }
  return {
    start: from + fnM!.index,
    family: "bare",
    openLen: fnM![0].length,
    name: (fnM![1] ?? "").trim(),
  };
}

export const qwenXmlDialect: Dialect<MarkupStepState> = {
  id: "qwen_xml",
  markers: ["<function=", "<tool_call>"],
  openMarkers: QW_OPENS,
  closeMarkers: QW_CLOSES,
  valueDelimiters: QW_VALUE_DELIMS,
  autoPriority: 40,
  allowAuto: true,
  allowStreamAuto: true,
  claim(text, pos) {
    return /<function\s*=/i.test(text.slice(pos, pos + 400));
  },
  createStreamState: createMarkupStepState,
  step(state, buffer, _ctx) {
    return stepMarkup(state, buffer, {
      openMarkers: QW_OPENS,
      closeMarkers: QW_CLOSES,
      valueDelimiters: QW_VALUE_DELIMS,
      detectName: (body, openTag) => {
        // Bare: open marker is `<function=` — body begins `NAME>...`
        if (/^<function=/i.test(openTag)) {
          const m = /^([^>\s]+)\s*>/.exec(body);
          if (m?.[1]) return m[1].trim();
        }
        // Wrapped <tool_call>…<function=NAME>
        const fm = /<function\s*=\s*([^>\s]+)\s*>/i.exec(body);
        if (fm?.[1]) return fm[1].trim();
        return extractJsonNameCertain(body);
      },
    });
  },
  extract(text, ctx = {}): ExtractResult {
    const payload = ctx.original ?? text;
    const replacements: Array<{
      start: number;
      end: number;
      maskedBody: string;
      originalBody: string;
      truncated: boolean;
      rawName: string;
    }> = [];

    // Structure-aware scan: for each top-level open (wrap OR bare, earliest
    // first), findCloseEnd masks argument-value interiors (task D1) so a
    // close-marker-lookalike embedded in a value can never truncate the
    // outer match or leak its tail into user-visible content (audit-repros
    // n1-repro-b). closeMarkersForOpen keeps a `<tool_call>` wrapper from
    // closing at its inner `<function=…>`'s own `</function>`.
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const open = nextOpen(text, searchFrom);
      if (!open) break;
      const openTagFamily = open.family === "wrap" ? "<tool_call>" : "<function=";
      const closes = closeMarkersForOpen(openTagFamily, QW_CLOSES);
      const bodyStart = open.start + open.openLen;
      const afterOpen = text.slice(bodyStart);
      const closeEnd = findCloseEnd(afterOpen, closes, QW_VALUE_DELIMS);

      let end: number;
      let bodyEnd: number;
      let truncated: boolean;
      if (closeEnd >= 0) {
        const closeLen = findCloseMarkerLen(afterOpen, closes, QW_VALUE_DELIMS);
        end = bodyStart + closeEnd;
        bodyEnd = end - closeLen;
        truncated = false;
      } else {
        end = text.length;
        bodyEnd = text.length;
        truncated = true;
      }

      const rawBody = text.slice(bodyStart, bodyEnd);
      const maskedBody = maskArgValues(rawBody, QW_VALUE_DELIMS, QW_CLOSES);

      let rawName: string;
      if (open.family === "bare") {
        rawName = open.name ?? "";
      } else {
        const fm = FN_OPEN.exec(maskedBody);
        rawName = fm?.[1]?.trim() ?? "";
      }

      if (!rawName) {
        // No function name found in this span — nothing to claim; advance
        // past the open marker itself so scanning makes progress.
        searchFrom = open.start + open.openLen;
        continue;
      }

      replacements.push({
        start: open.start,
        end,
        maskedBody,
        originalBody: payload.slice(bodyStart, bodyEnd),
        truncated,
        rawName,
      });
      searchFrom = end;
    }

    const raw_calls: RawToolCall[] = [];
    const truncated: number[] = [];
    let content = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i]!;
      content = content.slice(0, r.start) + content.slice(r.end);
    }
    for (const r of replacements) {
      if (r.truncated) truncated.push(raw_calls.length);
      raw_calls.push({
        form: "tagged",
        rawName: r.rawName,
        argsTagged: parseParams(r.maskedBody, r.originalBody),
      });
    }
    return {
      content: content.length > 0 ? content : null,
      raw_calls,
      toolSpans: replacements.map((r) => ({ start: r.start, end: r.end })),
      truncated,
    };
  },
};
