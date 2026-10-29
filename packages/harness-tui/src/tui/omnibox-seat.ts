/**
 * OMNIBOX VALUE. The worker assembles independent bags. Presence is the
 * claim. This module reduces the value to a seat and a face — Tea does
 * not pick a winner.
 *
 *   auth → overlay → ask → slash → queue → idle
 *
 * Render and input are separate winners. They differ only when ask is
 * visible and not armed (VISIBLE ≠ ARMED): ask
 * owns the hint; slash/queue/idle still own the draft, the stack, and
 * keys except confirm chords, which are reserved and inert.
 *
 * Host Ctrl+C quit is not a layer — it never reaches Tea. Busy /
 * processing / secret are paint modes of the winning layer, not layers.
 *
 * Tea swallows leftover ⏎ after allow/deny without minting an ask bag —
 * leftover Esc on a closed cover is cancel-arm. Paint follows a real
 * head only. Do not re-derive this order at a call site.
 */

import type { SuperKey } from "@inhuman.tools/harness-model";
import type { DraftState } from "@inhuman.tools/quickdraw/input";
import type { ChromeHotkey, ChromeQuotaWindow, ChromeStatusItem } from "@inhuman.tools/quickdraw/layout";
import type { ComposerCommandChoice, ComposerCommandFallback } from "@inhuman.tools/quickdraw/widgets";

import { askCoverShortcuts, HOTKEY_EVENT } from "./ask-shortcuts.js";
import { paintComposerFace, type ComposerErrorFace, type ComposerFace } from "./paint-controller.js";
import { busyDraftShortcuts } from "./queue-shortcuts.js";

export const OMNIBOX_LAYERS = ["auth", "overlay", "ask", "slash", "queue", "idle"] as const;

export type OmniboxLayer = (typeof OMNIBOX_LAYERS)[number];

export type OmniboxAsk = {
  readonly armed: boolean;
  /** The family a human yes can be remembered as, e.g. "`git push` (any other arguments)". Absent: nothing to remember. */
  readonly remember?: string;
  readonly persistDeny: boolean;
  /** Floor soft-deny cover — yellow contour. Floor `ask` is furniture. Soft-deny is licensed every time. */
  readonly caution: boolean;
  /** "Soft-deny" or "Ask": what kind of question this is. */
  readonly tier: "Soft-deny" | "Ask";
  /** Why the floor asked, in the closed class labels. */
  readonly classLabels: readonly string[];
  /** The judge's reason when one weighed in first. */
  readonly judgeLine?: string;
  /** Suggested extra-root folder: "Treat <folder> as part of this session?" Persist-mod Enter says yes. */
  readonly widen?: string;
  /** The call is also flagged `needsAcknowledgement`: the shape of that prompt and the remember option picked. */
  readonly ack?: { readonly variant: "ack" | "ask+ack" | "soft-deny+ack"; readonly choice?: string; readonly cycle?: boolean };
  readonly annotation?: string;
  readonly stackedBody?: string;
  readonly stackedViewport?: number;
  /** Highlight stackedBody (shell ask = `bash`). */
  readonly stackedLang?: string;
};

export type OmniboxPicker = {
  readonly commandChoices?: readonly ComposerCommandChoice[];
  readonly commandAction?: ComposerCommandFallback;
  readonly selectedCommandKey: string | null;
};

export type OmniboxSlash = OmniboxPicker;

export type OmniboxOverlay = OmniboxPicker & {
  /** Confirm / notice occupy the draft. Input overlays leave this unset. */
  readonly body?: string;
  readonly placeholder?: string;
  readonly secret: boolean;
  readonly inputting: boolean;
  readonly processing: boolean;
};

/** OIDC wait. Overlay bag still holds the parked form. */
export type OmniboxAuth = {
  readonly waiting: true;
};

export type OmniboxQueue = {
  readonly stackedBody: string;
  readonly queued: number;
  /**
   * A live (unclosed) head turn exists — `turn/cancel` can actually fire.
   * Open work on a *closed* head still paints the queue face, but cancel is a
   * no-op there, so the armed Esc must not advertise it.
   */
  readonly running: boolean;
};

export type OmniboxValue = {
  readonly draft: DraftState;
  readonly cover: DraftState;
  readonly ask: OmniboxAsk | null;
  readonly slash: OmniboxSlash | null;
  readonly overlay: OmniboxOverlay | null;
  readonly auth: OmniboxAuth | null;
  readonly queue: OmniboxQueue | null;
  readonly busy: boolean;
  readonly escClearArmed: boolean;
  /** Closed idle head that did not true-finish. Cancel must be acked. */
  readonly lastTurnIncomplete: boolean;
  /** Live head is the episode ceiling and the operator is not browsing. */
  readonly atTip?: boolean;
  readonly restoredDraft?: boolean;
  readonly retainedHistory?: boolean;
  /** Claimed title, not a derived path. */
  readonly sessionTitle: string;
  /** Live head completion is sleeping until `retryUntilMs`. Persist-mod ⏎ retries. */
  readonly retrying: boolean;
  readonly superKey?: SuperKey;
  readonly errorAnnotation: ComposerErrorFace | null;
  readonly statusItems?: readonly ChromeStatusItem[];
  /** Persist-mod overlay; paint swaps on modHeld. Remaining duration is live. */
  readonly quotaWindows?: readonly ChromeQuotaWindow[];
  /** Remaining-until-soft-compact 0..1. Omit until a window exists. */
  readonly progress?: number;
  /** Remaining fraction where warning chroma starts. */
  readonly progressGlowAt?: number;
  /** Window gauge for the persist-mod overlay (`10k/500k`). */
  readonly contextUsed?: number;
  readonly contextLimit?: number;
  readonly scrollOffset: number;
};

export type OmniboxAskChords = "live" | "inert" | "off";

export type OmniboxSeat = {
  readonly render: OmniboxLayer;
  readonly input: OmniboxLayer;
  readonly stack: OmniboxLayer | "none";
  readonly askChords: OmniboxAskChords;
};

const OFF: OmniboxSeat = {
  render: "idle",
  input: "idle",
  stack: "none",
  askChords: "off",
};

const EMPTY_DRAFT: DraftState = { draft: "", cursor: 0, mark: null };

export const EMPTY_OMNIBOX: OmniboxValue = {
  draft: EMPTY_DRAFT,
  cover: EMPTY_DRAFT,
  ask: null,
  slash: null,
  overlay: null,
  auth: null,
  queue: null,
  busy: false,
  escClearArmed: false,
  lastTurnIncomplete: false,
  sessionTitle: "",
  retrying: false,
  errorAnnotation: null,
  scrollOffset: 0,
};

export function omniboxSeat(value: OmniboxValue): OmniboxSeat {
  if (value.auth !== null) {
    return { render: "auth", input: "auth", stack: "auth", askChords: "off" };
  }
  if (value.overlay !== null) {
    return { render: "overlay", input: "overlay", stack: "overlay", askChords: "off" };
  }
  if (value.ask !== null && value.ask.armed) {
    return { render: "ask", input: "ask", stack: "ask", askChords: "live" };
  }
  if (value.ask !== null) {
    const input: OmniboxLayer = value.slash === null ? (value.queue === null ? "idle" : "queue") : "slash";
    const stack: OmniboxSeat["stack"] = value.slash === null ? (value.queue === null ? "none" : "queue") : "slash";
    return { render: "ask", input, stack, askChords: "inert" };
  }
  if (value.slash !== null) {
    return { render: "slash", input: "slash", stack: "slash", askChords: "off" };
  }
  if (value.queue !== null) {
    return { render: "queue", input: "queue", stack: "queue", askChords: "off" };
  }
  return OFF;
}

export function omniboxStackPanel(value: OmniboxValue): {
  readonly body: string;
  readonly viewport?: number;
  readonly numbered: boolean;
  readonly lang?: string;
} {
  const seat = omniboxSeat(value);
  if (seat.stack === "ask") {
    const body = value.ask?.stackedBody ?? "";
    return {
      body,
      viewport: value.ask?.stackedViewport,
      numbered: false,
      lang: value.ask?.stackedLang,
    };
  }
  if (seat.stack === "queue") {
    return { body: value.queue?.stackedBody ?? "", numbered: true };
  }
  return { body: "", numbered: false };
}

/** Context remaining-fill is idle chrome. Ask/overlay/auth own the box fill. */
function contextRailVisible(seat: OmniboxSeat): boolean {
  return seat.render === "idle" || seat.render === "slash" || seat.render === "queue";
}

export function paintOmnibox(value: OmniboxValue): ComposerFace {
  const seat = omniboxSeat(value);
  const isolated = seat.input === "ask";
  const overlay = value.overlay;
  const picker = isolated
    ? undefined
    : seat.stack === "slash"
      ? value.slash
      : seat.stack === "overlay" || seat.stack === "auth"
        ? overlay
        : undefined;
  const panel = omniboxStackPanel(value);
  const ask = value.ask;
  const parked = value.draft.draft.trim();
  const askShortcuts =
    seat.render === "ask" && ask !== null
      ? askCoverShortcuts({
          comment: value.cover.draft.trim() !== "",
          remember: ask.remember,
          persistDeny: ask.persistDeny,
          widen: ask.widen,
          ack: ask.ack,
          superKey: value.superKey,
        })
      : undefined;
  const queueShortcuts =
    seat.render === "queue" && value.queue !== null
      ? busyDraftShortcuts({
          draft: value.draft.draft,
          queued: value.queue.queued,
          superKey: value.superKey,
          retrying: value.retrying,
        })
      : undefined;
  const armedEsc: ChromeHotkey[] | undefined =
    value.escClearArmed && seat.render !== "overlay" && seat.render !== "auth"
      ? [
          value.queue != null && value.queue.running && value.draft.draft.length === 0
            ? { key: "Esc", action: "cancel current turn", event: HOTKEY_EVENT.cancelTurn }
            : value.draft.draft.length > 0
              ? { key: "Esc", action: "clear", event: HOTKEY_EVENT.clear }
              : { key: "Esc", action: "Rewind history" },
        ]
      : undefined;
  const idleContinue: ChromeHotkey[] | undefined =
    seat.render === "idle" &&
    value.draft.draft.trim() === "" &&
    value.lastTurnIncomplete &&
    !value.escClearArmed &&
    value.atTip !== false
      ? [{ key: "Enter", action: "Resume the interrupted turn", event: HOTKEY_EVENT.continue }]
      : undefined;
  const retainedHistory: ChromeHotkey[] | undefined =
    seat.render === "idle" && value.retainedHistory && (value.draft.draft === "" || value.restoredDraft)
      ? [{ key: "Esc", action: "browse retained history (twice)" }]
      : undefined;
  const placeholder =
    seat.render === "ask" || isolated ? undefined : overlay?.body === undefined ? overlay?.placeholder : undefined;
  return paintComposerFace({
    oauthWaiting: value.auth !== null,
    busy: value.busy,
    inputting: overlay?.inputting === true,
    processing: overlay?.processing === true,
    secret: overlay?.secret === true,
    isolated,
    coverDraft: value.cover,
    draft: value.draft,
    overlayBody: overlay?.body,
    placeholder,
    annotation: isolated
      ? (ask?.annotation ?? (parked === "" ? undefined : parked))
      : contextRailVisible(seat)
        ? value.sessionTitle === ""
          ? undefined
          : value.sessionTitle
        : undefined,
    joinAnnotation:
      seat.render === "ask" && isolated && (ask?.stackedBody ?? "").trim() !== "" && value.sessionTitle !== ""
        ? value.sessionTitle
        : undefined,
    hotkeys: askShortcuts ?? armedEsc ?? queueShortcuts ?? idleContinue ?? retainedHistory,
    errorAnnotation: value.errorAnnotation,
    statusItems: value.statusItems,
    quotaWindows: value.quotaWindows,
    contextUsed: value.contextUsed,
    contextLimit: value.contextLimit,
    contourRole: seat.render === "ask" && ask?.caution === true ? "emphasis" : undefined,
    progress: contextRailVisible(seat) ? value.progress : undefined,
    progressGlowAt: contextRailVisible(seat) ? value.progressGlowAt : undefined,
    commandChoices: picker?.commandChoices,
    commandAction: picker?.commandAction,
    selectedCommandKey: picker?.selectedCommandKey ?? null,
    scrollOffset: value.scrollOffset,
    stackedBody: panel.body === "" ? undefined : panel.body,
    stackedViewport: panel.viewport,
    stackedNumbered: panel.numbered === true ? true : undefined,
    stackedLang: panel.lang,
  });
}
