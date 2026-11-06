/**
 * Tool / scheme / loop layout. Agent knowledge stays here — not in Quickdraw.
 * Cover chrome is Tea; this file paints the in-tape ask gutter and ask pin.
 * `approvalComment` rides identity status. Policy and judge votes do not —
 * waiting is the `?` gutter, not an `ask` / `allow` word. The pin follows
 * `askPaintHead` — a mutate
 * Diff stays the pin until its result is a tape row, not merely until `approved`.
 * Work voice is `foreground` at a prominence step — same hue as speech, quieter
 * than body. Live flux is the spinner, not a `running` hue. Fail is the gutter
 * (`error`), not a red row.
 */
import { type BlobPeek, type KernelRoot, ProgrammaticJob, ToolCallJob } from "@inhuman.tools/harness-model";
import { stripVt } from "@inhuman.tools/harness-model/vt-text";
import {
  formatIdentity,
  formatMutateIdentity,
  isMutateName,
  isSchemeBagName,
  SCHEME_REPL_NAME,
  SCHEME_WATCH_NAME,
  compactOmitsTool,
  mutateSuggestionReceipt,
  workCellFace,
  type ReceiptFace,
  type WorkCellFace,
  type WorkCellState,
} from "@inhuman.tools/harness-sdk/text";
import {
  INDICATION_CONTENT_INSET,
  INDICATION_EXPAND_GLYPH,
  INDICATION_VOID_GLYPH,
  type LayoutNode,
} from "@inhuman.tools/quickdraw/layout";
import { FgP } from "@inhuman.tools/quickdraw/lexicon";
import { Diff, Indication, Markdown, SyntaxBlock, SyntaxLine, Text } from "@inhuman.tools/quickdraw/widgets";
import { ShadowStream } from "@inhuman.tools/quickdraw/widgets/shadow-stream";

import type { WorkReceiptKind } from "./paint-types.js";
import { highlightSchemePart, highlightSugarcoat, type SchemePaintPart } from "./sugarcoat-paint.js";
import { VtText } from "./vt-paint.js";

// The face layer lives in `work-text.ts` of `@inhuman.tools/harness-sdk/text` (no quickdraw).
// One door for paint importers and tests.
export {
  receiptPlainText,
  workCellFace,
  type CallStatus,
  type ReceiptFace,
  type WorkCellFace,
  type WorkCellState,
} from "@inhuman.tools/harness-sdk/text";

export const SIGIL_TOOL = "·";
export const SIGIL_SHELL = "$";
export const SIGIL_SCHEME_REPL = "⒪";
export const SIGIL_SCHEME_WATCH = "⒲";
export const SIGIL_ASK = "?";
/** Same seat as `SIGIL_TOOL`, but the classifier is evaluating, not executing. */
export const SIGIL_JUDGE = "?";

/** Same hue as speech. Ask is in hand; sealed/live recede; meta recedes further. */
const ASK_VOICE = { role: "foreground" as const, prominence: FgP.primary };
const WORK_VOICE = { role: "foreground" as const, prominence: FgP.rising };
const WORK_META = { role: "foreground" as const, prominence: FgP.ghost };

type WorkVoice = typeof ASK_VOICE | typeof WORK_VOICE;

export function receiptFromReplica(
  kind: WorkReceiptKind,
  text: string,
  diff: { readonly old: string; readonly new: string; readonly path: string; readonly lineStart?: number },
): ReceiptFace {
  if (kind === "diff") {
    return {
      kind: "diff",
      old: diff.old,
      new: diff.new,
      path: diff.path,
      ...(diff.lineStart === undefined || diff.lineStart <= 1 ? {} : { lineStart: diff.lineStart }),
    };
  }
  if (kind === "none") return { kind: "none" };
  if (kind === "parts") {
    let parts: SchemePaintPart[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        parts = parsed.filter((value): value is SchemePaintPart => {
          if (value === null || typeof value !== "object") return false;
          const rec = value as { kind?: unknown; text?: unknown };
          return (
            (rec.kind === "text" ||
              rec.kind === "markdown" ||
              rec.kind === "number" ||
              rec.kind === "boolean" ||
              rec.kind === "syntax") &&
            typeof rec.text === "string"
          );
        });
      }
    } catch {
      parts = [];
    }
    return { kind: "parts", parts };
  }
  return { kind, text };
}

function shellOutputBox(text: string, key: string, width: number): LayoutNode {
  return squareBox(
    VtText(text, {
      key: `${key}:out`,
      width: Math.max(1, width - 2),
      style: WORK_META,
    }),
    `${key}:out-box`,
    width,
  );
}

function pushShellReceipt(kids: LayoutNode[], face: WorkCellFace, width: number): void {
  const receipt = face.receipt;
  if (receipt.kind === "text") {
    kids.push(shellOutputBox(receipt.text, face.key, width));
    return;
  }
  if (receipt.kind === "parts") {
    for (const [i, part] of receipt.parts.entries()) {
      if (part.kind !== "text") {
        kids.push(receiptBody(part, `${face.key}:${i}`, width));
        continue;
      }
      kids.push(VtText(part.text, { key: `${face.key}:policy`, width, style: WORK_META }));
    }
    return;
  }
  const extra = receiptContent(receipt, face.key, width);
  if (extra !== undefined) kids.push(extra);
}

function squareBox(child: LayoutNode, key: string, width: number): LayoutNode {
  return {
    type: "box",
    key,
    style: { border: true, width },
    children: [child],
  };
}

function voidRow(key: string, child: LayoutNode): LayoutNode {
  return Indication({
    key,
    gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
    children: [child],
  });
}

function receiptContent(face: ReceiptFace, key: string, width: number): LayoutNode | undefined {
  if (face.kind === "none" || face.kind === "diff") return undefined;
  if (face.kind === "stream") {
    return ShadowStream({
      primitive: "",
      lines: stripVt(face.text),
      state: "peek",
      height: 5,
      width,
      role: "foreground",
      key: `${key}:tail`,
    });
  }
  if (face.kind === "markdown") {
    return Markdown(face.text, { key: `${key}:md`, width, style: WORK_META });
  }
  if (face.kind === "parts") {
    return {
      type: "flex",
      key: `${key}:parts`,
      style: { direction: "column", width },
      children: face.parts.map((part, i) => receiptBody(part, `${key}:${i}`, width)),
    };
  }
  return receiptBody(face, key, width);
}

function receiptNode(
  face: ReceiptFace,
  key: string,
  width: number,
  opts?: { stickyBottomRows?: number },
): LayoutNode | undefined {
  if (face.kind === "none") return undefined;
  if (face.kind === "diff") {
    return Diff({
      old: face.old,
      new: face.new,
      path: face.path,
      width,
      hideHeader: true,
      // Sides stay whole for syntax and line numbers. Diff elides at paint.
      stickyBottomRows: opts?.stickyBottomRows,
      lineStart: face.lineStart,
      key: `${key}:diff`,
    });
  }
  const contentW = Math.max(8, width - INDICATION_CONTENT_INSET);
  const inner = receiptContent(face, key, contentW);
  if (inner === undefined) return undefined;
  if (face.kind === "stream") return inner;
  return voidRow(face.kind === "markdown" ? `${key}:md-row` : `${key}:body-row`, inner);
}

function receiptBody(part: SchemePaintPart, key: string, width: number): LayoutNode {
  if (part.kind === "markdown") {
    return Markdown(part.text, { key: `${key}:md`, width, style: WORK_META });
  }
  if (part.kind === "text") {
    return VtText(part.text, {
      key: `${key}:body`,
      width,
      style: WORK_META,
    });
  }
  return SyntaxBlock(part.text, {
    key: `${key}:body`,
    width,
    lines: highlightSchemePart(part),
  });
}

function identityStyle(state: WorkCellState): WorkVoice {
  return state === "ask" ? ASK_VOICE : WORK_VOICE;
}

const MUTATE_CAPTION_GAP = 2;

function cols(text: string): number {
  return [...text].length;
}

function mutateIdentity(face: WorkCellFace, width: number, voice: WorkVoice): LayoutNode {
  const pathText = formatMutateIdentity(face, width);
  if (face.caption === "") {
    return Text(pathText, {
      key: `${face.key}:text`,
      whiteSpace: "nowrap",
      ellipsis: true,
      lineClamp: 1,
      style: voice,
    });
  }
  const pathBare = face.status === "" ? face.object : `${face.object}  ${face.status}`;
  const fits = cols(pathBare) + MUTATE_CAPTION_GAP + cols(face.caption) <= width;
  const path = Text(fits ? pathBare : pathText, {
    key: `${face.key}:path`,
    whiteSpace: "nowrap",
    ellipsis: true,
    lineClamp: 1,
    style: voice,
  });
  const caption = Text(face.caption, {
    key: `${face.key}:caption`,
    whiteSpace: fits ? "nowrap" : "normal",
    style: WORK_META,
  });
  return {
    type: "box",
    key: `${face.key}:id-wrap`,
    style: { width },
    children: [
      {
        type: "flex",
        key: `${face.key}:id-line`,
        style: fits
          ? {
              direction: "row",
              width,
              justifyContent: "space_between",
              gap: MUTATE_CAPTION_GAP,
              alignItems: "flex_start",
            }
          : { direction: "column", width },
        children: [path, caption],
      },
    ],
  };
}

function scriptLine(face: WorkCellFace, width: number, key: string, wrap = false): LayoutNode {
  if (face.name === "shell") {
    if (wrap || face.object.includes("\n")) {
      return SyntaxBlock(face.object, { lang: "bash", key, width });
    }
    return SyntaxLine(face.object, { lang: "bash", key, width });
  }
  if (face.object.includes("\n")) {
    return SyntaxBlock(face.object, {
      key,
      width,
      lines: highlightSugarcoat(face.object),
    });
  }
  return SyntaxLine(face.object, {
    key,
    width,
    runs: highlightSugarcoat(face.object)[0],
  });
}

function shellCwdLine(face: WorkCellFace): LayoutNode {
  return Text(face.status, {
    key: `${face.key}:status`,
    whiteSpace: "nowrap",
    ellipsis: true,
    lineClamp: 1,
    style: WORK_META,
  });
}

function identityContent(face: WorkCellFace, width: number, voice: WorkVoice, wrapScript = false): LayoutNode {
  if (face.agent) {
    const name = Text(face.object === "" ? face.name : `${face.name} `, {
      key: `${face.key}:name`,
      whiteSpace: "nowrap",
      style: voice,
    });
    if (face.object === "") return name;
    return {
      type: "flex",
      key: `${face.key}:id-line`,
      style: { direction: "row", width },
      children: [
        name,
        Text(face.object, {
          key: `${face.key}:title`,
          whiteSpace: "nowrap",
          ellipsis: true,
          lineClamp: 1,
          style: WORK_META,
        }),
      ],
    };
  }
  if (isSchemeBagName(face.name)) {
    if (face.caption === "") {
      return scriptLine(face, width, `${face.key}:cmd`, wrapScript);
    }
    return Text(face.caption, {
      key: `${face.key}:caption`,
      whiteSpace: "nowrap",
      ellipsis: true,
      lineClamp: 1,
      style: voice,
    });
  }
  if (face.name === "shell") {
    const body =
      face.caption === ""
        ? scriptLine(face, width, `${face.key}:cmd`, wrapScript)
        : Text(face.caption, {
            key: `${face.key}:caption`,
            whiteSpace: "nowrap",
            ellipsis: true,
            lineClamp: 1,
            style: voice,
          });
    // Open caption: the expand script is the call, and cwd follows that script.
    if (face.status === "" || (wrapScript && face.caption !== "")) return body;
    return {
      type: "flex",
      key: `${face.key}:id-stack`,
      style: { direction: "column", width },
      children: [body, shellCwdLine(face)],
    };
  }
  if (face.pretty) {
    const headline = face.status === "" ? face.object : `${face.object}  ${face.status}`;
    const line = Markdown(headline, {
      key: `${face.key}:text`,
      width,
      style: voice,
    });
    if (face.caption === "") return line;
    return {
      type: "flex",
      key: `${face.key}:id-stack`,
      style: { direction: "column", width },
      children: [
        line,
        Text(face.caption, {
          key: `${face.key}:subtitle`,
          whiteSpace: "pre-wrap",
          style: WORK_META,
        }),
      ],
    };
  }
  if (isMutateName(face.name)) {
    return mutateIdentity(face, width, voice);
  }
  if (!face.split) {
    return Text(formatIdentity({ name: face.name, object: face.object, status: face.status }, width, face.pathShaped), {
      key: `${face.key}:text`,
      whiteSpace: "nowrap",
      ellipsis: true,
      lineClamp: 1,
      style: voice,
    });
  }
  const children: LayoutNode[] = [
    Text(`${face.name} `, {
      key: `${face.key}:server`,
      whiteSpace: "nowrap",
      style: WORK_META,
    }),
    Text(face.object, {
      key: `${face.key}:action`,
      whiteSpace: "nowrap",
      ellipsis: true,
      lineClamp: 1,
      style: voice,
    }),
  ];
  if (face.status !== "") {
    children.push(
      Text(`  ${face.status}`, {
        key: `${face.key}:status`,
        whiteSpace: "nowrap",
        style: WORK_META,
      }),
    );
  }
  return {
    type: "flex",
    key: `${face.key}:id-line`,
    style: { direction: "row", width },
    children,
  };
}

function sealedGlyph(name: string): string {
  if (name === "shell") return SIGIL_SHELL;
  if (name === SCHEME_REPL_NAME) return SIGIL_SCHEME_REPL;
  if (name === SCHEME_WATCH_NAME) return SIGIL_SCHEME_WATCH;
  return SIGIL_TOOL;
}

function cellGutter(
  state: WorkCellState,
  name: string,
): { kind: "spinner"; profile: "tool"; rows: "top" } | { kind: "top"; glyph: string } {
  // Waiting for a human wins the seat over the classifier mark, the live
  // spinner, and the sealed glyph (`·`, `$`, `⒪`, `⒲`).
  if (state === "ask") return { kind: "top", glyph: SIGIL_ASK };
  if (state === "judging") return { kind: "top", glyph: SIGIL_JUDGE };
  if (state === "live") return { kind: "spinner", profile: "tool", rows: "top" };
  return { kind: "top", glyph: sealedGlyph(name) };
}

/**
 * Compact omits floor-allow leaves only when `hideFloorTools` is on.
 * Default off: the call stays, including the question identity while it
 * is still open. Comm-first (agent) stays omitted. The scheme bag never
 * fuses. Inners of a bag never fuse — the bag row is their host parent.
 */
export function workCellFuse(work: ToolCallJob | ProgrammaticJob, nested = false, hideFloorTools = false): boolean {
  if (work instanceof ProgrammaticJob) return false;
  return compactOmitsTool(work, hideFloorTools, nested);
}

function pinOmitsIdentity(face: WorkCellFace): boolean {
  return face.rimNamed;
}

/** Pin exists to hold a Diff, or an identity the rim cannot say. MCP options and shell commands ride the composer stack. */
export function askPinWorthPainting(face: WorkCellFace): boolean {
  if (face.split) return false;
  if (face.receipt.kind !== "none") return true;
  return !pinOmitsIdentity(face);
}

/**
 * Sticky pin: typed receipt. Always open. Not a disclosure.
 * No ask gutter — the receipt and the cover already mark the wait.
 * Rim-named work omits the identity line. No receipt and no identity → do not mount.
 */
export function askPinNode(face: WorkCellFace, width: number): LayoutNode {
  const body = receiptNode(face.receipt, face.key, width, {
    stickyBottomRows: 4,
  });
  if (pinOmitsIdentity(face)) {
    return {
      type: "box",
      key: face.key,
      style: { width, padding: { t: 1 } },
      children: body === undefined ? [] : [body],
    };
  }
  const contentW = Math.max(8, width - INDICATION_CONTENT_INSET);
  const identity = voidRow(`${face.key}:id`, identityContent(face, contentW, identityStyle(face.state)));
  return {
    type: "box",
    key: face.key,
    style: { width, padding: { t: 1 } },
    children: body === undefined ? [identity] : [identity, body],
  };
}

export function askPinFace(
  work: ToolCallJob | ProgrammaticJob,
  kernel?: KernelRoot | null,
  blobs?: BlobPeek,
): WorkCellFace {
  const face = workCellFace(work, `ask:${work.toolCallId}`, false, false, "", kernel, blobs);
  if (!(work instanceof ToolCallJob)) return face;
  const suggestion = mutateSuggestionReceipt(work, blobs);
  if (suggestion.kind === "none") return face;
  return { ...face, receipt: suggestion };
}

export function workDisclosure(face: WorkCellFace, width: number): LayoutNode {
  const allocW = face.indent ? Math.max(8, width - 2) : width;
  const textW = Math.max(8, allocW - INDICATION_CONTENT_INSET);
  const voice = identityStyle(face.state);
  const gutterStyle = face.state === "fail" ? { role: "error" as const } : voice;
  const identity = Indication({
    key: `${face.key}:id`,
    gutter: cellGutter(face.state, face.name),
    style: gutterStyle,
    children: [identityContent(face, textW, voice)],
  });
  const identityOpen = Indication({
    key: `${face.key}:id`,
    gutter: cellGutter(face.state, face.name),
    style: gutterStyle,
    children: [identityContent(face, textW, voice, true)],
  });
  // File reads stay one line: `Read <path>`. No click, no body.
  if (face.name === "read_file") {
    const row: LayoutNode = {
      type: "box",
      key: face.key,
      style: { width: allocW },
      children: [identity],
    };
    if (!face.indent) return row;
    return {
      type: "box",
      key: `${face.key}:indent`,
      style: { padding: { l: 2 }, width },
      children: [row],
    };
  }
  const scriptInner =
    face.caption !== "" && (face.name === "shell" || isSchemeBagName(face.name))
      ? scriptLine(face, textW, `${face.key}:script`, face.name === "shell")
      : undefined;
  const prettyInner =
    face.prettyBlock !== "" && face.receipt.kind !== "diff"
      ? Markdown(face.prettyBlock, {
          key: face.agent ? `${face.key}:spawn` : `${face.key}:pretty-md`,
          width: textW,
          style: WORK_META,
        })
      : undefined;
  const livePeek = face.state === "live" && face.receipt.kind === "stream";
  // Mutations are the review surface: filename, then Diff. Click-collapse would hide the change.
  if (isMutateName(face.name)) {
    const extras = [
      ...(scriptInner === undefined ? [] : [voidRow(`${face.key}:script`, scriptInner)]),
      ...(prettyInner === undefined ? [] : [voidRow(`${face.key}:pretty-block`, prettyInner)]),
    ];
    const body = livePeek ? undefined : receiptNode(face.receipt, face.key, allocW);
    const peek = livePeek ? receiptNode(face.receipt, face.key, allocW) : undefined;
    const open: LayoutNode[] = [identity, ...extras];
    if (peek !== undefined) open.push(peek);
    if (body !== undefined) open.push(body);
    const block: LayoutNode = {
      type: "box",
      key: face.key,
      style: { width: allocW },
      children: open,
    };
    if (!face.indent) return block;
    return {
      type: "box",
      key: `${face.key}:indent`,
      style: { padding: { l: 2 }, width },
      children: [block],
    };
  }
  const extraKids: LayoutNode[] = [];
  if (scriptInner !== undefined) extraKids.push(scriptInner);
  if (face.name === "shell" && face.caption !== "" && face.status !== "") extraKids.push(shellCwdLine(face));
  if (prettyInner !== undefined) extraKids.push(prettyInner);
  if (face.agent && face.response !== "") extraKids.push(agentResponseBlock(face, textW));
  if (face.name === "shell") {
    pushShellReceipt(extraKids, face, textW);
  } else {
    const extraReceipt = receiptContent(face.receipt, face.key, textW);
    if (extraReceipt !== undefined) extraKids.push(extraReceipt);
  }
  const extras =
    extraKids.length === 0
      ? []
      : [
          Indication({
            key: `${face.key}:open`,
            gutter: { kind: "rule", glyph: INDICATION_EXPAND_GLYPH },
            style:
              face.state === "fail"
                ? { role: "error", prominence: FgP.ghost }
                : { role: "foreground", prominence: FgP.ghost },
            children: extraKids,
          }),
        ];
  const disclosure: LayoutNode = {
    type: "disclosure",
    key: face.key,
    collapsed: livePeek ? false : face.collapsed,
    intent: "activate",
    onClick: { type: "toggle_collapsed", blockId: face.key },
    userSelect: "none",
    summary: identity,
    children: [identityOpen, ...extras],
  };
  if (!face.indent) return disclosure;
  return {
    type: "box",
    key: `${face.key}:indent`,
    style: { padding: { l: 2 }, width },
    children: [disclosure],
  };
}

/**
 * Bottom of an expanded agent call: a quiet "Response" rule, then the reply
 * at speech voice — brighter than the prompt stacked above it.
 */
function agentResponseBlock(face: WorkCellFace, width: number): LayoutNode {
  return {
    type: "flex",
    key: `${face.key}:response`,
    style: { direction: "column", width, padding: { t: 1 } },
    children: [
      Text("Response", {
        key: `${face.key}:response-label`,
        whiteSpace: "nowrap",
        style: WORK_META,
      }),
      Markdown(face.response, {
        key: `${face.key}:response-body`,
        width,
        style: { role: "foreground", prominence: FgP.secondary },
      }),
    ],
  };
}
