import type { Dialect, ExtractResult, RawToolCall } from "../types.js";
import {
  createMarkupStepState,
  extractJsonNameCertain,
  extractLongcatTaggedName,
  findCloseEnd,
  findCloseMarkerLen,
  stepMarkup,
  type MarkupStepState,
} from "./step-common.js";

const OPEN = /<longcat[_-]?tool[_-]?call\s*>/gi;
const ARG_KEY = /<longcat[_-]?arg[_-]?key\s*>([\s\S]*?)<\/longcat[_-]?arg[_-]?key\s*>/gi;
const ARG_VAL = /<longcat[_-]?arg[_-]?value\s*>([\s\S]*?)<\/longcat[_-]?arg[_-]?value\s*>/gi;

/**
 * Structure from masked body (fences = spaces); values sliced from original
 * at the same offsets (audit-006 R1a).
 */
function parseArgPairs(maskedBody: string, originalBody: string): Record<string, string> {
  const keys: Array<{ name: string }> = [];
  const vals: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  const keyRe = new RegExp(ARG_KEY.source, "gi");
  const valRe = new RegExp(ARG_VAL.source, "gi");
  while ((m = keyRe.exec(maskedBody)) !== null) {
    keys.push({ name: (m[1] ?? "").trim() });
  }
  while ((m = valRe.exec(maskedBody)) !== null) {
    // capture group offset relative to maskedBody
    const full = m[0]!;
    const openEnd = full.search(/>/) + 1;
    const closeTag = full.match(/<\/longcat[_-]?arg[_-]?value\s*>$/i);
    const closeLen = closeTag ? closeTag[0].length : 0;
    const start = m.index + openEnd;
    const end = m.index + full.length - closeLen;
    vals.push({ start, end });
  }
  const out: Record<string, string> = {};
  const n = Math.min(keys.length, vals.length);
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    const v = vals[i]!;
    if (k.name) out[k.name] = originalBody.slice(v.start, v.end);
  }
  return out;
}

function bodyToRaw(maskedBody: string, originalBody: string): RawToolCall | null {
  const maskedTrim = maskedBody.trim();
  if (!maskedTrim) return null;

  // JSON form ONLY when the body *starts* with `{` (after trim).
  // Never prefer JSON because `{`+name appears inside arg_value (audit-012 C3 / 014 L-H1).
  const leadingJson = /^\s*\{/.exec(maskedBody);
  if (leadingJson) {
    const jsonStart = leadingJson.index + leadingJson[0].indexOf("{");
    const sliceMasked = maskedBody.slice(jsonStart);
    if (/"name"\s*:/.test(sliceMasked) || /'name'\s*:/.test(sliceMasked)) {
      return {
        form: "json",
        bodyJson: originalBody.slice(jsonStart),
        rawName: "",
      };
    }
  }

  // Tagged form: name line from masked (structure), args values from original
  const withoutArgs = maskedBody
    .replaceAll(new RegExp(ARG_KEY.source, "gi"), "")
    .replaceAll(new RegExp(ARG_VAL.source, "gi"), "")
    .trim();
  const nameLine =
    withoutArgs
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const nameRaw = nameLine.replace(/^(function|tool|call)\s+/i, "").trim();
  // Do not salvage mid-body `{` as JSON when a tagged name exists or body is tagged-shaped
  if (!nameRaw) {
    // Empty name + no leading JSON → unparseable
    return null;
  }
  return {
    form: "tagged",
    rawName: nameRaw,
    argsTagged: parseArgPairs(maskedBody, originalBody),
  };
}

const LC_OPENS = ["<longcat_tool_call>", "<longcattoolcall>", "<longcat-tool-call>"];
const LC_CLOSES = ["</longcat_tool_call>", "</longcattoolcall>", "</longcat-tool-call>"];
/** Value delimiter (task D1): declared data, host masks — see step-common.ts. */
const LC_VALUE_DELIMS = [
  {
    open: /<longcat[_-]?arg[_-]?value\s*>/i,
    close: /<\/longcat[_-]?arg[_-]?value\s*>/i,
  },
];

export const longcatDialect: Dialect<MarkupStepState> = {
  id: "longcat",
  // All spellings extract can see — stream hold must include hyphen variants
  // (audit-011 longcat stress: hyphen open not held → paint).
  markers: [...LC_OPENS],
  openMarkers: LC_OPENS,
  closeMarkers: LC_CLOSES,
  valueDelimiters: LC_VALUE_DELIMS,
  autoPriority: 10,
  allowAuto: true,
  allowStreamAuto: true,
  createStreamState: createMarkupStepState,
  step(state, buffer, _ctx) {
    return stepMarkup(state, buffer, {
      openMarkers: LC_OPENS,
      closeMarkers: LC_CLOSES,
      valueDelimiters: LC_VALUE_DELIMS,
      detectName: (body) => {
        // Prefer tagged line; JSON name only when object-leading (see extractLongcatTaggedName)
        return extractLongcatTaggedName(body) ?? extractJsonNameCertain(body);
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
    }> = [];
    // Structure-aware scan: open → findCloseEnd (masks arg_value interiors)
    // so close markers inside values do not truncate (audit-015 N1).
    const openRe = new RegExp(OPEN.source, "gi");
    let m: RegExpExecArray | null;
    let searchFrom = 0;
    while ((m = openRe.exec(text)) !== null) {
      if (m.index < searchFrom) continue;
      const openLen = m[0]!.length;
      const afterOpen = text.slice(m.index + openLen);
      const closeEnd = findCloseEnd(afterOpen, LC_CLOSES, LC_VALUE_DELIMS);
      let end: number;
      let bodyEnd: number;
      let truncated: boolean;
      if (closeEnd >= 0) {
        const closeLen = findCloseMarkerLen(afterOpen, LC_CLOSES, LC_VALUE_DELIMS);
        end = m.index + openLen + closeEnd;
        bodyEnd = end - closeLen;
        truncated = false;
      } else {
        end = text.length;
        bodyEnd = text.length;
        truncated = true;
      }
      const bodyStart = m.index + openLen;
      replacements.push({
        start: m.index,
        end,
        maskedBody: text.slice(bodyStart, bodyEnd),
        originalBody: payload.slice(bodyStart, bodyEnd),
        truncated,
      });
      searchFrom = end;
      openRe.lastIndex = end;
    }
    let content = text;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i]!;
      content = content.slice(0, r.start) + content.slice(r.end);
    }
    const ordered: RawToolCall[] = [];
    const truncated: number[] = [];
    for (const r of replacements) {
      const raw = bodyToRaw(r.maskedBody, r.originalBody);
      if (raw) {
        if (r.truncated) truncated.push(ordered.length);
        ordered.push(raw);
      }
    }
    return {
      content: content.length > 0 ? content : null,
      raw_calls: ordered,
      toolSpans: replacements.map((r) => ({ start: r.start, end: r.end })),
      truncated,
    };
  },
};
