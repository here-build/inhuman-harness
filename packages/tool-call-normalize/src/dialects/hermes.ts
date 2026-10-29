import type { Dialect, ExtractResult, RawToolCall } from "../types.js";
import { createMarkupStepState, extractJsonNameCertain, stepMarkup, type MarkupStepState } from "./step-common.js";

const BLOCK = /<tool_call\s*>([\s\S]*?)(?:<\/tool_call\s*>|$)/gi;
const OPEN = /<tool_call\s*>/i;
const CLOSE = /<\/tool_call\s*>/i;

const OPENS = ["<tool_call>"];
const CLOSES = ["</tool_call>"];

export const hermesDialect: Dialect<MarkupStepState> = {
  id: "hermes",
  markers: ["<tool_call>"],
  openMarkers: OPENS,
  closeMarkers: CLOSES,
  // JSON-bodied — no argument-value markup delimiter to declare (task D1).
  valueDelimiters: [],
  autoPriority: 50,
  allowAuto: true,
  allowStreamAuto: true,
  claim(text, pos) {
    const slice = text.slice(pos, pos + 200);
    if (/<arg_key\b/i.test(slice) || /<longcat/i.test(slice)) return false;
    if (/<function\s*=/i.test(slice)) return false;
    return /\{/.test(slice) || /<\/tool_call>/i.test(slice);
  },
  createStreamState: createMarkupStepState,
  step(state, buffer, _ctx) {
    return stepMarkup(state, buffer, {
      openMarkers: OPENS,
      closeMarkers: CLOSES,
      detectName: (body) => extractJsonNameCertain(body),
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
    }> = [];
    const re = new RegExp(BLOCK.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const full = m[0]!;
      const truncated = !CLOSE.test(full);
      const openM = full.match(OPEN);
      const openLen = openM ? openM[0].length : 0;
      const closeM = full.match(new RegExp(String.raw`${CLOSE.source}\s*$`, "i"));
      const closeLen = closeM ? closeM[0].length : 0;
      const bodyStart = m.index + openLen;
      const bodyEnd = m.index + full.length - closeLen;
      replacements.push({
        start: m.index,
        end: m.index + full.length,
        maskedBody: text.slice(bodyStart, bodyEnd),
        originalBody: payload.slice(bodyStart, bodyEnd),
        truncated,
      });
    }
    const raw_calls: RawToolCall[] = [];
    const truncated: number[] = [];
    let content = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i]!;
      content = content.slice(0, r.start) + content.slice(r.end);
    }
    for (const r of replacements) {
      // Structure: first `{` on masked (fences blanked). Payload: original.
      const jsonStart = r.maskedBody.indexOf("{");
      if (jsonStart !== -1) {
        if (r.truncated) truncated.push(raw_calls.length);
        raw_calls.push({
          form: "json",
          bodyJson: r.originalBody.slice(jsonStart),
          rawName: "",
        });
      }
    }
    return {
      content: content.length > 0 ? content : null,
      raw_calls,
      toolSpans: replacements.map((r) => ({ start: r.start, end: r.end })),
      truncated,
    };
  },
};
