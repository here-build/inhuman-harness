/**
 * Thin constructors over LayoutNode. No agent knowledge. No elementAt.
 */

import { createMarkdownExpandStream } from "./expand.js";
import { Markdown } from "./markdown.js";
import { ShadowStream, type ShadowStreamState } from "./shadow-stream.js";
import { Text } from "./text.js";
import {
  type Intent,
  type LayoutNode,
  type SpinnerProfile,
  type UserSelect,
  elapsedLive,
  INDICATION_CONTENT_INSET,
  INDICATION_EXPAND_GLYPH,
  layoutChildren,
  RETRY_COUNTDOWN_MEASURE,
  retryCountdownLive,
} from "../layout/index.js";
import { type Rgb, type SemanticRole, FgP } from "../lexicon/index.js";
import { displayWidth, splitAtWidth } from "../measure/index.js";

/** Live wait before first thought/speech token. Same timer grain as `thinking`. */
export const WAITING_RESPONSE = "waiting for response...";
/** Unseated running pin. The worker has not checked in. */
export const CONNECTING = "connecting...";
/** Live tool or agent occupancy. */
export const USING_TOOLS = "using tools...";
/** Live speech occupancy — no tools or agents on the pin. */
export const RESPONDING = "responding...";
/** @deprecated Use {@link USING_TOOLS}. */
export const WORKING = USING_TOOLS;
export * from "./composer-frame.js";
export { COMPOSER_COMMAND_MAX_VISIBLE as COMPOSER_COMMAND_MAX_VISIBLE } from "./composer-picker.js";
export * from "./composer-command.js";
export {
  catalogKey as catalogKey,
  peekScroll as peekScroll,
  reconcileSelectedKey as reconcileSelectedKey,
} from "./composer-picker.js";
// The inverse of the composer frame's own geometry — click cell back to draft
// offset. It lives beside the forward map rather than in `harness-surface`,
// which no whiteroom host may depend on (cli.md §2).
export * from "./composer-click.js";
export * from "./composer-caret.js";
export * from "./shadow-stream.js";
export {
  createMarkdownExpandStream as createMarkdownExpandStream,
  expandWidgetPriors as expandWidgetPriors,
} from "./expand.js";
export {
  syntaxPolarity as syntaxPolarity,
  syntaxWarm as syntaxWarm,
  type SyntaxPolarity as SyntaxPolarity,
} from "./internals/syntax.js";
export { bootSyntax as bootSyntax, SyntaxBlock as SyntaxBlock, SyntaxLine as SyntaxLine } from "./syntax-boot.js";
export type { HighlightLine as HighlightLine, TokenRun as TokenRun } from "./internals/syntax.js";
export * from "./markdown.js";
export * from "./diff.js";
export * from "./text.js";
export {
  Recall as Recall,
  Speech as Speech,
  SPEECH_STAMP_CELLS as SPEECH_STAMP_CELLS,
  SPEECH_STAMP_GAP as SPEECH_STAMP_GAP,
  SPEECH_STAMP_RESERVE as SPEECH_STAMP_RESERVE,
  replaceSpeechBody as replaceSpeechBody,
  speechBodyNode as speechBodyNode,
  replySpeechRailWidth as replySpeechRailWidth,
  speechBodyWidth as speechBodyWidth,
  userSpeechRailWidth as userSpeechRailWidth,
} from "./speech.js";
export {
  completionSlots as completionSlots,
  hasThoughtRow as hasThoughtRow,
  transcriptColumn as transcriptColumn,
} from "./transcript.js";
export type { TranscriptPart as TranscriptPart } from "./transcript.js";

/**
 * Compatible with buffer Style without depending on buffer.
 * Truecolor + role/prominence for H-K salience paint (theme stories).
 *
 * `role`/`bgRole`/`prominence`/`bgProminence` are the authoring vocabulary —
 * every call site in this file states those, never `dim`/`fg`/`bg`. The bare
 * fields stay on the type only for call sites elsewhere not yet migrated
 * (storybook, harness); this file no longer produces any of them.
 */
type TextStyle = {
  bold?: boolean;
  dim?: boolean;
  strike?: boolean;
  fg?: number;
  bg?: number;
  fgRgb?: Rgb;
  bgRgb?: Rgb;
  role?: SemanticRole;
  bgRole?: SemanticRole;
  prominence?: number;
  bgProminence?: number;
  regionProminence?: number;
  selected?: boolean;
  surfaceRole?: SemanticRole;
  surfaceProminence?: number;
};

export const REASONING_COLLAPSED = "⁖";

export const LIVE_PEEK_LINES = 3;

/**
 * Named spinner gutter — logic only names the profile.
 * Glyph + Hz resolve at paint; Frame.liveDemand drives present.
 */
function SpinnerGutter(
  profile: SpinnerProfile = "thinking",
  opts?: { rows?: "top" | "all" },
): {
  kind: "spinner";
  profile: SpinnerProfile;
  rows?: "top" | "all";
} {
  return {
    kind: "spinner",
    profile,
    rows: opts?.rows ?? "top",
  };
}

// ── ThinkingStream ──────────────────────────────────────────────────────────

/** Same hue as speech, receded to the desk. */
const THOUGHT_VOICE = {
  role: "foreground" as const,
  prominence: FgP.secondary,
};

/** Folded gutter (⁖ marker, omission chrome): thought voice + glyph weight. */
const THOUGHT_GUTTER_COLLAPSED: TextStyle = {
  ...THOUGHT_VOICE,
  bold: true,
};

/** Live-collapsed shell: same voice, no glyph weight (spinner carries it). */
const THOUGHT_GUTTER_LIVE: TextStyle = THOUGHT_VOICE;

export type ThinkingModel = {
  text: string;
  live: boolean;
  collapsed?: boolean;
  seal?: "live" | "sealed";
  durationMs?: number;
  startedAt?: number;
  retryUntilMs?: number;
  bootstrapping?: boolean;
  /** Occupancy pin copy. Empty live thought uses this instead of connecting/waiting. */
  occupancyLabel?: string;
  agentLabel?: string;
  thoughtKind?: string;
  latest?: boolean;
  peekLines?: number;
  shadowState?: ShadowStreamState;
  surfaceRole?: SemanticRole;
  surfaceProminence?: number;
  birthFloor?: number;
  tipWindow?: number;
  wavefront?: boolean;
};

/**
 * Reasoning / thinking indication — harness cognition register.
 *
 * Visual contract:
 * - **live + collapsed** (latest): {@link ShadowStream} peek — `⁖` gutter (flux
 *   lives on the occupancy pin); extra peek rows are a dim `┃`. Opacity
 *   wavefront is opt-in (`wavefront: true`). Peek lines are markdown-rendered.
 * - **sealed + collapsed + latest**: same peek without the wavefront; `⁖` gutter;
 *   primitive is `thought for Ns`.
 * - **sealed + collapsed + older**: one-line squeeze — `thought for Ns` + faded tail.
 * - **live + expanded**: `⁖` on the header row; thought body is a dim `┃`.
 * - **sealed + expanded**: `⁖` on `thought for Ns`; thought body is a dim `┃`.
 * - **summary** (`thoughtKind: "summary"`): last annotation as chrome only
 *   (`looking for answers for 5s`). No sneak-peek overlay, no expand.
 * - **omitted sealed**: `⁖` + attribution copy. Click expands when there is a body.
 *
 * Paint is foreground @ secondary. Collapsed peek age-fades from rising so
 * the newest line stays quieter than thought voice.
 *
 * Click anywhere on the indication toggles collapsed (intent activate + onClick),
 * except summary and omitted (nothing to expand).
 */
export function ThinkingStream(model: ThinkingModel, opts: { key: string; width?: number }): LayoutNode {
  const isLive = model.live || model.seal === "live";
  const isSealed = model.seal === "sealed" || (!isLive && model.seal !== "live");
  const raw = (model.text ?? "").replaceAll(/^\s+|\s+$/gu, "");
  const hasBody = raw.trim().length > 0;
  const summaryHeading = model.thoughtKind === "summary" ? lastSummaryHeading(raw) : "";
  const collapsed = model.collapsed !== false;
  const width = opts.width ?? 48;
  const contentW = Math.max(8, width - INDICATION_CONTENT_INSET);
  const peekN = Math.max(1, model.peekLines ?? LIVE_PEEK_LINES);
  const occupancyLabel = (model.occupancyLabel ?? "").trim();
  const spinGutter =
    occupancyLabel !== "" ? SpinnerGutter("thinking") : { kind: "top" as const, glyph: REASONING_COLLAPSED };
  const shadowState: ShadowStreamState = model.shadowState ?? (collapsed ? "peek" : "expanded");

  function liveChromeLabel(): string {
    if (occupancyLabel !== "") return occupancyLabel;
    if (!hasBody) return model.bootstrapping === true ? CONNECTING : WAITING_RESPONSE;
    return summaryHeading || "thinking";
  }

  function retryUntil(): number | undefined {
    const until = model.retryUntilMs;
    if (until == null || !Number.isFinite(until)) return undefined;
    return until;
  }

  function liveElapsed(startedAt: number): ReturnType<typeof elapsedLive> {
    if (summaryHeading !== "") {
      return elapsedLive(startedAt, { prefix: `${summaryHeading} for ` });
    }
    return elapsedLive(startedAt, { label: liveChromeLabel() });
  }

  function liveChrome(): ReturnType<typeof elapsedLive> | ReturnType<typeof retryCountdownLive> | undefined {
    const until = retryUntil();
    if (until !== undefined) return retryCountdownLive(until);
    if (model.bootstrapping === true) return undefined;
    if (model.startedAt != null && Number.isFinite(model.startedAt)) return liveElapsed(model.startedAt);
    return undefined;
  }

  function liveChromeMeasure(): string {
    if (retryUntil() !== undefined) return RETRY_COUNTDOWN_MEASURE;
    if (summaryHeading !== "") return `${summaryHeading} for 99m 99s`;
    return `${liveChromeLabel()} · 99m 99s`;
  }

  function liveHeader(style: TextStyle): LayoutNode {
    const live = liveChrome();
    if (live !== undefined) {
      return Text(liveChromeMeasure(), {
        key: `${opts.key}:hdr`,
        style,
        live,
      });
    }
    return Text(hasBody ? liveThinkingLabel(model.durationMs, summaryHeading) : liveChromeLabel(), {
      key: `${opts.key}:hdr`,
      style,
    });
  }

  if (isSealed && !hasBody) {
    return Indication({
      key: opts.key,
      gutter: { kind: "top", glyph: REASONING_COLLAPSED },
      style: THOUGHT_GUTTER_COLLAPSED,
      intent: "none",
      userSelect: "none",
      children: [
        Text(formatThoughtOmitted(model.agentLabel, model.durationMs), {
          key: `${opts.key}:t`,
          style: THOUGHT_VOICE,
        }),
      ],
    });
  }

  if (model.thoughtKind === "summary") {
    return Indication({
      key: opts.key,
      gutter: isLive ? spinGutter : { kind: "top", glyph: REASONING_COLLAPSED },
      style: isLive ? THOUGHT_GUTTER_LIVE : THOUGHT_GUTTER_COLLAPSED,
      intent: "none",
      userSelect: "none",
      children: [
        isLive
          ? liveHeader(THOUGHT_VOICE)
          : Text(formatThoughtDuration(model.durationMs, summaryHeading), {
              key: `${opts.key}:hdr`,
              style: THOUGHT_VOICE,
            }),
      ],
    });
  }

  const onClick = {
    type: "toggle_collapsed" as const,
    blockId: opts.key,
  };

  const summary = liveCollapsedSummary();

  return {
    type: "disclosure",
    key: opts.key,
    collapsed,
    intent: "activate",
    onClick,
    userSelect: "none",
    summary,
    children: expandedOpen(),
  };

  function liveCollapsedSummary(): LayoutNode {
    const lines = thoughtPeekLines(raw, contentW, opts.key, isLive);
    const latest = isLive || model.latest === true;
    const peek = latest || isLive;
    const primLabel = isLive
      ? liveChrome() === undefined
        ? hasBody
          ? liveThinkingLabel(model.durationMs, summaryHeading)
          : liveChromeLabel()
        : liveChromeMeasure()
      : formatThoughtDuration(model.durationMs, summaryHeading);
    const shadow = ShadowStream({
      key: `${opts.key}:shadow`,
      primitive: primLabel,
      lines: peek ? lines : lines.slice(-1),
      state: shadowState === "expanded" ? "peek" : shadowState,
      width: contentW,
      height: peek ? peekN : 1,
      role: THOUGHT_VOICE.role,
      base: FgP.rising,
      surfaceRole: model.surfaceRole,
      surfaceProminence: model.surfaceProminence,
      birthFloor: model.birthFloor,
      tipWindow: model.tipWindow,
      wavefront: isLive && model.wavefront === true,
      primitiveLive: isLive ? liveChrome() : undefined,
    });
    const shadowKids = shadow.type === "flex" && Array.isArray(shadow.children) ? shadow.children : [shadow];
    const rest = isLive ? shadowKids.slice(1) : [];
    const headKids = rest.length > 0 ? shadowKids.slice(0, 1) : shadowKids;
    const headInd = Indication({
      key: `${opts.key}:sum`,
      gutter: isLive ? spinGutter : { kind: "top", glyph: REASONING_COLLAPSED },
      style: isLive ? THOUGHT_GUTTER_LIVE : THOUGHT_GUTTER_COLLAPSED,
      userSelect: "none",
      children: headKids.length > 0 ? headKids : shadowKids,
    });
    if (rest.length === 0) return headInd;
    return {
      type: "flex",
      key: `${opts.key}:sum-col`,
      style: { direction: "column", width },
      children: [
        headInd,
        Indication({
          key: `${opts.key}:sum-bar`,
          gutter: { kind: "rule", glyph: INDICATION_EXPAND_GLYPH },
          style: { role: "foreground", prominence: FgP.ghost },
          userSelect: "none",
          children: rest,
        }),
      ],
    };
  }

  function expandedOpen(): LayoutNode[] {
    const header = Indication({
      key: `${opts.key}:hdr-row`,
      gutter: isLive ? spinGutter : { kind: "top", glyph: REASONING_COLLAPSED },
      style: isLive ? THOUGHT_GUTTER_LIVE : THOUGHT_GUTTER_COLLAPSED,
      userSelect: "none",
      children: [
        isLive
          ? liveHeader(THOUGHT_VOICE)
          : Text(formatThoughtDuration(model.durationMs, summaryHeading), {
              key: `${opts.key}:hdr`,
              style: THOUGHT_VOICE,
            }),
      ],
    });
    if (!raw) return [header];
    return [
      header,
      Indication({
        key: `${opts.key}:open`,
        gutter: { kind: "rule", glyph: INDICATION_EXPAND_GLYPH },
        style: { role: "foreground", prominence: FgP.ghost },
        userSelect: "none",
        children: [
          Markdown(raw, {
            key: `${opts.key}:md`,
            style: THOUGHT_VOICE,
          }),
        ],
      }),
    ];
  }
}

export function Indication(opts: {
  key?: string;
  gutter: NonNullable<Extract<LayoutNode, { type: "indication" }>["gutter"]>;
  style?: TextStyle;
  intent?: Intent;
  onClick?: unknown;
  userSelect?: UserSelect;
  children: LayoutNode[];
}): LayoutNode {
  return {
    type: "indication",
    key: opts.key,
    gutter: opts.gutter,
    intent: opts.intent,
    onClick: opts.onClick,
    style: opts.style,
    userSelect: opts.userSelect,
    children: opts.children,
  };
}

/** Peek rows: markdown-rendered, source newlines kept as visual rows. */
function thoughtPeekLines(raw: string, width: number, key: string, live: boolean): string[] {
  // CommonMark collapses single `\n`; two-space breaks keep stream rows in the peek.
  const md = expandThoughtMarkdown(raw.replaceAll("\n", "  \n"), {
    key: `${key}:peek-md`,
    width,
    live,
    style: THOUGHT_VOICE,
  });
  const lines = flattenVisualLines(md);
  return lines.length > 0 ? lines : wrapThoughtLines(raw, width);
}

function expandThoughtMarkdown(
  raw: string,
  opts: { key: string; width: number; live: boolean; style: TextStyle },
): LayoutNode {
  return createMarkdownExpandStream().pull({
    content: raw,
    live: opts.live,
    width: opts.width,
    key: opts.key,
    style: opts.style,
  });
}

function flattenVisualLines(node: LayoutNode): string[] {
  if (node.type === "text") {
    // Keep leaf edge spaces — they are the gap before the next inline
    // span. Leaf-trim glued `mentions ` + `code` → `mentionspackages`.
    return (node.content ?? "").split("\n");
  }
  const kids = layoutChildren(node);
  if (node.type === "flex") {
    const dir = node.style?.direction ?? "row";
    if (dir !== "column" && dir !== "column_reverse") {
      const line = kids.map((c) => flattenVisualLines(c).join("")).join("");
      return line.trim().length > 0 ? [line.trimEnd()] : [];
    }
  }
  const out: string[] = [];
  for (const k of kids) {
    for (const line of flattenVisualLines(k)) {
      if (line.trim().length > 0) out.push(line.trimEnd());
    }
  }
  return out;
}

/**
 * Soft-wrap thought prose for the peek window.
 * Prefer existing newlines; otherwise pack words to width.
 */
export function wrapThoughtLines(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    const t = para.trimEnd();
    if (!t.trim()) continue;
    if (displayWidth(t) <= w) {
      out.push(t);
      continue;
    }
    const words = t.split(/\s+/).filter(Boolean);
    let line = "";
    for (let word of words) {
      // A word with no breakable spaces (e.g. CJK prose) can be wider than the
      // budget on its own. Force-split it by display columns so every emitted
      // line fits, regardless of glyph width.
      while (displayWidth(word) > w) {
        const [head, tail] = splitAtWidth(word, w);
        if (line && displayWidth(line) + 1 + displayWidth(head) <= w) {
          out.push(`${line} ${head}`);
          line = "";
        } else {
          out.push(head);
        }
        word = tail;
      }
      if (!line) {
        line = word;
        continue;
      }
      if (displayWidth(line) + 1 + displayWidth(word) <= w) {
        line = `${line} ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * When the agent ran a thinking phase but did not stream thought text
 * (common: Claude omits display). Attribute to the model, not the host.
 * Optional duration: `Claude did not share the thinking · 3.4s`
 */
function formatThoughtOmitted(agentLabel: string | undefined, durationMs?: number): string {
  const who = (agentLabel?.trim() || "The model").replaceAll(/\s+/g, " ");
  const base = `${who} did not share the thinking`;
  if (durationMs != null && Number.isFinite(durationMs) && durationMs >= 500) {
    return `${base} · ${formatDurationCompact(durationMs)}`;
  }
  return base;
}

/** Sealed chrome: `thought for 3.4s`, or `{heading} for 3.4s` when a summary line exists. */
function formatThoughtDuration(ms: number | undefined, heading?: string): string {
  const noun = heading !== undefined && heading !== "" ? heading : "thought";
  if (ms == null || !Number.isFinite(ms) || ms < 0) return noun;
  return `${noun} for ${formatDurationCompact(ms)}`;
}

function liveThinkingLabel(ms: number | undefined, heading?: string): string {
  const verb = heading !== undefined && heading !== "" ? heading : "thinking";
  if (ms == null || !Number.isFinite(ms) || ms < 500) return verb;
  if (heading !== undefined && heading !== "") return `${verb} for ${formatDurationCompact(ms)}`;
  return `${verb} · ${formatDurationCompact(ms)}`;
}

/** Last non-empty summary line, markdown emphasis unwrapped. HTML comments skipped. */
function lastSummaryHeading(text: string): string {
  const chunks = text.split(/\n+/);
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const line = unwrapSummaryHeading(chunks[i]!);
    if (line !== "") return line;
  }
  return "";
}

function unwrapSummaryHeading(line: string): string {
  let s = line.trim();
  if (s === "" || /^<!--[\s\S]*-->$/u.test(s)) return "";
  s = s.replace(/^#{1,6}\s+/u, "");
  while (true) {
    const wrapped = /^(\*{1,3}|_{1,3})((?:(?!\1).)+)\1$/u.exec(s);
    if (wrapped === null) break;
    s = wrapped[2]!.trim();
  }
  s = s.replaceAll(/\*\*(.+?)\*\*/gu, "$1").replaceAll(/__(.+?)__/gu, "$1");
  return s.replaceAll(/\s+/gu, " ").trim();
}

function formatDurationCompact(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return "<1s";
  if (s < 60) {
    const r = s < 10 ? Number(s.toFixed(1)) : Math.round(s);
    return `${r}s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
