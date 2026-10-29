/**
 * Transcript speech / recall. Glyph and role only — no session, no PEW.
 * Prompt and reply share one voice (foreground @ primary). Bold + ❯ is the
 * user mark, one cell inside a surface floor at mist. Replies do not recede
 * to muted or secondary.
 */
import { Markdown } from "./markdown.js";
import { Text } from "./text.js";
import { INDICATION_CONTENT_INSET, INDICATION_VOID_GLYPH, type LayoutNode } from "../layout/index.js";
import { BgP, FgP } from "../lexicon/index.js";

/**
 * `"12:00 AM"` is 8 cells. Shorter `H:MM AM/PM` faces right-pad in this slot
 * so AM/PM stays a column — do not shrink-wrap the clock.
 */
export const SPEECH_STAMP_CELLS = 8;
export const SPEECH_STAMP_GAP = 1;
export const SPEECH_STAMP_RESERVE = SPEECH_STAMP_CELLS + SPEECH_STAMP_GAP;

const STAMP_VOICE = { role: "foreground" as const, prominence: FgP.ghost };

export function speechBodyWidth(contentW: number): number {
  return Math.max(8, contentW - SPEECH_STAMP_RESERVE);
}

/** Local wall clock. `H:MM AM/PM` — no leading hour zero. */
export function formatClock12h(atMs: number): string {
  if (!Number.isFinite(atMs)) return "";
  const date = new Date(atMs);
  const minutes = date.getMinutes();
  let hour = date.getHours();
  const suffix = hour >= 12 ? "PM" : "AM";
  hour %= 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function stampFace(atMs: number | null | undefined): string {
  if (atMs == null || !Number.isFinite(atMs)) return "";
  return formatClock12h(atMs).padStart(SPEECH_STAMP_CELLS, " ");
}

function withStampRail(body: LayoutNode, opts: { key: string; contentW: number; atMs?: number | null }): LayoutNode {
  const bodyW = speechBodyWidth(opts.contentW);
  return {
    type: "box",
    key: `${opts.key}:rail`,
    style: { width: opts.contentW },
    children: [
      {
        type: "flex",
        key: `${opts.key}:cols`,
        style: { direction: "row", gap: SPEECH_STAMP_GAP, alignItems: "flex_start" },
        children: [
          {
            type: "box",
            key: `${opts.key}:body`,
            style: { width: bodyW, flex: 1 },
            children: [body],
          },
          {
            type: "box",
            key: `${opts.key}:stamp`,
            style: { width: SPEECH_STAMP_CELLS, height: 1 },
            children: [
              Text(stampFace(opts.atMs), {
                key: `${opts.key}:stamp-text`,
                whiteSpace: "nowrap",
                userSelect: "none",
                style: STAMP_VOICE,
              }),
            ],
          },
        ],
      },
    ],
  };
}

function indication(opts: {
  key: string;
  gutter: NonNullable<Extract<LayoutNode, { type: "indication" }>["gutter"]>;
  style?: Extract<LayoutNode, { type: "indication" }>["style"];
  children: LayoutNode[];
}): LayoutNode {
  return {
    type: "indication",
    key: opts.key,
    gutter: opts.gutter,
    style: opts.style,
    children: opts.children,
  };
}

export const SIGIL_USER = "❯";

const USER_BLOCK_PAD = 1;
/** Law 6 gap, so user prose stays in the same column as a reply. */
const USER_MARK_GAP = 1;
/** Neutral floor: hue and chroma stay on the `surface` seed. Mist is the low BG step. */
const USER_BLOCK_BG = { bgRole: "surface" as const, bgProminence: BgP.mist };

/** Stamp-rail width for a user floor in a column of `columnW`. */
export function userSpeechRailWidth(columnW: number): number {
  return Math.max(8, columnW - USER_BLOCK_PAD * 2 - 1 - USER_MARK_GAP);
}

/** Indication inset, then the user floor's right pad, so both clocks share a column. */
export function replySpeechRailWidth(columnW: number): number {
  return Math.max(8, columnW - INDICATION_CONTENT_INSET - USER_BLOCK_PAD);
}

/** Body of a prompt or a reply. User adds bold; fail swaps the role. */
const SPEECH_VOICE = { role: "foreground" as const, prominence: FgP.primary };

export type SpeechVoice = "user" | "assistant";

export type SpeechModel = {
  readonly text: string;
  readonly voice?: SpeechVoice;
  readonly live?: boolean;
  readonly failed?: boolean;
  /** Epoch ms. Null keeps the 8-cell rail empty. */
  readonly atMs?: number | null;
};

export function Speech(model: SpeechModel, opts: { key: string; width?: number }): LayoutNode {
  const voice = model.voice ?? "assistant";
  const key = opts.key;
  const contentW = opts.width ?? 48;
  const bodyW = speechBodyWidth(contentW);
  const rail = (body: LayoutNode) => withStampRail(body, { key, contentW, atMs: model.atMs });
  if (voice === "user") {
    const userVoice = { ...SPEECH_VOICE, bold: true };
    const body =
      model.text === ""
        ? Text(model.text, {
            key: `${key}:text`,
            whiteSpace: "pre-wrap",
            style: userVoice,
          })
        : Markdown(model.text, { key: `${key}:md`, width: bodyW, style: SPEECH_VOICE });
    return {
      type: "box",
      key: `${key}:speech-user`,
      style: { padding: USER_BLOCK_PAD, background: USER_BLOCK_BG },
      children: [
        {
          type: "flex",
          key: `${key}:user-line`,
          style: { direction: "row", gap: USER_MARK_GAP, alignItems: "flex_start" },
          children: [
            Text(SIGIL_USER, {
              key: `${key}:chevron`,
              whiteSpace: "nowrap",
              style: userVoice,
            }),
            rail(body),
          ],
        },
      ],
    };
  }
  const live = model.live === true;
  const failed = model.failed === true;
  const bodyVoice = failed ? { role: "error" as const } : SPEECH_VOICE;
  const body =
    failed || model.text === ""
      ? Text(model.text, {
          key: `${key}:text`,
          whiteSpace: "pre-wrap",
          style: bodyVoice,
        })
      : Markdown(model.text, { key: `${key}:md`, width: bodyW, style: bodyVoice });
  return indication({
    key: `${key}:speech`,
    gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
    style: {
      role: failed ? "error" : "foreground",
      prominence: live && !failed ? FgP.rising : FgP.primary,
    },
    children: [rail(body)],
  });
}

type SpeechRail = {
  rail: Extract<LayoutNode, { type: "box" }>;
  cols: Extract<LayoutNode, { type: "flex" }>;
  bodyBox: Extract<LayoutNode, { type: "box" }>;
  body: LayoutNode;
};

function railBox(node: LayoutNode): Extract<LayoutNode, { type: "box" }> | undefined {
  if (node.type === "indication") {
    const rail = node.children?.[0];
    return rail?.type === "box" ? rail : undefined;
  }
  if (node.type !== "box") return undefined;
  const row = node.children?.[0];
  if (row?.type !== "flex") return undefined;
  const rail = row.children?.[1];
  return rail?.type === "box" ? rail : undefined;
}

function speechRail(rail: Extract<LayoutNode, { type: "box" }>): SpeechRail | null {
  const cols = rail.children?.[0];
  if (cols?.type !== "flex") return null;
  const bodyBox = cols.children?.[0];
  const body = bodyBox?.type === "box" ? bodyBox.children?.[0] : undefined;
  if (bodyBox?.type !== "box" || body == undefined) return null;
  return { rail, cols, bodyBox, body };
}

function railWithBody(parts: SpeechRail, body: LayoutNode): Extract<LayoutNode, { type: "box" }> {
  return {
    ...parts.rail,
    children: [
      {
        ...parts.cols,
        children: [{ ...parts.bodyBox, children: [body] }, ...(parts.cols.children?.slice(1) ?? [])],
      },
    ],
  };
}

/** Markdown / text child inside the stamp rail. */
export function speechBodyNode(node: LayoutNode): LayoutNode | undefined {
  const rail = railBox(node);
  if (rail == null) return undefined;
  return speechRail(rail)?.body;
}

export function replaceSpeechBody(node: LayoutNode, body: LayoutNode): LayoutNode {
  const rail = railBox(node);
  if (rail == null) return node;
  const parts = speechRail(rail);
  if (parts == null) return node;
  const nextRail = railWithBody(parts, body);
  if (node.type === "indication") {
    return { ...node, children: [nextRail, ...(node.children?.slice(1) ?? [])] };
  }
  if (node.type !== "box") return node;
  const row = node.children?.[0];
  if (row?.type !== "flex") return node;
  const chevron = row.children?.[0];
  if (chevron == null) return node;
  return {
    ...node,
    children: [
      { ...row, children: [chevron, nextRail, ...(row.children?.slice(2) ?? [])] },
      ...(node.children?.slice(1) ?? []),
    ],
  };
}

export function Recall(text: string, opts: { key: string }): LayoutNode {
  return indication({
    key: `${opts.key}:row`,
    gutter: { kind: "top", glyph: INDICATION_VOID_GLYPH },
    children: [
      Text(text, {
        key: `${opts.key}:text`,
        whiteSpace: "pre-wrap",
        style: { role: "muted" },
      }),
    ],
  });
}
