/**
 * ComposerFrame — TEA widget leaf for boxed prompt chrome.
 *
 * One declaration. Values (draft, annotation, progress, status, command
 * rows) ride the composer box; layout's `chrome_frame` strategy paints
 * edges. Speculative echo and progress ease live on the host.
 *
 * @see quickdraw/layout/src/chrome_frame.ts
 */

import {
  actionHotkeys,
  autocompleteRemainder,
  commandToChoice,
  fallbackToChoice,
  matchComposerCommand,
  type ComposerCommand,
  type ComposerCommandChoice,
  type ComposerCommandFallback,
} from "./composer-command.js";
import {
  COMPOSER_COMMAND_MAX_VISIBLE,
  ensureChoiceKeys,
  paintOverlayLines,
  paintNumberedOverlayLines,
  paintPicker,
} from "./composer-picker.js";
import { paintSyntaxOverlayLines } from "./internals/overlay-syntax.js";
import {
  type ChromeFramePickerRow,
  type ChromeHotkey,
  type ChromeQuotaWindow,
  type ChromeStatusItem,
  type LayoutNode,
  CHROME_FRAME_DEFAULT_GLYPH,
  chromeFrameTextWidth,
} from "../layout/index.js";
import { FgP } from "../lexicon/index.js";

export type ComposerErrorAnnotation = {
  readonly level: "warning" | "error";
  readonly message: string;
};

export type ComposerFrameModel = {
  inputValue?: string;
  placeholder?: string;
  hotkeys?: readonly ChromeHotkey[] | null;
  modHeld?: boolean;
  annotation?: string | null;
  /** T-join right-rail when stacked (session title above the input). */
  joinAnnotation?: string | null;
  /** Ignored here — Tea seats the error on the wait pin, not ╭╮. */
  errorAnnotation?: ComposerErrorAnnotation | null;
  progress?: number;
  progressColor?: string;
  progressGlowAt?: number;
  progressAnnotation?: string | null;
  statusItems?: readonly ChromeStatusItem[];
  quotaWindows?: readonly ChromeQuotaWindow[];
  contextUsed?: number;
  contextLimit?: number;
  contourRole?: string;
  commands?: readonly ComposerCommand[];
  /** When set (even empty), wins over {@link commands} for the panel. */
  commandChoices?: readonly ComposerCommandChoice[];
  commandAction?: ComposerCommandFallback | null;
  /** Wins the ╭╮ annotation slot when there is no stack. */
  commandAnnotation?: string | null;
  /** Wins over {@link selectedCommandIndex}. */
  selectedCommandKey?: string | null;
  selectedCommandIndex?: number;
  scrollOffset?: number;
  pickerHoverKey?: string | null;
  pickerPressKey?: string | null;
  pickerViewport?: number;
  /** Ignored when a picker is open. Empty / omitted → no panel. */
  stackedBody?: string | null;
  stackedViewport?: number;
  /** MCP confirm stays off. */
  stackedNumbered?: boolean;
  /** Numbered stacks ignore this. */
  stackedLang?: string | null;
  glyph?: string;
  cursor?: number;
  mark?: number | null;
  interactive?: boolean;
  readOnly?: boolean;
  selected?: boolean;
};

export type ComposerFrameOpts = {
  key: string;
  width: number;
  omitTop?: boolean;
  joinTop?: boolean;
  joinBottom?: boolean;
  plainBottom?: boolean;
};

function modelHotkeys(hotkeys: ComposerFrameModel["hotkeys"]): ChromeHotkey[] | undefined {
  if (hotkeys == null || hotkeys.length === 0) return undefined;
  const out = hotkeys.filter((hotkey) => hotkey.key.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

function statusItemsOf(model: ComposerFrameModel): ChromeStatusItem[] | undefined {
  if (!model.statusItems || model.statusItems.length === 0) return undefined;
  const items = model.statusItems.filter((item) => {
    const text = typeof item === "string" ? item : item.text;
    return text.trim().length > 0;
  });
  return items.length > 0 ? items : undefined;
}

function quotaWindowsOf(model: ComposerFrameModel): ChromeQuotaWindow[] | undefined {
  if (!model.quotaWindows || model.quotaWindows.length === 0) return undefined;
  const windows = model.quotaWindows.filter((window) => Number.isFinite(window.remainingPercent));
  return windows.length > 0 ? windows : undefined;
}

function annotationOf(model: ComposerFrameModel): {
  text?: string;
  role?: string;
} {
  const ann = (model.annotation ?? "").trim();
  return ann.length > 0 ? { text: ann } : {};
}

function resolveChoices(model: ComposerFrameModel): {
  rows: readonly ComposerCommandChoice[];
  selectedName: string | null;
} | null {
  if (model.commandChoices !== undefined) {
    if (model.commandChoices.length > 0) {
      return { rows: model.commandChoices, selectedName: null };
    }
    if (model.commandAction) {
      return { rows: [fallbackToChoice(model.commandAction)], selectedName: null };
    }
    return null;
  }
  const commands = model.commands ?? [];
  if (commands.length === 0) return null;
  const input = model.inputValue ?? "";
  const match = matchComposerCommand(input, commands);
  if (match.matches.length > 0) {
    return {
      rows: match.matches.map(commandToChoice),
      selectedName: match.selected?.name ?? null,
    };
  }
  if (model.commandAction && (input.split("\n")[0] ?? "").trim().startsWith("/")) {
    return { rows: [fallbackToChoice(model.commandAction)], selectedName: null };
  }
  return null;
}

/**
 * TEA leaf: model → `chrome_frame` (plus a T-joined command panel when open).
 */
export function ComposerFrame(model: ComposerFrameModel, opts: ComposerFrameOpts): LayoutNode {
  const inputValue = model.inputValue ?? "";
  const picker = resolveChoices(model);
  const keyed = picker ? ensureChoiceKeys(picker.rows) : [];
  const selectedKey = resolveSelectedKey(keyed, model);
  const selectedIdx = selectedKey == null ? -1 : keyed.findIndex((row) => row.key === selectedKey);
  const selected =
    selectedIdx >= 0 ? selectedIdx : wrapSelected(model.selectedCommandIndex ?? 0, picker?.rows.length ?? 0);
  const hotkeys =
    modelHotkeys(model.hotkeys) ?? (picker === null ? undefined : actionHotkeys(picker.rows[selected]?.actions));
  const stacking = picker !== null || (model.stackedBody ?? "").trimEnd().length > 0;
  const commandDesc = (model.commandAnnotation ?? "").trim();
  const ann = annotationOf(model);
  const slotAnn = !stacking && commandDesc.length > 0 ? { text: commandDesc } : ann;
  const status = statusItemsOf(model);
  const quota = quotaWindowsOf(model);
  const width = Math.max(8, opts.width);
  const joinAnn = (model.joinAnnotation ?? "").trim();

  const readOnly = model.readOnly === true;
  const interactive = model.interactive !== false && !readOnly;
  const completion = pickerCompletion(model, picker, selected);
  const frame: LayoutNode = {
    type: "chrome_frame",
    key: opts.key,
    width,
    draft: inputValue,
    completion,
    placeholder: model.placeholder,
    hotkeys,
    annotation: slotAnn.text,
    annotationRole: slotAnn.role,
    progress: model.progress,
    progressRole: model.progressColor,
    progressGlowAt: model.progressGlowAt,
    progressAnnotation: model.progressAnnotation ?? undefined,
    statusItems: status,
    quotaWindows: quota,
    contextUsed: model.contextUsed,
    contextLimit: model.contextLimit,
    contourRole: model.contourRole,
    glyph: model.glyph ?? CHROME_FRAME_DEFAULT_GLYPH,
    cursor: interactive ? model.cursor : undefined,
    mark: interactive ? model.mark : null,
    interactive,
    readOnly,
    selected: model.selected === true ? true : undefined,
    omitTop: opts.omitTop,
    joinTop: opts.joinTop,
    joinBottom: opts.joinBottom,
    plainBottom: opts.plainBottom,
    modHeld: model.modHeld,
  };

  if (opts.omitTop) return frame;

  if (picker) {
    return stackAbove(
      opts.key,
      commandPanel(picker.rows, selectedKey, model, width, ann.text, hotkeys, ann.role, joinAnn),
      frame,
    );
  }
  const stacked = (model.stackedBody ?? "").trimEnd();
  if (stacked.length === 0) return frame;
  return stackAbove(opts.key, overlayPanel(stacked, model, width, ann.text, hotkeys, ann.role, joinAnn), frame);
}

function stackAbove(
  frameKey: string,
  panel: LayoutNode,
  frame: Extract<LayoutNode, { type: "chrome_frame" }>,
): LayoutNode {
  const stackKey = frameKey.endsWith(":frame") ? `${frameKey.slice(0, -":frame".length)}:stack` : `${frameKey}:stack`;
  return {
    type: "box",
    key: stackKey,
    children: [panel, { ...frame, omitTop: true }],
  };
}

function wrapSelected(index: number, count: number): number {
  if (count <= 0) return Math.max(0, index);
  return ((index % count) + count) % count;
}

function resolveSelectedKey(rows: readonly { key: string }[], model: ComposerFrameModel): string | null {
  return (
    model.selectedCommandKey ??
    rows[wrapSelected(model.selectedCommandIndex ?? 0, rows.length)]?.key ??
    rows[0]?.key ??
    null
  );
}

function toPickerRows(rows: readonly ComposerCommandChoice[]): ChromeFramePickerRow[] {
  return ensureChoiceKeys(rows).map((row) => ({
    key: row.key,
    name: row.name,
    status: row.status,
    annotation: row.annotation,
    description: row.description,
    actionDisplayName: row.actionDisplayName,
    actions: row.actions,
    href: row.href,
  }));
}

/** Overlay fallback rows are labels, not tokens. Catalog and choice names complete. */
function pickerCompletion(
  model: ComposerFrameModel,
  picker: { rows: readonly ComposerCommandChoice[] } | null,
  selected: number,
): string | undefined {
  if (picker === null) return undefined;
  if (model.commandChoices !== undefined && model.commandChoices.length === 0) {
    return undefined;
  }
  if (model.interactive === false) return undefined;
  const input = model.inputValue ?? "";
  const cursor = model.cursor;
  if (cursor !== undefined && cursor !== input.length) return undefined;
  if (model.mark != null && model.mark !== cursor) return undefined;
  const name = picker.rows[selected]?.name ?? "";
  const remainder = autocompleteRemainder(input, name);
  return remainder.length > 0 ? remainder : undefined;
}

function commandPanel(
  rows: readonly ComposerCommandChoice[],
  selectedKey: string | null,
  model: ComposerFrameModel,
  width: number,
  annotation?: string,
  hotkeys?: readonly ChromeHotkey[],
  annotationRole?: string,
  joinAnnotation?: string,
): LayoutNode {
  const keyed = toPickerRows(rows);
  const viewport = model.pickerViewport ?? COMPOSER_COMMAND_MAX_VISIBLE;
  const scrollOffset = model.scrollOffset ?? 0;
  const textW = chromeFrameTextWidth(width);
  const paint = paintPicker({
    rows: keyed,
    selectedKey,
    scrollOffset,
    hoverKey: model.pickerHoverKey ?? null,
    pressKey: model.pickerPressKey ?? null,
    viewport,
    textW,
  });
  let bodySegRows = paint.bodySegRows;
  let bodyGlyphs = paint.bodyGlyphs;
  let bodyRightCoverage = paint.bodyRightCoverage;
  if (bodySegRows.length === 0) {
    bodyGlyphs = [" "];
    bodySegRows = [[{ text: " ", role: "muted", prominence: FgP.ghost }]];
    bodyRightCoverage = [0];
  }

  return {
    type: "chrome_frame",
    key: "slash-complete",
    width,
    draft: "",
    bodySegRows,
    bodyGlyphs,
    bodyRightCoverage,
    bodyUserSelect: "none",
    picker: {
      rows: keyed,
      selectedKey,
      scrollOffset,
      viewport,
    },
    joinBottom: true,
    plainBottom: true,
    hotkeys: hotkeys && hotkeys.length > 0 ? hotkeys : undefined,
    annotation: annotation && annotation.trim().length > 0 ? annotation.trim() : undefined,
    annotationRole,
    joinAnnotation: joinAnnotation && joinAnnotation.length > 0 ? joinAnnotation : undefined,
    contourRole: model.contourRole,
    modHeld: model.modHeld,
  };
}

/** Same T-join chrome as {@link commandPanel}; text rows, no ›. */
function overlayPanel(
  text: string,
  model: ComposerFrameModel,
  width: number,
  annotation?: string,
  hotkeys?: readonly ChromeHotkey[],
  annotationRole?: string,
  joinAnnotation?: string,
): LayoutNode {
  const scrollOffset = model.scrollOffset ?? 0;
  const textW = chromeFrameTextWidth(width);
  const viewport = model.stackedViewport ?? 0;
  const lang = (model.stackedLang ?? "").trim();
  const highlighted =
    model.stackedNumbered === true || lang === ""
      ? null
      : paintSyntaxOverlayLines({
          text,
          lang,
          scrollOffset,
          viewport,
          textW,
        });
  const paint =
    highlighted ??
    (model.stackedNumbered === true
      ? paintNumberedOverlayLines({
          rows: text.split("\n"),
          scrollOffset,
          viewport,
          textW,
        })
      : paintOverlayLines({
          text,
          scrollOffset,
          viewport,
          textW,
        }));
  const cap = model.stackedViewport && model.stackedViewport > 0 ? model.stackedViewport : paint.lineCount;
  return {
    type: "chrome_frame",
    key: "slash-complete",
    width,
    draft: "",
    bodySegRows: paint.bodySegRows,
    bodyGlyphs: paint.bodyGlyphs,
    bodyRightCoverage: paint.bodyRightCoverage,
    bodyUserSelect: "none",
    picker: {
      rows: Array.from({ length: paint.lineCount }, (_, i) => ({
        key: `ask-line:${i}`,
        name: " ",
      })),
      selectedKey: null,
      scrollOffset,
      viewport: cap,
    },
    joinBottom: true,
    plainBottom: true,
    hotkeys: hotkeys && hotkeys.length > 0 ? hotkeys : undefined,
    annotation: annotation && annotation.trim().length > 0 ? annotation.trim() : undefined,
    annotationRole,
    joinAnnotation: joinAnnotation && joinAnnotation.length > 0 ? joinAnnotation : undefined,
    contourRole: model.contourRole,
    modHeld: model.modHeld,
  };
}
