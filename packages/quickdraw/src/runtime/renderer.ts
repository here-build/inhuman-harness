/**
 * Box-cadence UI host — on-demand present + mailbox + echo + selection + caret.
 *
 * Cadence law: **idle means zero timers, zero paints.** Every paint is caused —
 * a wake source calls {@link Renderer.requestPaint} (coalesced, next
 * macrotask) or paints synchronously (mouse press/release, first drag cell).
 * Drag-select after that is latest-wins and presents at {@link SELECTION_PAINT_HZ}
 * — interim SGR cells update the gesture, they do not each tick. A repeating
 * timer is armed only while the painted frame demands it (`Frame.liveDemand.maxHz`
 * from spinners/elapsed, a thought-birth frontier still animating, or a bgFx
 * field) and is disarmed the first frame demand disappears. Spinner Hz stays on
 * `liveDemand.maxHz`. Birth / progress / bgFx arm at `flourishHz` (30 local),
 * not `targetFps` (the emit cap). Input echoes on the very next
 * macrotask — sub-frame, not next-interval.
 *
 * AESTHETIC REUSE: when this tick's `prepared` is the same object as last
 * (computed snapshot identity) and extras match, tick reuses the last Frame.
 * Idle (no birth / progress / spinner) clones the last pre-materialize buffer.
 * A spinner/elapsed/birth tick only `paintFrame`s that Frame with a new `nowMs`
 * — it must not `layout()` the tape to advance a glyph. Progress still relayouts
 * (it patches the tree). `contentIdentity` only clears text selection.
 *
 * Admission law: only work with a visual-performance reason runs here —
 * paint/diff, damage, input decode, speculative echo, click hit-test, selection
 * overlay, copy-toast chrome. Everything else is postMessage to the worker.
 * Copy-toast is a present-path overlay (not a LayoutNode): one-shot 3s/10s
 * timers while it is up, then idle again.
 *
 * Mutable state lives on private fields; frame.ts is pure over
 * (mailbox, geometry, state record) — F11.
 *
 * Ready signal = worker's first `structure` / `paint_init`, or the first
 * retained snapshot that returns a non-null root (no mailbox required).
 *
 * SNAPSHOT: tick reads `paintSource.snapshot` (the live computed) when
 * present. `prepare()` is only the pull fallback. Aesthetic ticks must
 * not rebuild the tree.
 *
 * Product keys (composer box / frame) and worker lane envelopes are injected —
 * this module does not import agent packages.
 */
import { execFileSync } from "node:child_process";

import { reaction, runInAction, type IReactionDisposer } from "mobx";

import { agentsRowKeyFromHit } from "./agents_keys.js";
import { APP_AGENTS_PEEK_KEY } from "./agents_peek.js";
import { APP_AGENTS_PREVIEW_KEY, APP_AGENTS_PREVIEW_OVERLAY_KEY } from "./agents_preview.js";
import {
  applyBoxBusBatch,
  emptyMailbox,
  type BoxBusDownMessage,
  type BoxBusUpMessage,
  type BoxMailbox,
  type DecodedKeyEvent,
} from "./box_bus.js";
import { COPY_TOAST_ARM_MS, COPY_TOAST_HOLD_MS, paintCopyToast, placeCopyToast } from "./copy_toast.js";
import { emptyEcho, predict, reconcile, withComposerBox, type EchoState } from "./echo.js";
import { renderFrame, type Geometry } from "./frame.js";
import { deliver, emptyQueue, markReady, offer, type KeyBuffer } from "./key_buffer.js";
import { composerCaretEvent, isRangeEditKey, toKeyEventBatch } from "./keys.js";
import { paintSnapshotFromMailbox } from "./paint_snapshot.js";
import {
  agentsPreviewViewportMetrics,
  agentsViewportMetrics,
  emptyPreparedPaint,
  nextTapeScroll,
  tapeViewportMetrics,
  writePaintEcho,
  writePaintModHeld,
  writePaintPreviewScroll,
  writePaintTapeExpanded,
  writePaintTapeScroll,
  type PaintLocal,
  type PreparedPaint,
  type RetainedPaintSource,
} from "./paint_source.js";
import { startPresentLoop } from "./present_loop.js";
import { DEFAULT_FLOURISH_HZ } from "./present_profile.js";
import { createSelectionHost, mouseToGesture, type SelectionHost } from "./selection_host.js";
import { anyThoughtBirthLive, stepThoughtBirthFromSites, stepThoughtBirthFromSnapshot } from "./thought_birth.js";
import { paintSnapshotWithThoughtCollapsed, toggleCollapsedFromHit } from "./thought_collapsed.js";
import { mouseAnyMotionBytes, mousePointerBytes, type MousePointerShape } from "./tty.js";
import { cloneBuffer, createBuffer, emitAnsiDetailed, type Buffer } from "../buffer/index.js";
import { OSC11_QUERY, THEME_REPORT_DISABLE, THEME_REPORT_ENABLE } from "../capabilities/sequences.js";
import {
  consumeKeys,
  flushPendingEsc,
  normalizePaste,
  selectionRange,
  type DraftState,
  type InputEvent,
} from "../input/index.js";
import { bufferHasBgFx, materializeBgFx } from "../internals/bgfx/materialize.js";
import { setBgFxGround } from "../internals/bgfx/opacity.js";
import {
  attuneTheme,
  setActiveTheme,
  setColorDepth,
  CHROME_FRAME_BODY_CHROME,
  collectProgressSites,
  elementAt,
  elementAtPath,
  paintFrame,
  progressBarLive,
  stepProgressBar,
  ThemeStore,
  type BirthFrontierState,
  type Frame,
  type LayoutNode,
  type ProgressBarAnim,
  type ThemeAttuneOpts,
  type ThemeBinding,
} from "../layout/index.js";
import { canvasPolarity } from "../theme/ansi16.js";
import type { Theme as SalienceTheme } from "../theme/index.js";
import {
  caretAnsi,
  composerDraftSelectionFromCells,
  composerOffsetAtCell,
  parkComposerCaret,
} from "../widgets/index.js";
import { setHighlightPolarity } from "../widgets/internals/syntax.js";

/** Lone-ESC hold before it counts as Escape (cannot tell Escape from a split CSI). */
export const ESC_QUIET_MS = 30;

function readSystemClipboard(): string {
  try {
    if (process.platform === "darwin") {
      return execFileSync("pbpaste", { encoding: "utf8", timeout: 250, maxBuffer: 1_048_576 });
    }
    if (process.platform === "win32") {
      return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
        encoding: "utf8",
        timeout: 500,
        maxBuffer: 1_048_576,
      });
    }
    try {
      return execFileSync("wl-paste", ["-n"], { encoding: "utf8", timeout: 250, maxBuffer: 1_048_576 });
    } catch {
      return execFileSync("xclip", ["-selection", "clipboard", "-o"], {
        encoding: "utf8",
        timeout: 250,
        maxBuffer: 1_048_576,
      });
    }
  } catch {
    return "";
  }
}

/** Ceiling for live-demand presents (spinners, birth). Not an idle loop rate. */
export const TARGET_FPS = 60;

/**
 * Drag-select present rate. Gesture state tracks every SGR cell; paint does not.
 * Press/release still tick immediately (clear, copy, click). Knob if 30 is wrong.
 */
export const SELECTION_PAINT_HZ = 30;

export interface TtyInput {
  onData(handler: (chunk: string) => void): void;
  setRawMode(enabled: boolean): void;
}

export interface TtyOutput {
  write(text: string): void;
  readonly cols: number;
  readonly rows: number;
  onResize(handler: () => void): void;
}

export interface PresentLoop {
  stop(): void;
}

/**
 * Paint mailbox port — product hosts adapt their lane envelope to this.
 * Host-lane (failed/boot/quit) stays outside; only paint batch + up messages.
 */
/** Mailbox messages, plus paint_init as the ready signal (payload already applied). */
export type CadenceDownItem = BoxBusDownMessage | { readonly kind: "paint_init" };

export interface BoxCadencePort {
  post(message: BoxBusUpMessage): void;
  /** Deliver paint batches (structure / box_set / box_free) and paint_init ready. */
  onBatch(handler: (batch: readonly CadenceDownItem[]) => void): void;
}

export interface BoxCadenceHostOptions {
  readonly port: BoxCadencePort;
  readonly input: TtyInput;
  readonly output: TtyOutput;
  /** Ceiling for live-demand presents. Idle never ticks regardless. */
  readonly targetFps?: number;
  /**
   * Aesthetic live-lane Hz (bgFx / birth / progress). Spinner `liveDemand.maxHz`
   * is unchanged. Default {@link DEFAULT_FLOURISH_HZ}. `QD_FPS` stays the cap.
   */
  readonly flourishHz?: number;
  /**
   * Per-frame DEC 2026 bracket on emit. `fx` does this; a session-level
   * `?2026h` without `?2026l` lets the terminal time out mid-paint and drop rows.
   */
  readonly sync2026?: boolean;
  readonly onPresent?: (info: { dirtyRows: number; bytes: number; reusedFrame: boolean }) => void;
  /** Structure key for the composer content box (worker mints this id). */
  readonly composerBoxKey?: string;
  /** Layout key for the chrome_frame draft surface (caret park / click). */
  readonly composerFrameKey?: string;
  /**
   * Clipboard body for Ctrl-V. Tests inject; production defaults to the OS
   * clipboard, then last copy-on-select.
   */
  readonly readClipboard?: () => string;
  /**
   * Second Ctrl-C (first arms #quitArmed; other keys disarm). Lifecycle on UI
   * thread — never a worker keymap chord.
   */
  readonly onQuit?: () => void;
  /** Armed Ctrl-C hint. Default `"exit"`. Daemon sessions keep interpreting. */
  readonly quitAction?: () => string;
  /** First structure or paint_init — ready signal. Fired once. */
  readonly onReady?: () => void;
  readonly onFirstPaint?: () => void;
  /**
   * Retained paint source. tick calls prepare() first. A non-null root is
   * the frame; a null root keeps the mailbox path.
   */
  readonly paintSource?: RetainedPaintSource;
  /** One bag per TUI process. Cadence writes cols/rows; harness writes echo. */
  readonly paintLocal?: PaintLocal;
  /**
   * Bound once by the caller (OSC 11 probe before alt screen). Explicit rather
   * than ambient paintTheme() — default is "nothing measured", not silent ambient.
   */
  readonly theme?: ThemeBinding;
}

type BoxCadenceHostInit = BoxCadenceHostOptions & {
  readonly now?: () => number;
  readonly schedule?: (fn: () => void) => void;
  readonly startLoop?: (opts: { targetFps: number; onFrame: (dtMs: number) => void }) => PresentLoop;
};

export class Renderer {
  readonly #options: BoxCadenceHostInit;
  readonly #now: () => number;
  readonly #composerBoxKey: string;
  readonly #composerFrameKey: string;

  #mailbox: BoxMailbox = emptyMailbox();
  #echo: EchoState = emptyEcho();
  #queue: KeyBuffer<DecodedKeyEvent> = emptyQueue();
  #geometry: Geometry;

  #pendingBytes = "";
  #lastByteAt = 0;

  #previous: Buffer | null = null;
  #frame: Frame | null = null;
  #liveLoop: PresentLoop | null = null;
  #liveHz = 0;
  #paintScheduled = false;
  #escTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last drag-caused present. Trailing timer paints the latest cell after the gap. */
  #selectionPaintAt = Number.NEGATIVE_INFINITY;
  #selectionPaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** Range-end plaque after OSC 52. */
  #copyToast: { end: { col: number; row: number }; anchor: { col: number; row: number } } | null = null;
  #copyToastArmed = false;
  #copyToastArmTimer: ReturnType<typeof setTimeout> | null = null;
  #copyToastHoldTimer: ReturnType<typeof setTimeout> | null = null;
  /** Terminal focus (CSI I/O) — caret hides on OS blur. */
  #termFocused = true;
  /** First Ctrl+C arms exit hint; second quits; any other key disarms. */
  #quitArmed = false;

  readonly #selection: SelectionHost = createSelectionHost();

  /** Display-only collapse overrides; worker still ships collapsed:true. */
  readonly #thoughtCollapsed = new Map<string, boolean>();
  /** Birth frontiers — stepped each present tick (FPS, not token rate). */
  readonly #thoughtBirth = new Map<string, BirthFrontierState>();
  /** Drag since last press → suppress activate. */
  #mouseDragged = false;
  /** Last mouse cell (0-based) — progress-annotation hover without 1003 flood. */
  #pointer: { col: number; row: number } | null = null;
  /** Sticky until button-up so picker/drawer press cannot arm transcript selection. */
  #gestureOwner: "picker" | "agents" | "selection" | null = null;
  #hoverKey: string | null = null;
  #pressKey: string | null = null;
  /** Host-local drawer hover; mirrored to worker focus for action semantics. */
  #agentsHoverKey: string | null = null;
  #hoverSuppressKey: string | null = null;
  /** Last slash-complete payload for hit-map / wheel clamp (Tea owns the window). */
  #pickerLast: {
    paintRowToKey: readonly (string | null)[];
    n: number;
    viewport: number;
    scrollOffset: number;
  } | null = null;
  /** 1003 any-motion: slash-complete, or copy-toast after its 3s arm. */
  #anyMotion = false;
  /** OSC 22 shape. Edge-written; `pointer` only over `intent: activate`. */
  #pointerShape: MousePointerShape = "default";
  /** Host-eased chrome_frame progress, keyed by frame key. */
  readonly #progress = new Map<string, ProgressBarAnim>();

  readonly #themes: ThemeStore;
  #themeStop: IReactionDisposer | null = null;

  #pendingResize: { cols: number; rows: number } | null = null;
  #stopped = false;
  #paintedOnce = false;
  /** First bgFx frame kicks catalog/worker; never on the cold path. */
  #bgfxArmed = false;
  /**
   * `materializeBgFx` clock origin. Shadertoy `iTime` is float32 seconds
   * since start — `Date.now()/1000` (~1.7e9) has a 128s ULP, so a frame
   * delta is zero and the field freezes. Epoch is the first fx present.
   */
  #fxEpoch: number | null = null;
  readonly #paintSource: RetainedPaintSource | null = null;
  readonly #paintLocal: PaintLocal | null = null;
  #sourceBinding: Disposable | null = null;
  /** Last PreparedPaint that produced the visible frame. Input reads this. */
  #committed: PreparedPaint | null = null;
  /** Retained content scope — selection dies when the source says it changed. */
  #contentIdentity: string | undefined = undefined;
  /** Pre-materialize buffer for aesthetic reuse. */
  #structural: Buffer | null = null;
  #structuralKey = "";
  #lastPrepared: PreparedPaint | null = null;

  constructor(options: BoxCadenceHostInit) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#geometry = { cols: options.output.cols, rows: options.output.rows };
    const seed = options.theme ?? attuneTheme();
    this.#themes = new ThemeStore({ theme: seed.theme, depth: seed.depth });
    this.#composerBoxKey = options.composerBoxKey ?? "composer";
    this.#composerFrameKey = options.composerFrameKey ?? "composer:frame";
    this.#paintSource = options.paintSource ?? null;
    this.#paintLocal = options.paintLocal ?? null;
    this.#selection.setViewport(this.#geometry.cols, this.#geometry.rows);
  }

  get mailbox(): BoxMailbox {
    return this.#mailbox;
  }

  start(): void {
    this.#options.input.setRawMode(true);
    this.#options.input.onData((chunk) => this.onBytes(chunk));
    this.#options.output.onResize(() => this.onResize(this.#options.output.cols, this.#options.output.rows));
    this.#options.port.onBatch((batch) => this.onPaintBatch(batch));
    if (this.#paintSource !== null && this.#paintLocal !== null) {
      this.#sourceBinding = this.#paintSource.bind({ requestPaint: () => this.requestPaint() }, this.#paintLocal);
    }
    this.#applyThemeSink(this.#themes.theme, { relayout: false });
    this.#themeStop = reaction(
      () => this.#themes.binding,
      ({ theme }) => {
        if (this.#stopped) return;
        this.#applyThemeSink(theme, { relayout: true });
        this.requestPaint();
      },
    );
    // Subscribe before re-querying to close the boot-probe / live-host gap.
    // Unsupported terminals ignore the mode; focus-in also refreshes ground.
    this.#options.output.write(THEME_REPORT_ENABLE + OSC11_QUERY);
    // Worker has no TTY. Announce geometry before the first structure.
    this.#send({ kind: "resize", cols: this.#geometry.cols, rows: this.#geometry.rows });
    this.requestPaint(); // first frame (forceFull: #previous === null)
  }

  /**
   * Push a new canvas ground/depth. Theme is computed; the reaction drops
   * cached RGB and (on polarity flip) the Frame so diffs re-highlight.
   */
  attune(opts: ThemeAttuneOpts): void {
    this.#themes.attune(opts);
  }

  /**
   * Coalesced on-demand paint: any number of wakes inside one macrotask batch
   * into a single tick on the next one. The wake sources are enumerated in
   * the class preamble — nothing else may paint.
   */
  requestPaint(): void {
    if (this.#stopped || this.#paintScheduled) return;
    this.#paintScheduled = true;
    const schedule = this.#options.schedule ?? ((fn: () => void) => void setImmediate(fn));
    schedule(() => {
      this.#paintScheduled = false;
      if (!this.#stopped) this.tick();
    });
  }

  /** Arm/disarm the live timer to match current frame demand. */
  #setLiveHz(hz: number): void {
    if (hz <= 0) {
      this.#liveLoop?.stop();
      this.#liveLoop = null;
      this.#liveHz = 0;
      return;
    }
    if (this.#liveLoop !== null && this.#liveHz === hz) return;
    this.#liveLoop?.stop();
    this.#liveHz = hz;
    this.#liveLoop = (this.#options.startLoop ?? startPresentLoop)({
      targetFps: hz,
      onFrame: () => this.tick(),
    });
  }

  #armBgfx(): void {
    if (this.#bgfxArmed) return;
    this.#bgfxArmed = true;
    const width = this.#geometry.cols;
    const height = this.#geometry.rows;
    void import("../internals/bgfx/shadertoy-catalog.js")
      .then((mod) => mod.registerShadertoyCatalog({ width, height }))
      .then((r) => {
        console.error(`[bgfx] catalog mode=${r.mode} ${r.ids.join(",") || "—"} ${width}×${height}`);
        if (!this.#stopped) this.requestPaint();
        return r;
      })
      .catch(() => {
        // Catalog load is optional. Do not skip CPU materializeBgFx on present.
      });
  }

  /** Stop paint/read. Does NOT restore the terminal — teardown owns that order. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#options.output.write(THEME_REPORT_DISABLE);
    this.#liveLoop?.stop();
    this.#liveLoop = null;
    this.#liveHz = 0;
    if (this.#escTimer !== null) {
      clearTimeout(this.#escTimer);
      this.#escTimer = null;
    }
    this.#cancelSelectionPaintTimer();
    this.#cancelCopyToastTimers();
    this.#copyToast = null;
    this.#copyToastArmed = false;
    this.#options.input.setRawMode(false);
    if (this.#anyMotion) {
      this.#anyMotion = false;
      this.#options.output.write(mouseAnyMotionBytes(false));
    }
    if (this.#pointerShape !== "default") {
      this.#pointerShape = "default";
      this.#options.output.write(mousePointerBytes("default"));
    }
    if (this.#bgfxArmed) {
      void import("../internals/bgfx/shadertoy-catalog.js").then((mod) => mod.unregisterShadertoyCatalog());
    }
    this.#themeStop?.();
    this.#themeStop = null;
    this.#sourceBinding?.[Symbol.dispose]();
    this.#sourceBinding = null;
  }

  /** Imperative theme side-effects: polarity, bgfx ground, ambient, RGB cache. */
  #applyThemeSink(theme: SalienceTheme, opts: { relayout: boolean }): void {
    setHighlightPolarity(canvasPolarity(theme.ground));
    setActiveTheme(theme);
    setColorDepth(this.#themes.depth);
    setBgFxGround(theme.groundRgb);
    if (!opts.relayout) return;
    this.#structural = null;
    // Chrome progress fuse + syntax tokens bake at layout. Dual-dirty recasts
    // role RGB, but the omnibox ramp and shiki runs need a new Frame.
    this.#frame = null;
    this.#lastPrepared = null;
  }

  /**
   * Decode → translate → queue → deliver, even during boot.
   * Bytes become events when carry state is correct; only delivery waits (F1).
   */
  onBytes(chunk: string): void {
    const decoded = consumeKeys(chunk, this.#pendingBytes);
    this.#pendingBytes = decoded.pending;
    this.#lastByteAt = this.#now();
    this.#acceptDecoded(decoded.events);
    // Lone ESC resolves after the quiet window — a one-shot timer, not a poll.
    if (this.#escTimer !== null) {
      clearTimeout(this.#escTimer);
      this.#escTimer = null;
    }
    if (this.#pendingBytes === "\u001B" && !this.#stopped) {
      this.#escTimer = setTimeout(() => {
        this.#escTimer = null;
        this.#maybeFlushEsc();
      }, ESC_QUIET_MS + 1);
    }
  }

  /**
   * Lifecycle / local-geometry before translation:
   *   ctrl_c → double-press quit (never worker)
   *   mouse  → selection / wheel (never Seam C key)
   *   esc + live selection → collapse/clear and stop (do not deliver Esc)
   */
  #acceptDecoded(events: readonly InputEvent[]): void {
    let quitNow = false;
    let chromeDirty = false;
    const rest: InputEvent[] = [];
    for (const event of events) {
      if (event.type === "theme_changed") {
        this.#options.output.write(OSC11_QUERY);
        continue;
      }
      if (event.type === "osc_ground") {
        this.attune({ groundRgb: event.rgb });
        continue;
      }
      if (event.type === "mod") {
        this.#setModHeld(event.down);
        continue;
      }
      if (event.type === "ctrl_c") {
        this.#copyToastNotice("input");
        if (this.#quitArmed) {
          quitNow = true;
        } else {
          this.#quitArmed = true;
          chromeDirty = true;
        }
        continue;
      }
      if (this.#quitArmed) {
        this.#quitArmed = false;
        chromeDirty = true;
      }
      if (event.type === "focus_in") {
        this.#options.output.write(OSC11_QUERY);
        this.#termFocused = true;
        chromeDirty = true;
        continue;
      }
      if (event.type === "focus_out") {
        this.#termFocused = false;
        this.#setModHeld(false);
        this.#clearAgentsHover();
        chromeDirty = true;
        continue;
      }
      if (event.type === "mouse") {
        this.#onMouse(event);
        continue;
      }
      if (event.type === "page_up" || event.type === "page_down") this.#copyToastNotice("scroll");
      else this.#copyToastNotice("input");
      if (event.type === "esc") {
        const overlay = this.#selection.selection();
        const draftSel = standingDraftSelection(this.#composerDraftState());
        if (overlay || draftSel) {
          this.#selection.clear();
          if (draftSel) this.#accept([composerCaretEvent(draftSel.cursor, null)]);
          else this.requestPaint();
          continue;
        }
      }
      if (event.type === "page_up" || event.type === "page_down") {
        if (this.#agentsPreviewOpen()) {
          const vp = this.#previewViewport();
          if (vp !== null) {
            const page = Math.max(1, vp.h - 1);
            this.#scrollPreview(event.type === "page_up" ? -page : page);
          }
          continue;
        }
        const vp = this.#tapeViewport();
        if (vp !== null && this.#paintLocal !== null) {
          const page = Math.max(1, vp.h - 1);
          this.#scrollTape(event.type === "page_up" ? -page : page);
          continue;
        }
      }
      if (event.type === "ctrl_o") {
        if (this.#agentsPreviewOpen()) continue;
        this.#toggleTapeExpanded();
        continue;
      }
      if (event.type === "ctrl_v") {
        const raw = (this.#options.readClipboard ?? readSystemClipboard)() || this.#selection.lastCopy();
        const text = normalizePaste(raw);
        if (text.length > 0) rest.push({ type: "paste", text });
        continue;
      }
      rest.push(event);
    }
    const keys = toKeyEventBatch(rest);
    this.#noteKeyMods(keys);
    if (this.#agentsViewport() !== null) {
      for (const key of keys) {
        if (key.key === "j" || key.key === "k" || key.key === "ArrowDown" || key.key === "ArrowUp") {
          this.#armHoverSuppress();
          break;
        }
      }
    }
    this.#accept(keys);
    if (chromeDirty) this.requestPaint();
    if (quitNow) this.#options.onQuit?.();
  }

  #setModHeld(next: boolean): void {
    if (this.#paintLocal === null || this.#paintLocal.modHeld === next) return;
    writePaintModHeld(this.#paintLocal, next);
    this.requestPaint();
  }

  #noteKeyMods(events: readonly { readonly ctrl?: boolean; readonly meta?: boolean }[]): void {
    if (!events.some((event) => event.ctrl === true || event.meta === true)) return;
    this.#setModHeld(true);
  }

  /**
   * SGR mouse → picker chrome, selection gesture, or bare-click hit.
   * Wheel over picker is eaten (Tea owns scrollOffset); over the transcript
   * viewport scrolls the tape (present-side follow-tail). Elsewhere discarded.
   * Sneak-peek: wheel scrolls the peeked tape; bare click inside the modal
   * toggles disclosures; click outside dismisses; drawer hover/activate stay
   * inert.
   */
  #onMouse(ev: Extract<InputEvent, { type: "mouse" }>): void {
    this.#pointer = { col: ev.col - 1, row: ev.row - 1 };
    this.#selection.setViewport(this.#geometry.cols, this.#geometry.rows);
    this.#syncPointerShape();
    const mapped = mouseToGesture(ev, this.#now());
    if (mapped.kind === "ignore") return;
    if (this.#agentsPreviewOpen()) {
      if (mapped.kind === "wheel") {
        this.#copyToastNotice("scroll");
        if (this.#pointerInPreview()) this.#scrollPreview(mapped.delta);
        return;
      }
      if (mapped.kind === "move") return;
      if (mapped.event.kind === "press") {
        this.#copyToastNotice("press");
        this.#mouseDragged = false;
        return;
      }
      if (mapped.event.kind === "drag") {
        this.#mouseDragged = true;
        return;
      }
      if (mapped.event.kind === "release" && !this.#mouseDragged) {
        this.onClick(ev.col, ev.row);
      }
      return;
    }

    if (mapped.kind === "move") {
      this.#copyToastNotice("move");
      if (this.#pointerInPickerChrome()) {
        const next = this.#pickerKeyAt();
        if (next !== this.#hoverKey) {
          this.#hoverKey = next;
          this.requestPaint();
        }
        return;
      }
      if (this.#hoverKey !== null) {
        this.#hoverKey = null;
        this.requestPaint();
      }
      if (this.#agentsViewport() !== null && !this.#agentsPreviewOpen()) this.#applyAgentsPointer();
      return;
    }

    if (mapped.kind === "wheel") {
      this.#copyToastNotice("scroll");
      if (this.#pointerInPickerChrome()) {
        const last = this.#pickerLast;
        if (!last || last.n <= last.viewport) return;
        const sign: 1 | -1 = mapped.delta < 0 ? -1 : 1;
        const maxS = Math.max(0, last.n - last.viewport);
        const next = Math.max(0, Math.min(maxS, last.scrollOffset + sign));
        if (next === last.scrollOffset) return;
        this.#send({ kind: "picker_scroll", delta: sign });
        return;
      }
      if (this.#agentsViewport() !== null) {
        if (this.#agentsPreviewOpen()) return;
        const sign: 1 | -1 = mapped.delta < 0 ? -1 : 1;
        this.#send({ kind: "agents_scroll", delta: sign });
        return;
      }
      if (this.#pointerInTape()) this.#scrollTape(mapped.delta);
      return;
    }

    if (mapped.event.kind === "press") {
      this.#copyToastNotice("press");
      if (this.#pointerInPickerChrome()) {
        this.#gestureOwner = "picker";
        this.#mouseDragged = false;
        this.#pressKey = this.#pickerKeyAt();
        this.#hoverKey = this.#pressKey;
        this.tick();
        return;
      }
      if (this.#pointerInAgentsPanel()) {
        this.#gestureOwner = "agents";
        this.#mouseDragged = false;
        this.#applyAgentsPointer();
        this.#pressKey = this.#agentsHoverableKeyAt();
        this.tick();
        return;
      }
      this.#gestureOwner = "selection";
    }

    if (this.#gestureOwner === "agents") {
      if (mapped.event.kind === "drag") {
        this.#applyAgentsPointer();
        return;
      }
      if (mapped.event.kind === "release") {
        const at = this.#agentsHoverableKeyAt();
        const press = this.#pressKey;
        if (press != null && at === press) {
          this.#send({ kind: "activate", key: press });
        }
        this.#pressKey = null;
        this.#gestureOwner = null;
        this.requestPaint();
        return;
      }
    }

    if (this.#gestureOwner === "picker") {
      if (mapped.event.kind === "drag") {
        this.#hoverKey = this.#pickerKeyAt();
        this.requestPaint();
        return;
      }
      if (mapped.event.kind === "release") {
        const at = this.#pickerKeyAt();
        const press = this.#pressKey;
        if (press != null && at === press) {
          this.#send({ kind: "picker_activate", key: press });
        }
        this.#pressKey = null;
        this.#gestureOwner = null;
        this.requestPaint();
        return;
      }
    }

    // Press: drop prior selection + draft mark (browser model). Shift extends.
    if (mapped.event.kind === "press") {
      this.#mouseDragged = false;
      if (!mapped.event.shift) {
        const cur = this.#composerDraftState();
        if (cur.mark !== null) {
          this.#accept([composerCaretEvent(cur.cursor, null)]);
        }
      }
    }
    if (mapped.event.kind === "drag") this.#mouseDragged = true;

    const out = this.#selection.handle(mapped.event);

    if (mapped.event.kind === "release") {
      this.#gestureOwner = null;
      const osc = this.#selection.copyOscIfReady(out);
      if (osc) {
        this.#options.output.write(osc);
        if (out.selection) {
          const end = this.#selection.rangeEnd() ?? out.selection.active;
          this.#showCopyToast(end, out.selection.anchor);
        }
      }
    }

    // Drag: latest-wins present at SELECTION_PAINT_HZ. Press/release tick now
    // (clear, copy-on-select, click) and cancel a trailing drag frame.
    if (mapped.event.kind === "drag") this.#paintSelectionSoon();
    else {
      this.#cancelSelectionPaintTimer();
      this.tick();
    }

    if (mapped.event.kind === "release") {
      // Drag-select in composer body → draft mark (textarea law); clear paint overlay.
      const draftSel = this.#composerSelectionFromGesture();
      if (draftSel) {
        this.#selection.clear();
        this.#accept([composerCaretEvent(draftSel.cursor, draftSel.mark)]);
        this.tick();
        return;
      }

      // Bare click only — drag over non-selectable thought must not toggle collapsed.
      if (!out.copyReady && !this.#selection.selection() && !this.#mouseDragged) {
        const offset = this.#composerOffsetAt(ev.col - 1, ev.row - 1);
        if (offset !== null) {
          const cur = this.#composerDraftState();
          const mark = mapped.event.shift ? (cur.mark ?? cur.cursor) : null;
          this.#accept([composerCaretEvent(offset, mark)]);
          this.tick();
          return;
        }
        this.onClick(ev.col, ev.row);
      }
    }
  }

  #accept(events: readonly DecodedKeyEvent[]): void {
    if (events.length === 0) return;

    // Insert/backspace/delete/kill: the selected range is the entity to replace.
    // Overlay (still dragging) or standing draft mark — not a collapsed caret.
    let batch = events;
    if (events.some((e) => isRangeEditKey(e))) {
      const draftSel = this.#composerSelectionFromGesture() ?? standingDraftSelection(this.#composerDraftState());
      if (draftSel) {
        this.#selection.clear();
        batch = [composerCaretEvent(draftSel.cursor, draftSel.mark), ...events];
      }
    }

    // Echo predicts from what is on screen NOW, before delivery.
    // Catalog / non-interactive composer: keys still deliver; do not invent a draft.
    if (this.#composerInteractive()) {
      const composerOuter = this.#composerOuterWidth();
      let current = this.#composerDraftState();
      for (const event of batch) {
        this.#echo = predict(this.#echo, current, event, {
          composerOuterWidth: composerOuter,
        });
        current = this.#echo.predicted ?? current;
      }
      if (this.#committed !== null && this.#paintLocal !== null) {
        writePaintEcho(this.#paintLocal, {
          predicted: this.#echo.predicted,
          misaligned: this.#echo.misaligned,
        });
      }
    }
    this.#queue = offer(this.#queue, batch);
    this.#drain();
    this.requestPaint(); // speculative echo is on screen next macrotask
  }

  /** Body hit is the text column (chrome_frame). */
  #composerOuterWidth(): number {
    const hit = this.#frame?.byKey.get(this.#composerFrameKey)?.hitRect;
    if (hit && hit.w > 0) return hit.w + CHROME_FRAME_BODY_CHROME;
    return Math.max(8, this.#geometry.cols);
  }

  #composerOffsetAt(col0: number, row0: number): number | null {
    const frame = this.#frame;
    if (!frame) return null;
    const hit = frame.byKey.get(this.#composerFrameKey)?.hitRect;
    if (!hit || hit.w <= 0 || hit.h <= 0) return null;
    if (col0 < hit.x || col0 >= hit.x + hit.w || row0 < hit.y || row0 >= hit.y + hit.h) {
      return null;
    }
    const draft = this.#composerDraftState().draft;
    return composerOffsetAtCell(draft, col0, row0, { col: hit.x, row: hit.y }, hit.w);
  }

  /** Visual selection entirely in composer body → draft {cursor, mark}. */
  #composerSelectionFromGesture(): { cursor: number; mark: number } | null {
    const sel = this.#selection.selection();
    if (!sel) return null;
    const frame = this.#frame;
    if (!frame) return null;
    const hit = frame.byKey.get(this.#composerFrameKey)?.hitRect;
    if (!hit || hit.w <= 0 || hit.h <= 0) return null;
    const inHit = (cell: { col: number; row: number }) =>
      cell.col >= hit.x && cell.col < hit.x + hit.w && cell.row >= hit.y && cell.row < hit.y + hit.h;
    if (!inHit(sel.anchor) || !inHit(sel.active)) return null;
    return composerDraftSelectionFromCells(
      this.#composerDraftState().draft,
      sel.anchor,
      sel.active,
      { col: hit.x, row: hit.y },
      hit.w,
    );
  }

  #drain(): void {
    const drained = deliver(this.#queue);
    this.#queue = drained.queue;
    if (drained.events.length > 0) this.#send({ kind: "input_events", events: drained.events });
  }

  onResize(cols: number, rows: number): void {
    this.#geometry = { cols, rows };
    this.#selection.setViewport(cols, rows);
    this.#selection.clear(); // cells moved; selection geometry is stale
    this.#previous = null; // resized buffer shares no rows with the old one
    this.#structural = null;
    this.#structuralKey = "";
    this.#lastPrepared = null;
    if (!this.#queue.ready) {
      // Latest-wins during boot.
      this.#pendingResize = { cols, rows };
      this.requestPaint();
      return;
    }
    this.#send({ kind: "resize", cols, rows });
    this.requestPaint();
  }

  /**
   * 1-based terminal cell → hit-test against painted frame.
   * Fold is host-local; `intent: "activate"` posts `activate{key}` (innermost).
   */
  onClick(col: number, row: number): void {
    const frame = this.#frame;
    if (frame === null || !this.#queue.ready) return;
    if (this.#agentsPreviewOpen() && !this.#pointerInPreview()) {
      this.#send({ kind: "activate", key: `${APP_AGENTS_PREVIEW_OVERLAY_KEY}:backdrop` });
      return;
    }
    const hit = elementAt(frame, col - 1, row - 1);
    if (hit === null) return;

    const toggle = toggleCollapsedFromHit(hit, frame.byKey);
    if (toggle) {
      const wasCollapsed = this.#thoughtCollapsed.get(toggle.blockId) ?? true;
      this.#thoughtCollapsed.set(toggle.blockId, !wasCollapsed);
      this.#paintSource?.toggleCollapsed?.(toggle.blockId);
      this.tick();
      return;
    }
    if (this.#agentsPreviewOpen()) return;

    const path = elementAtPath(frame, col - 1, row - 1);
    if (path === null) return;
    for (let i = path.length - 1; i >= 0; i--) {
      const link = path[i]!;
      if ((link.meta.intent === "activate" || link.meta.intent === "dismiss") && link.key) {
        this.#send({ kind: "activate", key: link.key });
        return;
      }
    }
  }

  /** Apply a paint-lane batch from the worker. */
  onPaintBatch(batch: readonly CadenceDownItem[]): void {
    let sawPaintInit = false;
    const boxes: BoxBusDownMessage[] = [];
    for (const down of batch) {
      if (down.kind === "paint_init") {
        sawPaintInit = true;
        continue;
      }
      boxes.push(down);
      if (down.kind === "box_set") {
        const incoming = readDraftState(down.value, this.#composerFrameKey);
        this.#echo = reconcile(this.#echo, down.boxId, incoming);
      }
    }
    const prevStructureGen = this.#mailbox.structureGen;
    if (boxes.length > 0) {
      this.#mailbox = applyBoxBusBatch(this.#mailbox, boxes);
      this.#capturePickerFromMailbox();
    }

    // I7: structureGen reflow moves cells — clear here. box_set must not:
    // selection_host content-stamp drops the extent only when serialize
    // diverges. Clearing on every set would drop selection on every token.
    if (this.#mailbox.structureGen !== prevStructureGen) {
      this.#selection.clear();
    }

    if (sawPaintInit || boxes.some((down) => down.kind === "structure")) this.#onStructure();
    this.requestPaint();
  }

  /** New structure: relearn composer box; first time opens delivery gate. */
  #onStructure(): void {
    this.#echo = withComposerBox(this.#echo, this.#composerBoxId());
    if (this.#queue.ready) return;
    this.#queue = markReady(this.#queue);
    this.#options.onReady?.();
    if (this.#pendingResize !== null) {
      this.#send({ kind: "resize", cols: this.#pendingResize.cols, rows: this.#pendingResize.rows });
      this.#pendingResize = null;
    }
    this.#drain();
  }

  #send(message: BoxBusUpMessage): void {
    this.#options.port.post(message);
  }

  #cancelSelectionPaintTimer(): void {
    if (this.#selectionPaintTimer === null) return;
    clearTimeout(this.#selectionPaintTimer);
    this.#selectionPaintTimer = null;
  }

  #cancelCopyToastTimers(): void {
    if (this.#copyToastArmTimer !== null) {
      clearTimeout(this.#copyToastArmTimer);
      this.#copyToastArmTimer = null;
    }
    if (this.#copyToastHoldTimer !== null) {
      clearTimeout(this.#copyToastHoldTimer);
      this.#copyToastHoldTimer = null;
    }
  }

  #showCopyToast(end: { col: number; row: number }, anchor: { col: number; row: number }): void {
    this.#cancelCopyToastTimers();
    this.#copyToast = { end, anchor };
    this.#copyToastArmed = false;
    if (this.#stopped) return;
    this.#copyToastArmTimer = setTimeout(() => {
      this.#copyToastArmTimer = null;
      if (this.#stopped || this.#copyToast === null) return;
      this.#copyToastArmed = true;
      this.#syncAnyMotion();
    }, COPY_TOAST_ARM_MS);
    this.#copyToastHoldTimer = setTimeout(() => {
      this.#copyToastHoldTimer = null;
      this.#dismissCopyToast(true);
    }, COPY_TOAST_HOLD_MS);
  }

  /**
   * Press always dismisses. Move / input / scroll dismiss only after the 3s arm.
   * Press does not paint — the caller ticks. Other kinds requestPaint.
   */
  #copyToastNotice(kind: "press" | "move" | "input" | "scroll"): void {
    if (this.#copyToast === null) return;
    if (kind !== "press" && !this.#copyToastArmed) return;
    this.#dismissCopyToast(kind !== "press");
  }

  #dismissCopyToast(paint: boolean): void {
    if (this.#copyToast === null) return;
    this.#copyToast = null;
    this.#copyToastArmed = false;
    this.#cancelCopyToastTimers();
    this.#syncAnyMotion();
    // Timer-driven present — same as trailing drag. requestPaint is setImmediate
    // coalesce; after copy the live loop is disarmed, so idle hold must tick now.
    if (paint) this.tick();
  }

  #syncAnyMotion(): void {
    const pickerPresent = this.#frame?.byKey.has("slash-complete:chrome") === true;
    const agentsPresent = this.#agentsViewport() !== null;
    if (!agentsPresent) {
      this.#clearAgentsHover();
    }
    const want = pickerPresent || agentsPresent || (this.#copyToast !== null && this.#copyToastArmed);
    if (want === this.#anyMotion) return;
    this.#anyMotion = want;
    this.#options.output.write(mouseAnyMotionBytes(want));
  }

  /**
   * Leading + trailing throttle for drag-select. First cell (or first after the
   * gap) paints now; further SGR in the window only keep gesture `active`.
   * One trailing timeout presents the latest cell when motion pauses.
   */
  #paintSelectionSoon(): void {
    if (this.#stopped) return;
    const wait = this.#selectionPaintAt + 1000 / SELECTION_PAINT_HZ - this.#now();
    if (wait <= 0) {
      this.#cancelSelectionPaintTimer();
      this.#selectionPaintAt = this.#now();
      this.tick();
      return;
    }
    if (this.#selectionPaintTimer !== null) return;
    this.#selectionPaintTimer = setTimeout(() => {
      this.#selectionPaintTimer = null;
      if (this.#stopped) return;
      this.#selectionPaintAt = this.#now();
      this.tick();
    }, wait);
  }

  /**
   * Paint one frame now. Reached only through a wake source (requestPaint,
   * live timer, a mouse press/release, or a throttled drag-select present).
   * Held ESC gets a belt-and-braces flush here; its primary path is the
   * one-shot quiet timer.
   */
  tick(): void {
    if (this.#stopped) return;
    this.#maybeFlushEsc();

    const tickStarted = this.#now();
    const nowMs = this.#now();
    if (this.#paintLocal !== null) {
      const local = this.#paintLocal;
      if (local.cols !== this.#geometry.cols || local.rows !== this.#geometry.rows) {
        runInAction(() => {
          local.cols = this.#geometry.cols;
          local.rows = this.#geometry.rows;
        });
      }
    }
    const prepared = this.#paintSource?.snapshot ?? this.#paintSource?.prepare() ?? emptyPreparedPaint();
    const retained = prepared.root !== null;
    if (retained && !this.#queue.ready) this.#onStructure();

    let progressDisplay: Map<string, { displayed: number; role?: string }>;
    let birth: Map<string, number>;
    let snapshot: ReturnType<typeof paintSnapshotFromMailbox>;
    let echo = this.#echo;

    if (retained) {
      const identity = prepared.contentIdentity;
      if (identity !== undefined && identity !== this.#contentIdentity) {
        this.#selection.clear();
        this.#contentIdentity = identity;
      }
      this.#committed = prepared;
      progressDisplay = this.#stepProgress(nowMs, prepared.progressSites);
      const birthInject = stepThoughtBirthFromSites(prepared.birthSites, this.#thoughtBirth, nowMs);
      birth = new Map<string, number>();
      for (const [id, field] of birthInject) birth.set(id, field.W);
      if (prepared.picker) this.#pickerLast = prepared.picker;
      snapshot = {
        tree: { root: prepared.root, boxes: {} },
        getBox: () => undefined,
      };
      echo = {
        boxId: null,
        predicted: this.#paintLocal?.echo.predicted ?? null,
        misaligned: this.#paintLocal?.echo.misaligned ?? false,
      };
    } else {
      this.#committed = null;
      progressDisplay = this.#stepProgress(nowMs);
      const collapsed = paintSnapshotWithThoughtCollapsed(
        paintSnapshotFromMailbox(this.#mailbox),
        this.#thoughtCollapsed,
      );
      const birthInject = stepThoughtBirthFromSnapshot(collapsed, this.#thoughtBirth, nowMs);
      birth = new Map<string, number>();
      for (const [id, field] of birthInject) birth.set(id, field.W);
      this.#capturePickerFromMailbox();
      snapshot = collapsed;
    }

    const hoverProgress = this.#pointerOverProgress();
    const pickerChrome =
      this.#pickerLast || this.#hoverKey || this.#pressKey
        ? { hoverKey: this.#hoverKey, pressKey: this.#pressKey }
        : undefined;
    const agentsChrome = this.#agentsHoverKey === null ? undefined : { hoverKey: this.#agentsHoverKey };
    const hostHotkeys = this.#quitArmed
      ? [{ key: "Ctrl+C", action: this.#options.quitAction?.() || "exit" }]
      : undefined;
    const birthLive = anyThoughtBirthLive(this.#thoughtBirth);
    let progressLive = false;
    for (const anim of this.#progress.values()) {
      if (progressBarLive(anim)) {
        progressLive = true;
        break;
      }
    }
    const spinnerHz = this.#frame?.liveDemand?.maxHz ?? 0;
    const extrasKey = [
      this.#geometry.cols,
      this.#geometry.rows,
      hostHotkeys?.map((h) => `${h.key}:${h.action}`).join("|") ?? "",
      this.#paintLocal?.modHeld === true ? "1" : "0",
      hoverProgress ? "1" : "0",
      pickerChrome?.hoverKey ?? "",
      pickerChrome?.pressKey ?? "",
      agentsChrome?.hoverKey ?? "",
      echo.predicted?.draft ?? "",
      echo.predicted?.cursor ?? "",
      echo.predicted?.mark ?? "",
      echo.misaligned ? "1" : "0",
      String(this.#themes.ground),
      this.#themes.depth,
    ].join("\u001F");
    const cachedStructural = this.#structural;
    const cachedFrame = this.#frame;
    const reuseFrame =
      prepared === this.#lastPrepared && cachedFrame !== null && this.#structuralKey === extrasKey && !progressLive;
    const reuseBuffer = reuseFrame && cachedStructural !== null && !birthLive && spinnerHz === 0;

    let rendered: ReturnType<typeof renderFrame>;
    let reusedFrame = false;
    if (reuseBuffer && cachedStructural !== null && cachedFrame !== null) {
      rendered = { buffer: cloneBuffer(cachedStructural), frame: cachedFrame };
      reusedFrame = true;
    } else if (reuseFrame && cachedFrame !== null) {
      const buffer = createBuffer(this.#geometry.cols, this.#geometry.rows);
      paintFrame(cachedFrame, buffer, this.#themes.binding.paint, { nowMs, birth });
      rendered = { buffer, frame: cachedFrame };
      reusedFrame = true;
    } else {
      rendered = renderFrame({
        snapshot,
        geometry: this.#geometry,
        state: {
          nowMs,
          echo,
          theme: this.#themes.binding.paint,
          hostHotkeys,
          birth,
          progress: progressDisplay,
          hoverProgress,
          pickerChrome,
          agentsChrome,
        },
      });
      this.#frame = rendered.frame;
      this.#lastPrepared = prepared;
      this.#structuralKey = extrasKey;
      const spinnerNow = rendered.frame?.liveDemand?.maxHz ?? 0;
      this.#structural = !birthLive && !progressLive && spinnerNow === 0 ? cloneBuffer(rendered.buffer) : null;
    }
    this.#syncTapeFromFrame();
    this.#syncPreviewFromFrame();

    const hasFx = bufferHasBgFx(rendered.buffer);
    if (hasFx) {
      this.#armBgfx();
      if (this.#fxEpoch === null) this.#fxEpoch = nowMs;
      materializeBgFx(rendered.buffer, {
        t: (nowMs - this.#fxEpoch) / 1000,
        polarity: canvasPolarity(this.#themes.ground),
        resolution: { x: rendered.buffer.width, y: rendered.buffer.height },
      });
    }

    // Selection recolor post-paint (same law as echo — never inside pure frame).
    if (rendered.frame !== null) {
      this.#selection.bindPaint(rendered.buffer, rendered.frame);
      this.#selection.recolor(rendered.buffer, rendered.frame, this.#themes.theme.ground);
    }

    // Copy-toast chrome on a clone — lastBuffer must stay free of plaque glyphs.
    let present = rendered.buffer;
    if (this.#copyToast !== null) {
      present = cloneBuffer(rendered.buffer);
      paintCopyToast(
        present,
        placeCopyToast({
          end: this.#copyToast.end,
          anchor: this.#copyToast.anchor,
          cols: present.width,
          rows: present.height,
        }),
        (style) => this.#themes.binding.paint.resolveStyle(style),
      );
    }

    const emitted = emitAnsiDetailed(this.#previous, present, {
      forceFull: this.#previous === null,
      sync2026: this.#options.sync2026 === true,
    });
    this.#previous = cloneBuffer(present);
    if (emitted.bytes > 0) {
      this.#options.onPresent?.({ dirtyRows: emitted.dirtyRows, bytes: emitted.bytes, reusedFrame });
    }
    const tickMs = this.#now() - tickStarted;
    if (tickMs > 32 || emitted.dirtyRows > 0) {
      tracePresent(tickMs, emitted.dirtyRows, emitted.bytes, reusedFrame);
    }
    // Always re-park caret after paint. Enter-alt hid it (`?25l`).
    const draftState = this.#composerDraftState();
    const interactive = this.#composerInteractive();
    const park = parkComposerCaret({
      draft: draftState.draft,
      cursor: draftState.cursor,
      frame: rendered.frame,
      cols: this.#geometry.cols,
      rows: this.#geometry.rows,
      // interactive:false is unfocused for caret. OS focus alone would park a waiting prompt.
      termFocused: this.#termFocused && interactive,
      composerFrameKey: this.#composerFrameKey,
    });
    const caret = caretAnsi(park);
    if (emitted.ansi.length > 0 || caret.length > 0) {
      this.#options.output.write(emitted.ansi + caret);
      if (!this.#paintedOnce) {
        this.#paintedOnce = true;
        this.#options.onFirstPaint?.();
      }
    }

    // fps-on-demand: keep a timer only while something on screen is alive.
    const cap = this.#options.targetFps ?? TARGET_FPS;
    const flourish = this.#options.flourishHz ?? DEFAULT_FLOURISH_HZ;
    const demandHz = Math.max(
      rendered.frame?.liveDemand?.maxHz ?? 0,
      birthLive ? flourish : 0,
      progressLive ? flourish : 0,
      hasFx ? flourish : 0,
    );
    this.#setLiveHz(Math.min(demandHz, cap));

    this.#syncAnyMotion();
    this.#syncPointerShape();
  }

  #maybeFlushEsc(): void {
    if (this.#pendingBytes !== "\u001B") return;
    if (this.#now() - this.#lastByteAt < ESC_QUIET_MS) return;
    const flushed = flushPendingEsc(this.#pendingBytes);
    this.#pendingBytes = flushed.pending;
    this.#acceptDecoded(flushed.events);
  }

  #boxIdForKey(key: string): number | null {
    const tree = this.#mailbox.tree;
    if (typeof tree !== "object" || tree === null) return null;
    const boxes = (tree as { boxes?: Record<string, number> }).boxes;
    const boxId = boxes?.[key];
    return typeof boxId === "number" ? boxId : null;
  }

  #composerBoxId(): number | null {
    return this.#boxIdForKey(this.#composerBoxKey);
  }

  /** Authoritative draft/caret/mark from mirror (or standing prediction). */
  #composerDraftState(): DraftState {
    if (this.#committed !== null) {
      const predicted = this.#paintLocal?.echo.predicted;
      if (predicted) return predicted;
      return this.#committed.composer;
    }
    if (this.#echo.predicted) return this.#echo.predicted;
    const boxId = this.#echo.boxId ?? this.#composerBoxId();
    if (boxId === null) return { draft: "", cursor: 0, mark: null };
    const value = this.#mailbox.boxes.get(boxId);
    return readDraftState(value, this.#composerFrameKey);
  }

  #composerInteractive(): boolean {
    if (this.#committed !== null) return this.#committed.composer.interactive;
    const boxId = this.#echo.boxId ?? this.#composerBoxId();
    if (boxId === null) return true;
    return readComposerInteractive(this.#mailbox.boxes.get(boxId), this.#composerFrameKey);
  }

  #stepProgress(
    nowMs: number,
    preparedSites?: readonly { key: string; progress: number; role?: string }[],
  ): Map<string, { displayed: number; role?: string }> {
    const sites: Array<{ key: string; progress: number; role?: string }> = [];
    if (preparedSites === undefined) {
      for (const value of this.#mailbox.boxes.values()) {
        if (typeof value === "object" && value !== null && "type" in value) {
          sites.push(...collectProgressSites(value as LayoutNode));
        }
      }
    } else {
      sites.push(...preparedSites);
    }
    const live = new Set<string>();
    const display = new Map<string, { displayed: number; role?: string }>();
    for (const site of sites) {
      live.add(site.key);
      const next = stepProgressBar(this.#progress.get(site.key), site.progress, site.role, nowMs);
      this.#progress.set(site.key, next);
      display.set(site.key, {
        displayed: next.displayed,
        role: next.displayedRole,
      });
    }
    for (const key of this.#progress.keys()) {
      if (!live.has(key)) this.#progress.delete(key);
    }
    return display;
  }

  #pointerOverProgress(): boolean {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (!ptr || !frame) return false;
    const hit = frame.byKey.get(`${this.#composerFrameKey}:progress`)?.hitRect;
    if (!hit || hit.w <= 0 || hit.h <= 0) return false;
    return ptr.col >= hit.x && ptr.col < hit.x + hit.w && ptr.row >= hit.y && ptr.row < hit.y + hit.h;
  }

  #capturePickerFromMailbox(): void {
    const node = findPickerNode(this.#mailbox.tree);
    if (!node) {
      for (const value of this.#mailbox.boxes.values()) {
        const found = findPickerNode(value);
        if (found) {
          this.#pickerLast = pickerLastFromNode(found);
          return;
        }
      }
      this.#pickerLast = null;
      this.#hoverKey = null;
      this.#pressKey = null;
      return;
    }
    this.#pickerLast = pickerLastFromNode(node);
  }

  #tapeViewport(): ReturnType<typeof tapeViewportMetrics> {
    const frame = this.#frame;
    if (frame === null) return null;
    return tapeViewportMetrics(frame.byKey);
  }

  #agentsViewport(): ReturnType<typeof agentsViewportMetrics> {
    const frame = this.#frame;
    if (frame === null) return null;
    return agentsViewportMetrics(frame.byKey);
  }

  #previewViewport(): ReturnType<typeof agentsPreviewViewportMetrics> {
    const frame = this.#frame;
    if (frame === null) return null;
    return agentsPreviewViewportMetrics(frame.byKey);
  }

  #pointerInTape(): boolean {
    const ptr = this.#pointer;
    const vp = this.#tapeViewport();
    if (!ptr || vp === null) return false;
    const r = vp.hitRect;
    return ptr.col >= r.x && ptr.col < r.x + r.w && ptr.row >= r.y && ptr.row < r.y + r.h;
  }

  #pointerInPreview(): boolean {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (!ptr || frame === null) return false;
    const modal = frame.byKey.get(APP_AGENTS_PREVIEW_KEY);
    if (modal === undefined) return false;
    const r = modal.hitRect;
    return ptr.col >= r.x && ptr.col < r.x + r.w && ptr.row >= r.y && ptr.row < r.y + r.h;
  }

  #toggleTapeExpanded(): void {
    const local = this.#paintLocal;
    if (local === null) return;
    writePaintTapeExpanded(local, !local.tapeExpanded);
    this.requestPaint();
  }

  #scrollTape(delta: number): void {
    const local = this.#paintLocal;
    const vp = this.#tapeViewport();
    if (local === null || vp === null) return;
    const from = local.tapeAtBottom ? vp.maxScroll : local.tapeScroll;
    const next = nextTapeScroll(from, delta, vp.maxScroll);
    if (next.scroll === local.tapeScroll && next.atBottom === local.tapeAtBottom) return;
    writePaintTapeScroll(local, next.scroll, next.atBottom);
    this.requestPaint();
  }

  #scrollPreview(delta: number): void {
    const local = this.#paintLocal;
    const vp = this.#previewViewport();
    if (local === null || vp === null) return;
    const from = local.previewAtBottom ? vp.maxScroll : local.previewScroll;
    const next = nextTapeScroll(from, delta, vp.maxScroll);
    if (next.scroll === local.previewScroll && next.atBottom === local.previewAtBottom) return;
    writePaintPreviewScroll(local, next.scroll, next.atBottom);
    this.requestPaint();
  }

  #syncTapeFromFrame(): void {
    const local = this.#paintLocal;
    const vp = this.#tapeViewport();
    if (local === null || vp === null) return;
    if (local.tapeAtBottom) {
      writePaintTapeScroll(local, vp.scrollY, true);
      return;
    }
    if (local.tapeScroll > vp.maxScroll) {
      writePaintTapeScroll(local, vp.maxScroll, true);
    }
  }

  #syncPreviewFromFrame(): void {
    const local = this.#paintLocal;
    if (local === null) return;
    const vp = this.#previewViewport();
    if (vp === null) {
      writePaintPreviewScroll(local, 0, true);
      return;
    }
    if (local.previewAtBottom) {
      writePaintPreviewScroll(local, vp.scrollY, true);
      return;
    }
    if (local.previewScroll > vp.maxScroll) {
      writePaintPreviewScroll(local, vp.maxScroll, true);
    }
  }

  #pointerInPickerChrome(): boolean {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (!ptr || !frame) return false;
    const chrome = frame.byKey.get("slash-complete:chrome");
    if (!chrome) return false;
    const r = chrome.hitRect;
    return ptr.col >= r.x && ptr.col < r.x + r.w && ptr.row >= r.y && ptr.row < r.y + r.h;
  }

  #pickerKeyAt(): string | null {
    const ptr = this.#pointer;
    const frame = this.#frame;
    const last = this.#pickerLast;
    if (!ptr || !frame || !last) return null;
    const chrome = frame.byKey.get("slash-complete:chrome");
    if (!chrome) return null;
    const r = chrome.hitRect;
    if (ptr.col < r.x || ptr.col >= r.x + r.w || ptr.row < r.y || ptr.row >= r.y + r.h) {
      return null;
    }
    const bodyRow = ptr.row - (r.y + 1);
    return last.paintRowToKey[bodyRow] ?? null;
  }

  #pointerInAgentsPanel(): boolean {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (!ptr || !frame) return false;
    const panel = frame.byKey.get("agents:panel");
    if (panel === undefined) return false;
    const r = panel.hitRect;
    return ptr.col >= r.x && ptr.col < r.x + r.w && ptr.row >= r.y && ptr.row < r.y + r.h;
  }

  #rectContains(r: { x: number; y: number; w: number; h: number }, col: number, row: number): boolean {
    return col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h;
  }

  #pointerInAgentsFurniture(): boolean {
    if (this.#pointerInAgentsPanel()) return true;
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (ptr == null || frame == null) return false;
    const peek = frame.byKey.get(APP_AGENTS_PEEK_KEY);
    if (peek !== undefined && this.#rectContains(peek.hitRect, ptr.col, ptr.row)) return true;
    const panel = frame.byKey.get("agents:panel");
    if (panel === undefined || peek === undefined) return false;
    const left = panel.hitRect.x + panel.hitRect.w;
    const right = peek.hitRect.x;
    const top = Math.min(panel.hitRect.y, peek.hitRect.y);
    const bottom = Math.max(panel.hitRect.y + panel.hitRect.h, peek.hitRect.y + peek.hitRect.h);
    return ptr.col >= left && ptr.col < right && ptr.row >= top && ptr.row < bottom;
  }

  #agentsKeepAliveKeyAt(): string | null {
    const hoverable = this.#agentsHoverableKeyAt();
    if (hoverable != null) return hoverable;
    if (this.#pointerInAgentsFurniture()) return this.#agentsHoverKey ?? this.#hoverSuppressKey;
    return null;
  }

  #applyAgentsPointer(): void {
    const next = this.#agentsKeepAliveKeyAt();
    if (this.#hoverSuppressKey !== null) {
      if (next === this.#hoverSuppressKey) return;
      this.#hoverSuppressKey = null;
    }
    if (next === this.#agentsHoverKey) return;
    this.#agentsHoverKey = next;
    this.requestPaint();
    this.#send({ kind: "agents_hover", key: next });
  }

  #armHoverSuppress(): void {
    this.#hoverSuppressKey = this.#agentsKeepAliveKeyAt() ?? this.#agentsHoverKey;
    if (this.#agentsHoverKey !== null) {
      this.#agentsHoverKey = null;
      this.requestPaint();
    }
  }

  #clearAgentsHover(): void {
    const had = this.#agentsHoverKey !== null || this.#hoverSuppressKey !== null;
    this.#hoverSuppressKey = null;
    if (this.#agentsHoverKey !== null) {
      this.#agentsHoverKey = null;
      this.requestPaint();
    }
    if (had) this.#send({ kind: "agents_hover", key: null });
  }

  #agentsPreviewOpen(): boolean {
    return this.#frame?.byKey.has(APP_AGENTS_PREVIEW_KEY) === true;
  }

  #agentsHoverableKeyAt(): string | null {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (!ptr || !frame || this.#agentsViewport() === null) return null;
    const path = elementAtPath(frame, ptr.col, ptr.row);
    if (path === null) return null;
    for (let i = path.length - 1; i >= 0; i--) {
      const key = path[i]!.key;
      if (key === "") continue;
      const row = agentsRowKeyFromHit(key);
      if (row == null) continue;
      if (row.startsWith("session:") || row.startsWith("call:")) return row;
    }
    return null;
  }

  #activateHit(): boolean {
    const ptr = this.#pointer;
    const frame = this.#frame;
    if (ptr == null || frame == null) return false;
    const path = elementAtPath(frame, ptr.col, ptr.row);
    if (path == null) return false;
    return path.some((link) => link.meta.intent === "activate");
  }

  #syncPointerShape(): void {
    const want: MousePointerShape = this.#activateHit() ? "pointer" : "default";
    if (want === this.#pointerShape) return;
    this.#pointerShape = want;
    this.#options.output.write(mousePointerBytes(want));
  }
}

type PickerLast = {
  paintRowToKey: readonly (string | null)[];
  n: number;
  viewport: number;
  scrollOffset: number;
};

type PickerMailboxNode = {
  picker: {
    rows: readonly { key?: string; href?: string }[];
    selectedKey: string | null;
    scrollOffset: number;
    viewport: number;
  };
};

function findPickerNode(value: unknown): PickerMailboxNode | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as {
    type?: unknown;
    key?: unknown;
    picker?: unknown;
    children?: unknown;
  };
  if (rec.type === "chrome_frame" && isPickerPayload(rec.picker)) {
    return { picker: rec.picker };
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      const found = findPickerNode(child);
      if (found) return found;
    }
  }
  return null;
}

function isPickerPayload(value: unknown): value is PickerMailboxNode["picker"] {
  if (typeof value !== "object" || value === null) return false;
  const p = value as {
    rows?: unknown;
    scrollOffset?: unknown;
    viewport?: unknown;
  };
  return Array.isArray(p.rows) && typeof p.scrollOffset === "number" && typeof p.viewport === "number";
}

function pickerLastFromNode(node: PickerMailboxNode): PickerLast {
  const { rows, scrollOffset, viewport } = node.picker;
  const n = rows.length;
  const maxS = Math.max(0, n - viewport);
  const scroll = Math.min(maxS, Math.max(0, scrollOffset));
  const visible = rows.slice(scroll, scroll + viewport);
  const paintRowToKey: Array<string | null> = [];
  for (const row of visible) {
    const key = row.key ?? null;
    paintRowToKey.push(key);
    if ((row.href ?? "").trim().length > 0) paintRowToKey.push(key);
  }
  return { paintRowToKey, n, viewport, scrollOffset: scroll };
}

/**
 * Walk box value (stack or chrome_frame) for draft/cursor/mark.
 *
 * Slash mode stacks `slash-complete` (list panel with bodySegRows, empty draft)
 * above `composer:frame`. Returning the first chrome_frame always hit the empty
 * list panel — caret stayed at cell 0 while typing. Only the omnibox chrome_frame
 * is the draft surface.
 */
export function readComposerInteractive(value: unknown, composerFrameKey = "composer:frame"): boolean {
  if (typeof value !== "object" || value === null) return true;
  const rec = value as {
    type?: string;
    key?: string;
    interactive?: unknown;
    bodySegRows?: unknown;
    children?: unknown[];
  };
  if (rec.type === "chrome_frame" && !Array.isArray(rec.bodySegRows)) {
    return rec.interactive !== false;
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      if (typeof child === "object" && child !== null && (child as { key?: string }).key === composerFrameKey) {
        return readComposerInteractive(child, composerFrameKey);
      }
    }
    for (const child of rec.children) {
      if (
        typeof child === "object" &&
        child !== null &&
        (child as { type?: string }).type === "chrome_frame" &&
        !Array.isArray((child as { bodySegRows?: unknown }).bodySegRows)
      ) {
        return readComposerInteractive(child, composerFrameKey);
      }
    }
  }
  return true;
}

export function readDraftState(value: unknown, composerFrameKey = "composer:frame"): DraftState {
  if (typeof value !== "object" || value === null) {
    return { draft: "", cursor: 0, mark: null };
  }
  const rec = value as {
    type?: string;
    key?: string;
    draft?: unknown;
    cursor?: unknown;
    mark?: unknown;
    bodySegRows?: unknown;
    children?: unknown[];
  };
  // List/completion chrome uses bodySegRows — not a draft surface.
  if (rec.type === "chrome_frame" && !Array.isArray(rec.bodySegRows)) {
    const draft = typeof rec.draft === "string" ? rec.draft : "";
    const cursor = typeof rec.cursor === "number" ? Math.max(0, Math.min(draft.length, rec.cursor)) : draft.length;
    const mark = typeof rec.mark === "number" ? Math.max(0, Math.min(draft.length, rec.mark)) : null;
    return { draft, cursor, mark };
  }
  if (Array.isArray(rec.children)) {
    for (const child of rec.children) {
      if (typeof child === "object" && child !== null && (child as { key?: string }).key === composerFrameKey) {
        return readDraftState(child, composerFrameKey);
      }
    }
    let emptyComposer: DraftState | null = null;
    for (const child of rec.children) {
      const found = readDraftState(child, composerFrameKey);
      if (found.draft.length > 0 || found.cursor > 0 || found.mark !== null) {
        return found;
      }
      if (
        typeof child === "object" &&
        child !== null &&
        (child as { type?: string }).type === "chrome_frame" &&
        !Array.isArray((child as { bodySegRows?: unknown }).bodySegRows)
      ) {
        // Empty draft is still a valid omnibox (placeholder / idle).
        emptyComposer = found;
      }
    }
    if (emptyComposer) return emptyComposer;
  }
  return { draft: "", cursor: 0, mark: null };
}

/** Standing draft mark — the range insert/backspace/delete replace. */
function tracePresent(tickMs: number, dirtyRows: number, bytes: number, reusedFrame: boolean): void {
  const raw = process.env.DEBUG;
  if (raw === undefined || raw.trim() === "") return;
  const names = raw.split(/[\s,]+/).filter((part) => part !== "");
  const enabled = names.some((part) => {
    const name = part.startsWith("-") ? "" : part;
    return name === "*" || name === "quickdraw:present" || name === "quickdraw:*" || name.startsWith("quickdraw:");
  });
  if (!enabled) return;
  process.stderr.write(
    `${new Date().toISOString()} quickdraw:present pid=${process.pid} tickMs=${tickMs} dirtyRows=${dirtyRows} bytes=${bytes} reused=${reusedFrame}\n`,
  );
}

function standingDraftSelection(state: DraftState): { cursor: number; mark: number } | null {
  if (selectionRange(state) === null) return null;
  const mark = state.mark;
  if (mark === null) return null;
  return { cursor: state.cursor, mark };
}
