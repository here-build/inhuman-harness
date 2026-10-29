/**
 * Worker Tea. Posts paint_init / paint_patch. Catalog is CommandSpec plus
 * host verbs — host-verbs.ts has no CommandSpec body; invoke locally.
 *
 * Omnibox winner lives in omnibox-seat.ts, CHANGE ONLY.
 */
import { exec } from "@here.build/arrival";
import { isUiForm, type UiForm } from "@inhuman.tools/harness-contract";
import { fail, step, trace } from "@inhuman.tools/harness-diagnostics";
import {
  type BlobPeek,
  type KernelRoot,
  type PermissionMode,
  CallJob,
  AgentMessageJob,
  otherSessionSeatCount,
  ApprovableJob,
  DEFAULT_CONTEXT_GLOW_REMAINING,
  STATUSLINE_NOTE_SEP,
  fileReadPreparedPath,
  mcpReadFloorDenies,
  type McpPersistScope,
  parseCompactTrigger,
  parseSuperKey,
  PERMISSION_MODES,
  MCPToolJob,
  isAtTip,
  isRewindPin,
  onTipChain,
  previousPin,
  futurePins,
  pastPins,
  resolvedTip,
  reactChunks,
  tapeCompletion,
  type GrantRow,
  type GrantSubject,
  layersOf,
  type SessionPlexus,
  SessionRoot,
  SessionTurn,
  sessionDisplayTitle,
  skillMatchesVerb,
  type SessionUnit,
  ToolCallJob,
} from "@inhuman.tools/harness-model";
import { createBlobCache } from "@inhuman.tools/harness-peer";
import {
  type AgentDrawerRow,
  type Client,
  flattenAgentDrawer,
  hostAskEscalateSessionId,
  mentionedAgentCall,
  projectAgentDrawer,
  projectRecentSessions,
  openExternalUrl,
} from "@inhuman.tools/harness-sdk";
import {
  agentAskStackedBody,
  agentCoverPrompt,
  agentRecipeDescription,
  agentSpecKey,
  coverAskAnnotation,
  shellAskCommand,
  askPaintHead,
  emptyWaitChrome,
  formatMcpArgs,
  mcpConfirmViewport,
} from "@inhuman.tools/harness-sdk/text";
import type { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import { CLASSES } from "@inhuman.tools/policy/floor";
import { applyDraftOp, type DraftState } from "@inhuman.tools/quickdraw/input";
import { type ChromeQuotaWindow, type ChromeStatusItem, eventMatchesChord } from "@inhuman.tools/quickdraw/layout";
import {
  agentsRowKeyFromHit,
  type BoxBusUpMessage,
  keyEventToDraftOp,
  maybeVisualMotion,
  receiveSubmit,
  rootInnerWidth,
  sessionIdFromAgentsKey,
  type SubmitCommand,
  type SubmitPart,
} from "@inhuman.tools/quickdraw/runtime";
import {
  catalogKey,
  COMPOSER_COMMAND_MAX_VISIBLE,
  type ComposerCommand,
  type ComposerCommandAction,
  type ComposerCommandChoice,
  type ComposerCommandFallback,
  type ComposerErrorAnnotation,
  matchComposerCommand,
  peekScroll,
  reconcileSelectedKey,
} from "@inhuman.tools/quickdraw/widgets";
import { action, comparer, computed, type IReactionDisposer, observable, reaction, runInAction, when } from "mobx";
import invariant from "tiny-invariant";

import {
  ackAnnotation,
  ackPromptModel,
  ackVariant,
  cycleAck,
  type AckChoice,
  type AckPromptModel,
  type AckScope,
} from "./ack-prompt.js";
import { agentsPaintFace } from "./agents-drawer.js";
import { HOTKEY_EVENT } from "./ask-shortcuts.js";
import { HOST_VERBS, isHostVerb } from "./host-verbs.js";
import {
  omniboxSeat,
  omniboxStackPanel,
  paintOmnibox,
  type OmniboxAsk,
  type OmniboxOverlay,
  type OmniboxSeat,
  type OmniboxSlash,
  type OmniboxValue,
} from "./omnibox-seat.js";
import {
  createPaintController,
  isCompletionCutoff,
  trackEqual,
  trackTurn,
  type PaintController,
  type WaitPinChrome,
} from "./paint-controller.js";
import type { RootPaintInstance } from "./paint-dom.js";
import type { PaintDownMessage } from "./paint-transport.js";
import {
  parseProbe,
  permissionsSurface,
  permissionsView,
  type ExplainOutcome,
  type PermissionsInput,
} from "./permissions-view.js";
import { fileReadWiden, type FileReadWiden } from "./read-widen.js";
import { rewindNeighborSlots } from "./rewind-chrome.js";
import { cwdParts } from "./statusline-path.js";
import { waitPhrase } from "./wait-phrase.js";
import { askPinFace, askPinWorthPainting } from "./work-cells.js";
import { ComputedExecBox } from "../interpreter/ComputedExecBox.js";
import { imageCapability } from "../interpreter/imageCapability.js";
import { rpcCapability } from "../interpreter/rpcCapability.js";
import { uiCapability, UiNode } from "../interpreter/uiCapability.js";

const COMMAND_CAPABILITIES = [imageCapability, uiCapability, rpcCapability];
/** Mash after cancel must not peel into history. Tea-local; the turn must also be idle. */
const REWIND_GRACE_MS = 1000;

/** Browser seam — tests inject a fake; production defaults hit the OS. */
export type TeaDeps = {
  readonly open?: (url: string) => void;
  readonly now?: () => number;
  readonly title?: (text: string) => void;
  /** `/quit` — host sets shutdown then kills this worker. */
  readonly quit?: () => void;
  /** `spec.resident` — host paints the Ctrl-C hint. */
  readonly resident?: (on: boolean) => void;
  /**
   * `/new` — host worker-swap mint. Drawer switch passes `sessionId` (restore).
   * `path` is the session being left. `draft` is slash remainder, not the `/new` token.
   */
  readonly replaceSession?: (opts: { path: string; draft?: string; sessionId?: string }) => void;
};

export function bootComposerDraft(
  draft: string | undefined,
  connections: Iterable<ConnectionSpec>,
): string | undefined {
  if (draft != null && draft !== "") return draft;
  for (const spec of connections) {
    if (spec.driver?.abilityClaim.includes("completion")) return undefined;
  }
  return "/connect";
}

export class Tea implements Disposable {
  @observable accessor draft: DraftState = { draft: "", cursor: 0, mark: null };
  /** Last honest submit. Parts and command stay apart; the string draft is typing only. */
  @observable accessor submission: { parts: readonly SubmitPart[]; command: SubmitCommand | null } | null = null;
  @observable accessor selectedCommandKey: string | null = null;
  @observable accessor scrollOffset = 0;
  @observable accessor escClearArmed = false;
  @observable accessor cols = 80;
  @observable accessor rows = 24;
  @observable accessor #busy = false;
  @observable accessor #callback: { pending: string; surface: UiNode } | undefined = undefined;
  @observable accessor #focus: UiNode | undefined = undefined;
  @observable accessor #oauthWaiting = false;
  /** Overlay action fired; ui/resolve (or the next park) has not landed yet. */
  @observable accessor #processing = false;
  @observable accessor #coverDraft: DraftState = { draft: "", cursor: 0, mark: null };
  @observable.ref accessor #coverThrottle: {
    episodeFrom: string | null;
    armedUntil: number;
  } = { episodeFrom: null, armedUntil: 0 };
  @observable accessor #coverConfirmLive = false;
  /** see omnibox-seat.ts, CHANGE ONLY. */
  /** Which remember option of the acknowledgement prompt is picked (reset when another call asks). */
  @observable accessor #ackPick: { readonly id: string; readonly index: number } = { id: "", index: 0 };
  @observable accessor #askHold = false;
  @observable accessor #drainAsk = false;
  @observable accessor #agentsOpen = false;
  @observable accessor #agentsFocus: string | null = null;
  @observable accessor #agentsHover: string | null = null;
  @observable accessor #agentsScroll = 0;
  @observable accessor #agentsPreview: string | null = null;
  @observable.ref accessor #peekPlexus: SessionPlexus | null = null;
  @observable.ref accessor #askPlexus: SessionPlexus | null = null;
  /** Turns this client asked the daemon to cancel; only `turn/cancel` writes `cancelRequested`. */
  readonly #cancelAsked = observable.set<SessionTurn>([], { deep: false });
  #askedPolicy: (typeof PERMISSION_MODES)[number] | null = null;
  /** Local tape selection. Null follows `head`. Enter commits via `turn/rewind`. */
  @observable.ref accessor #viewPin: SessionTurn | null = null;
  /** Double-Esc on empty. Arrows move the view; Esc / Enter leave. */
  @observable accessor #historyNav = false;
  @observable.ref accessor #restoredDraft: { turnId: string; prompt: string } | null = null;
  #rewindPending = false;
  #askBindGen = 0;
  readonly #paint: PaintController;
  /** Blob text the document names, fetched on demand. Peeks are MobX reads: a landing repaints what peeked. */
  readonly #blobs: BlobPeek;
  readonly #disposers: IReactionDisposer[] = [];
  readonly #execs = new Map<string, { body: string; exec: ComputedExecBox<unknown> }>();
  #lastModelEvalLog = "";

  #resolveWaiter: ((value: Record<string, unknown>) => void) | undefined;
  #savedDraft: DraftState | undefined;
  #agentsParked: DraftState | undefined;
  /** The pending whose `opened` answer is in flight; Esc sends it a cancel. */
  #waitingPending: string | undefined;
  #coverTimer: ReturnType<typeof setTimeout> | undefined;
  #rewindGraceUntil = 0;
  readonly #open: (url: string) => void;
  readonly #now: () => number;
  readonly #title?: (text: string) => void;
  readonly #quit?: () => void;
  readonly #resident?: (on: boolean) => void;
  readonly #replaceSession?: (opts: { path: string; draft?: string; sessionId?: string }) => void;

  get #superKey() {
    return parseSuperKey(this.client.kernelRoot.superKey);
  }

  constructor(
    readonly client: Client,
    readonly post: (batch: readonly PaintDownMessage[]) => void,
    options: { cols?: number; rows?: number; draft?: string } & TeaDeps = {},
  ) {
    this.cols = options.cols ?? 80;
    this.rows = options.rows ?? 24;
    this.#open = options.open ?? openExternalUrl;
    this.#now = options.now ?? Date.now;
    this.#title = options.title;
    this.#quit = options.quit;
    this.#resident = options.resident;
    this.#replaceSession = options.replaceSession;
    if (options.draft != null && options.draft !== "") {
      this.draft = { draft: options.draft, cursor: options.draft.length, mark: null };
    }
    // A landing is a write keyed by hash, so only what peeked that blob re-runs: the same path a document change takes.
    const landed = observable.map<string, number>([], { deep: false });
    const blobCache = createBlobCache(
      (method, params) => this.client.request(method, params),
      (sha256) => runInAction(() => landed.set(sha256, (landed.get(sha256) ?? 0) + 1)),
    );
    this.#blobs = {
      peek: (sha256) => {
        landed.get(sha256);
        return blobCache.peek(sha256);
      },
      want: (sha256) => blobCache.want(sha256),
    };
    this.#paint = createPaintController((message) => this.post([message]), "paint", {
      agentGlance: (job) => agentTapeGlance(job, this.client.kernelRoot, this.client.sessionRoot.kvs.model),
      kernel: this.client.kernelRoot,
      cancelAsked: (turn) => this.#cancelAsked.has(turn),
      blobs: this.#blobs,
    });
    this.client.setComputedAttention(() => this.#attentionSubjects);
    this.client.setComputedAttentionFocus(() => this.#activeConnection ?? null);
    this.#disposers.push(
      reaction(
        () => sessionDisplayTitle(this.client.sessionRoot),
        (title) => this.#title?.(title),
        { fireImmediately: true },
      ),
      reaction(
        () => this.client.sessionRoot.agent.spec.resident,
        (on) => this.#resident?.(on),
        { fireImmediately: true },
      ),
      reaction(
        () => askLeafId(this.#askHead),
        () => this.#stepCoverThrottle(),
        { fireImmediately: true },
      ),
      reaction(
        () => this.#paintComposerFace(),
        (face) => this.#paint.projectComposer(face),
        { fireImmediately: true },
      ),
      reaction(
        () => this.#askPinFace(),
        (face) => this.#paint.projectAsk(face),
        { fireImmediately: true },
      ),
      reaction(
        () => this.#waitChrome,
        (chrome) => this.#paint.projectWait(chrome),
        { fireImmediately: true },
      ),
      reaction(
        () => [this.client.sessionRoot.path, this.client.sessionRoot.statuslineLeft] as const,
        ([path, left]) => {
          const parts = cwdParts(path);
          const cut = left.indexOf(STATUSLINE_NOTE_SEP);
          this.#paint.projectStatusline({
            cwd: `${parts.root}${parts.rest}`,
            cwdRoot: parts.root,
            left: cut === -1 ? left : left.slice(0, cut),
            note: cut === -1 ? "" : left.slice(cut + STATUSLINE_NOTE_SEP.length),
          });
        },
        { fireImmediately: true },
      ),
      reaction(
        () => this.#paintTrackSpine(),
        () => {
          this.#paint.syncSpine(this.#paintSpineTurns(), this.client.sessionRoot.steerQueue);
          this.#applyPinRecap();
        },
        { fireImmediately: true, equals: trackEqual },
      ),
      reaction(
        () => this.#rewindPaintTrack(),
        () => this.#syncRewindPaint(),
        { fireImmediately: true },
      ),
      reaction(
        () => this.#previewPaintTrack(),
        () =>
          this.#paint.syncPreviewSpine(
            this.#agentsPreview === null ? null : this.#previewSpineTurns(),
            this.#peekPlexus?.root.kvs.model,
          ),
        { fireImmediately: true, equals: trackEqual },
      ),
      reaction(
        () => this.#agentsPaintFace(),
        (face) => this.#paint.projectAgents(face),
        { fireImmediately: true },
      ),
      reaction(
        () => hostAskEscalateSessionId(this.client),
        (id) => {
          void this.#bindAskEscalate(id);
        },
        { fireImmediately: true },
      ),
    );
    this.#paint.attach();
  }

  /** Write tree. Cadence / visual present read the host replica, not this. */
  get paintRoot(): RootPaintInstance {
    return this.#paint.root;
  }

  flushPaint(): void {
    this.#paint.flush();
  }

  #paintComposerFace() {
    const face = paintOmnibox(this.#omniboxValue);
    return this.#agentsOpen || this.#agentsPreview !== null ? { ...face, interactive: false } : face;
  }

  #agentsPaintFace() {
    const keys = this.#agentsRowKeys();
    if (this.#agentsHover !== null && !keys.includes(this.#agentsHover)) {
      runInAction(() => {
        this.#agentsHover = null;
      });
    }
    if (
      this.#agentsPreview !== null &&
      !keys.includes(this.#agentsPreview) &&
      mentionedAgentCall(this.client, this.#agentsPreview) == null
    ) {
      runInAction(() => {
        this.#closeAgentsPreview();
      });
    }
    return agentsPaintFace(this.client, {
      open: this.#agentsOpen,
      focusKey: this.#agentsHover ?? this.#agentsFocus,
      scroll: this.#agentsScroll,
      previewKey: this.#agentsPreview,
    });
  }

  @computed
  get #agentDrawerRows(): readonly AgentDrawerRow[] {
    return flattenAgentDrawer(projectAgentDrawer(this.client));
  }

  #agentsRowKeys(): readonly string[] {
    return this.#agentDrawerRows.map((row) => row.key);
  }

  #openAgents(): void {
    this.#agentsParked = { draft: this.draft.draft, cursor: this.draft.cursor, mark: this.draft.mark };
    Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
    this.#resetSelection();
    this.#agentsOpen = true;
    this.#agentsScroll = 0;
    this.#agentsFocus = this.#agentsRowKeys()[0] ?? null;
    this.#agentsHover = null;
  }

  #closeAgents(): void {
    this.#closeAgentsPreview();
    const parked = this.#agentsParked;
    this.#agentsParked = undefined;
    this.#agentsOpen = false;
    this.#agentsFocus = null;
    this.#agentsHover = null;
    this.#agentsScroll = 0;
    if (parked !== undefined) Object.assign(this.draft, parked);
  }

  #moveAgentsFocus(delta: number): void {
    const keys = this.#agentsRowKeys();
    if (keys.length === 0) return;
    if (this.#agentsHover !== null) {
      this.#agentsFocus = this.#agentsHover;
      this.#agentsHover = null;
    }
    const i = Math.max(0, keys.indexOf(this.#agentsFocus ?? ""));
    const next = Math.min(keys.length - 1, Math.max(0, i + delta));
    this.#agentsFocus = keys[next]!;
    this.#agentsScroll = Math.max(0, next);
  }

  #handleAgentsChord(
    event: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean },
    seat: OmniboxSeat,
  ): boolean {
    const chord = event.ctrl === true || event.meta === true || event.alt === true;
    if (this.#omniboxValue.ask !== null) return false;
    if (this.#agentsPreviewConsumes(event)) return true;
    if (!this.#agentsOpen) {
      if (chord || event.key !== "ArrowLeft" || this.draft.draft !== "") return false;
      if (seat.input === "overlay" || seat.input === "auth") return false;
      this.#openAgents();
      return true;
    }
    return this.#agentsDrawerConsumes(event);
  }

  #agentsPreviewConsumes(event: { key: string }): boolean {
    if (this.#agentsPreview === null) return false;
    if (event.key === "Escape") this.#closeAgentsPreview();
    return true;
  }

  #agentsDrawerConsumes(event: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean }): boolean {
    if (event.ctrl === true || event.meta === true || event.alt === true) return true;
    if (event.key === "j" || event.key === "ArrowDown") {
      this.#moveAgentsFocus(1);
      return true;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      this.#moveAgentsFocus(-1);
      return true;
    }
    if (event.key === "ArrowRight" || event.key === "Escape") {
      this.#closeAgents();
      return true;
    }
    if (event.key === "Enter") {
      this.#activateAgentsKey(this.#agentsHover ?? this.#agentsFocus);
      return true;
    }
    return true;
  }

  #focusAgentsKey(key: string): void {
    const row = agentsRowKeyFromHit(key) ?? key;
    const keys = this.#agentsRowKeys();
    const i = keys.indexOf(row);
    if (i === -1) return;
    this.#agentsFocus = keys[i]!;
    this.#agentsScroll = Math.max(0, i);
  }

  #activateAgentsKey(key: string | null): void {
    if (key == null) return;
    const rowKey = agentsRowKeyFromHit(key) ?? key;
    const row = this.#agentDrawerRows.find((item) => item.key === rowKey);
    if (row?.kind === "call") {
      this.#openAgentsPreview(row.key, row.sessionId);
      return;
    }
    const sessionId = sessionIdFromAgentsKey(key);
    if (sessionId == null) return;
    this.#switchSession(sessionId);
  }

  #openAgentsPreview(key: string, sessionId: string): void {
    this.#agentsPreview = key;
    if (this.client.peekPlexus?.root.sessionId === sessionId) {
      this.#peekPlexus = this.client.peekPlexus;
      return;
    }
    this.#peekPlexus = null;
    this.client.releasePeek();
    if (sessionId === "") return;
    const token = key;
    void this.client
      .watchPeek(sessionId)
      .then(() => {
        return runInAction(() => {
          if (this.#agentsPreview !== token) return;
          this.#peekPlexus = this.client.peekPlexus;
        });
      })
      .catch(() => undefined);
  }

  #closeAgentsPreview(): void {
    this.#agentsPreview = null;
    this.#peekPlexus = null;
    this.client.releasePeek();
  }

  async #bindAskEscalate(id: string | null): Promise<void> {
    const gen = ++this.#askBindGen;
    if (id == null) {
      runInAction(() => {
        this.#askPlexus = null;
      });
      this.client.releaseAsk();
      return;
    }
    if (this.client.askPlexus?.root.sessionId === id) {
      runInAction(() => {
        this.#askPlexus = this.client.askPlexus;
      });
      return;
    }
    try {
      await this.client.watchAsk(id);
    } catch {
      // TODO: swallowed — glance says awaiting, so no cover mounts until the
      // ask interns. Same shape as watchPeek. Surface or log, do not silently
      // retry (the ask still lives on the host queue).
      return;
    }
    if (gen !== this.#askBindGen) return;
    runInAction(() => {
      if (hostAskEscalateSessionId(this.client) !== id) return;
      this.#askPlexus = this.client.askPlexus;
    });
  }

  #switchSession(sessionId: string): void {
    if (sessionId === this.client.sessionId) {
      this.#closeAgents();
      return;
    }
    if (!projectRecentSessions(this.client).some((row) => row.sessionId === sessionId)) {
      this.#closeAgents();
      void this.#showNotice("session not found");
      return;
    }
    if (this.#replaceSession === undefined) return;
    this.#replaceSession({ path: this.client.sessionRoot.path, sessionId });
  }

  #paintSpineTurns(): SessionTurn[] {
    const root = this.client.sessionRoot;
    return tapeSpine(this.#historyNav ? resolvedTip(root.head, root.tip) : root.head);
  }

  @computed
  get #sessionTitle(): string {
    return (
      this.client.sessionRoot.manualTitle.trim() ||
      resolvedTip(this.client.sessionRoot.head, this.client.sessionRoot.tip)?.metadata?.title ||
      ""
    );
  }

  @computed
  get #isHeadAtTip(): boolean {
    return isAtTip(this.client.sessionRoot.head, this.client.sessionRoot.tip);
  }

  #viewTurn(): SessionTurn | null {
    const head = this.client.sessionRoot.head;
    const tip = resolvedTip(head, this.client.sessionRoot.tip);
    const view = this.#viewPin;
    if (view instanceof SessionTurn && onTipChain(view, tip, head)) return view;
    return head instanceof SessionTurn ? head : null;
  }

  get #untouchedRestoredDraft(): boolean {
    return (
      this.#restoredDraft != null &&
      this.#restoredDraft.turnId === this.client.sessionRoot.head?.uuid &&
      this.#restoredDraft.prompt === this.draft.draft
    );
  }

  #browsing(): boolean {
    return this.#historyNav;
  }

  #enterHistory(): void {
    if (this.#viewTurn() == null) return;
    if (this.client.sessionRoot.findRunningTurn() != null) return;
    const head = this.client.sessionRoot.head;
    if (head instanceof SessionTurn && head.openWork) return;
    this.#historyNav = true;
    // A promptless suffix (continue, empty compact) is not a message. Land
    // on the latest prompt so Enter rolls that suffix back instead of
    // prefilling an empty draft over a head that never moves.
    if (head instanceof SessionTurn && !isRewindPin(head)) {
      const pin = previousPin(head);
      if (pin != null) this.#viewPin = pin;
    }
  }

  #leaveHistory(): void {
    this.#historyNav = false;
    this.#viewPin = null;
  }

  /**
   * Turns newer than `view`, oldest first. Pins, then the episode ceiling
   * when it is not already that last pin — a promptless continue, or the
   * last message once `futurePins` has stopped short of it.
   */
  #aheadOf(view: SessionTurn): SessionTurn[] {
    const tip = this.client.sessionRoot.tip;
    const ahead = futurePins(view, tip);
    const ceiling = resolvedTip(view, tip);
    if (ceiling != null && ceiling !== view && ahead.at(-1) !== ceiling) ahead.push(ceiling);
    return ahead;
  }

  #moveView(turn: SessionTurn | null): void {
    // Keep the pin even when it is `head`. Rewind cuts *before* the selected
    // message, so head is the turn we just left — ArrowDown has to be able
    // to land back on it.
    this.#viewPin = turn;
    this.#historyNav = true;
  }

  #pinById(id: string): SessionTurn | null {
    const head = this.client.sessionRoot.head;
    const tip = resolvedTip(head, this.client.sessionRoot.tip);
    let unit: SessionUnit | null = tip;
    const seen = new Set<SessionTurn>();
    while (unit instanceof SessionTurn) {
      if (seen.has(unit)) break;
      seen.add(unit);
      if (unit.uuid === id && (isRewindPin(unit) || unit === tip)) return unit;
      unit = unit.turnTail;
    }
    return null;
  }

  #applyPinRecap(): void {
    const view = this.#viewTurn();
    const running = this.client.sessionRoot.findRunningTurn() != null;
    if (running || view == null || !this.#historyNav || this.#callback !== undefined) {
      this.#paint.projectPinRecap(null);
      return;
    }
    this.#paint.projectPinRecap(view, this.#sessionTitle, [
      { key: "Enter", action: "Rollback here" },
      { key: "Esc", action: "Back" },
      ...(previousPin(view) == null ? [] : [{ key: "↑", action: "Previous message" }]),
      ...(this.#aheadOf(view).length === 0 ? [] : [{ key: "↓", action: "Next message" }]),
    ]);
  }

  #rewindPaintTrack(): unknown {
    const head = this.client.sessionRoot.head;
    const tip = this.client.sessionRoot.tip;
    return [
      head?.uuid ?? "",
      tip?.uuid ?? "",
      this.#viewPin?.uuid ?? "",
      this.#historyNav,
      this.client.sessionRoot.findRunningTurn()?.uuid ?? "",
      this.#sessionTitle,
      this.#callback?.surface.name ?? "",
    ];
  }

  #syncRewindPaint(): void {
    const tip = this.client.sessionRoot.tip;
    const view = this.#viewTurn();
    const running = this.client.sessionRoot.findRunningTurn() != null;
    const rewindChromeCollapsed = running || !this.#historyNav || view == null || this.#callback !== undefined;
    // LATEST_PLACE: the view is the episode ceiling, so there is no newer
    // message and the ahead stack drops. The composer stays hidden either
    // way — the recap block is the input while history navigation is open.
    const latestPlace = !rewindChromeCollapsed && view != null && isAtTip(view, tip);
    const pastAll = rewindChromeCollapsed ? [] : pastPins(view);
    const futureAll = rewindChromeCollapsed || latestPlace || view == null ? [] : this.#aheadOf(view);
    const slots = rewindNeighborSlots(futureAll.length, pastAll.length);
    const past = pastAll
      .slice(0, slots.behind)
      .toReversed()
      .map((turn) => ({ key: turn.uuid, text: turn.prompt }));
    const future = futureAll
      .slice(0, slots.ahead)
      .map((turn) => ({ key: turn.uuid, text: turn.prompt || "Latest conversation" }));
    const steal =
      this.#omnibox.render === "ask" || this.#omnibox.render === "overlay" || this.#omnibox.render === "auth";
    this.#paint.projectRewind({
      // atTip is "not browsing". The ceiling still browses: it dims the
      // tape and scrolls to the block. Follow-tail is only for the live view.
      atTip: rewindChromeCollapsed,
      seatRim: steal || !this.#browsing(),
      past,
      future,
      pastTotal: pastAll.length,
      futureTotal: futureAll.length,
    });
    this.#applyPinRecap();
  }

  #previewSpineTurns(): SessionTurn[] {
    if (this.#agentsPreview == null) return [];
    return tapeSpine(this.#peekPlexus?.root.head ?? null);
  }

  #paintTrackSpine(): unknown {
    const tip = resolvedTip(this.client.sessionRoot.head, this.client.sessionRoot.tip);
    return [
      this.client.kernelRoot.hideFloorTools,
      this.#trackSpine(this.#paintSpineTurns()),
      this.client.sessionRoot.steerQueue.map((row) => [row, row.text]),
      tip?.uuid ?? "",
      this.client.sessionRoot.findRunningTurn()?.uuid ?? "",
    ];
  }

  #previewPaintTrack(): unknown {
    return [
      this.#agentsPreview,
      this.client.kernelRoot.hideFloorTools,
      this.#peekPlexus?.root.kvs.model ?? "",
      this.#trackSpine(this.#previewSpineTurns()),
    ];
  }

  /**
   * Structure only — turn/chunk identity, cutoff, ask pin, hidden tools.
   * PEW field values belong to per-cell reactions in PaintController.
   */
  #trackSpine(turns: readonly SessionTurn[]): unknown {
    return turns.map((turn) => [trackTurn(turn), this.#cancelAsked.has(turn)]);
  }

  @computed
  get #askHead(): ApprovableJob | null {
    const host = this.client.sessionRoot.findRunningTurn()?.approvalHead ?? null;
    if (host != null) return host;
    const id = hostAskEscalateSessionId(this.client);
    if (id == null || this.#askPlexus?.root.sessionId !== id) return null;
    return this.#askPlexus.root.findRunningTurn()?.approvalHead ?? null;
  }

  /** The acknowledgement the asked call carries, when a flag still waits on a person. */
  @computed
  get #ackPrompt(): AckPromptModel | null {
    const leaf = this.#askHead;
    if (leaf == null) return null;
    const variant = ackVariant({
      ackPending: leaf.ackPending,
      policyResult: leaf.policyResult,
      baseDecision: leaf.baseLicenseDetail.decision,
    });
    if (variant === null) return null;
    return ackPromptModel({
      variant,
      flags: leaf.ackFlags,
      options: leaf.ackOptions,
      bot: this.#askHome.agent.spec.name.trim() !== "",
    });
  }

  get #ackIndex(): number {
    const leaf = this.#askHead;
    const model = this.#ackPrompt;
    if (leaf == null || model == null || this.#ackPick.id !== leaf.uuid) return 0;
    return Math.min(this.#ackPick.index, Math.max(0, model.choices.length - 1));
  }

  @computed
  get #coverAskAgentSpec(): string | undefined {
    const leaf = this.#askHead;
    if (leaf == null) return undefined;
    if (this.client.sessionRoot.findRunningTurn()?.approvalHead === leaf) return undefined;
    const id = hostAskEscalateSessionId(this.client);
    if (id == null) return undefined;
    for (const agent of this.client.agents) {
      if (agent.sessionId === id) return agent.specName;
    }
    return "";
  }

  @computed
  get #askHome(): SessionRoot {
    const host = this.client.sessionRoot;
    if (host.findRunningTurn()?.approvalHead != null) return host;
    const id = hostAskEscalateSessionId(this.client);
    if (id != null && this.#askPlexus?.root.sessionId === id) return this.#askPlexus.root;
    return host;
  }

  @computed
  get #readWiden(): FileReadWiden | undefined {
    const leaf = this.#askHead;
    if (!(leaf instanceof ToolCallJob)) return undefined;
    const root = this.#askHome;
    const prepared = fileReadPreparedPath(root.path, leaf.name, leaf.args);
    if (prepared === undefined) return undefined;
    // Evidence is another outside read in flight, or a folder already treated as part of this session.
    const observed = Object.keys(root.readRoots);
    const turn = root.findRunningTurn();
    for (const job of turn?.approvalLeaves ?? []) {
      if (!(job instanceof ToolCallJob) || job === leaf) continue;
      const path = fileReadPreparedPath(root.path, job.name, job.args);
      if (path !== undefined) observed.push(path);
    }
    return fileReadWiden(root.path, prepared, observed);
  }

  @computed
  get #omniboxValue(): OmniboxValue {
    const overlay = this.#callback?.surface;
    const leaf = this.#askHead;
    const running = this.client.sessionRoot.findRunningTurn();
    let overlayBag: OmniboxOverlay | null = null;
    if (overlay !== undefined) {
      const message = overlay.description === "" ? overlay.name : overlay.description;
      const url = urlFrom(overlay);
      const overlayText =
        url === undefined || message.includes(url) ? message : message === "" ? url : `${message}\n${url}`;
      const overlayAsBody = !hasInputHole(overlay) && url === undefined;
      const instructional = this.#inputting && (url !== undefined || overlay.description.trim() !== "");
      overlayBag = {
        body: overlayAsBody ? overlayText : undefined,
        placeholder: overlayAsBody || this.#oauthWaiting || instructional ? undefined : overlayText,
        secret: overlay.secret === true,
        inputting: this.#inputting,
        processing: this.#processing,
        commandChoices: this.#commandChoices,
        commandAction: this.#commandAction,
        selectedCommandKey: this.effectiveKey,
      };
    }
    const slash: OmniboxSlash | null =
      overlay !== undefined || this.#pickerRows === undefined
        ? null
        : {
            commandChoices: this.#commandChoices,
            commandAction: this.#commandAction,
            selectedCommandKey: this.effectiveKey,
          };
    const widen = this.#readWiden;
    const model = nonempty(this.client.sessionRoot.kvs.model);
    const asked = coverAskAnnotation(leaf, {
      model,
      kernel: this.client.kernelRoot,
      agentSpec: this.#coverAskAgentSpec,
    });
    const mcpDeny = leaf instanceof MCPToolJob && mcpReadFloorDenies(leaf.serverToolName);
    const ack = this.#ackPrompt;
    const ackChoice = ack?.choices[this.#ackIndex];
    const ask: OmniboxAsk | null =
      leaf === null
        ? null
        : {
            armed: this.#coverConfirmLive,
            // The daemon's offer for this exact call: a family for an ask, nothing for a soft-deny.
            ...(leaf.grantOptions.length === 0 ? {} : { remember: leaf.grantOptions[0]!.label }),
            persistDeny: mcpDeny,
            caution: leaf.policyResult === "deny",
            tier: leaf.policyResult === "deny" ? "Soft-deny" : "Ask",
            classLabels: leaf.policyClasses.map((id) => CLASSES[id].label),
            ...(leaf.judgeReason == null || leaf.classifierResult === null
              ? {}
              : { judgeLine: `Judge: ${leaf.judgeReason}` }),
            widen: widen?.label,
            ...(ack === null
              ? {}
              : {
                  ack: {
                    variant: ack.variant,
                    ...(ackChoice === undefined ? {} : { choice: ackChoice.text }),
                    cycle: ack.choices.length > 1,
                  },
                }),
            annotation: askAnnotation(leaf, asked, widen, ack ?? undefined),
            ...askStack(leaf, this.rows, this.client.kernelRoot.bots),
          };
    return {
      draft: {
        draft: this.draft.draft,
        cursor: this.draft.cursor,
        mark: this.draft.mark,
      },
      cover: {
        draft: this.#coverDraft.draft,
        cursor: this.#coverDraft.cursor,
        mark: this.#coverDraft.mark,
      },
      ask,
      slash,
      overlay: overlayBag,
      auth: this.#oauthWaiting ? { waiting: true } : null,
      queue:
        running == null
          ? null
          : {
              stackedBody: this.#admissionDeckText,
              queued: this.client.sessionRoot.promptQueue.length,
              running: true,
            },
      busy: this.#busy,
      escClearArmed: this.escClearArmed,
      lastTurnIncomplete: this.client.sessionRoot.lastTurnIncomplete,
      atTip: !this.#browsing() && this.#isHeadAtTip,
      restoredDraft: this.#untouchedRestoredDraft,
      retainedHistory: !this.#browsing() && !this.#isHeadAtTip,
      sessionTitle: this.#sessionTitle,
      retrying: isRetrying(running, this.#now()),
      superKey: this.#superKey,
      errorAnnotation: this.#errorAnnotation() ?? null,
      statusItems: this.#statusItems,
      quotaWindows: this.#quotaWindows,
      ...this.#contextRail,
      scrollOffset: this.scrollOffset,
    };
  }

  @computed({ equals: comparer.structural })
  get #contextRail(): {
    progress: number;
    progressGlowAt: number;
    contextUsed: number;
    contextLimit: number;
  } {
    const glowAt =
      parseCompactTrigger(this.client.kernelRoot.contextGlowRemaining) ??
      parseCompactTrigger(DEFAULT_CONTEXT_GLOW_REMAINING) ??
      0.75;
    const liveModel = nonempty(this.client.sessionRoot.kvs.model);
    const catalogLimit = catalogContextLimit(this.#activeConnection, liveModel);
    const head = this.client.sessionRoot.head;
    if (head instanceof SessionTurn) {
      // A model switch moves the window before the next round reports it —
      // the tape still carries the prior model's stamp (empty until a round
      // names one). Re-base on the live model's catalog window so the rail
      // follows the switch immediately; the tape's own stamp takes over again
      // once a round re-measures it. A stale window beats none.
      const switched = liveModel !== "" && head.contextModel !== liveModel;
      const limit = switched ? catalogLimit || head.contextLimit : head.contextLimit;
      return {
        progress: head.contextRemainingProgress(this.client.kernelRoot.compactTriggers.soft, limit) ?? 0,
        progressGlowAt: glowAt,
        contextUsed: head.contextUsed,
        contextLimit: limit,
      };
    }
    return {
      progress: 0,
      progressGlowAt: glowAt,
      contextUsed: 0,
      contextLimit: catalogLimit,
    };
  }

  @computed
  get #omnibox(): OmniboxSeat {
    return omniboxSeat(this.#omniboxValue);
  }

  @computed
  get #askIsolated(): boolean {
    return this.#omnibox.input === "ask";
  }

  get #historyHidesOmnibox(): boolean {
    if (!this.#browsing()) return false;
    const render = this.#omnibox.render;
    return render !== "ask" && render !== "overlay" && render !== "auth";
  }

  /** Next-turn rows only. A sitting steer paints as an upcoming user prompt. */
  @computed
  get #admissionDeckText(): string {
    const lines: string[] = [];
    for (const row of this.client.sessionRoot.promptQueue) {
      const text = row.text.trim();
      if (text !== "") lines.push(text);
    }
    return lines.join("\n");
  }

  #askPinFace() {
    const seat = this.#omnibox;
    if (seat.render === "overlay" || seat.render === "auth") return null;
    const host = this.client.sessionRoot.findRunningTurn();
    const turn = host?.approvalHead == null ? this.#askHome.findRunningTurn() : host;
    const head = turn == null ? null : askPaintHead(turn);
    if (head instanceof ToolCallJob) {
      const face = askPinFace(head, this.client.kernelRoot, this.#blobs);
      return askPinWorthPainting(face) ? face : null;
    }
    return null;
  }

  /**
   * Plexus facts for the pin. The paint tree is MST, so the constructor
   * reaction stamps this through `projectWait`.
   */
  @computed.struct
  get #waitChrome(): WaitPinChrome | null {
    return waitPhrase({
      seat: () => this.#omnibox.render,
      historyHides: () => this.#historyHidesOmnibox,
      ask: () => this.#askPinFace() != null,
      occupancy: () => {
        const head = this.client.sessionRoot.head;
        return head instanceof SessionTurn && !this.#cancelAsked.has(head) ? emptyWaitChrome(head) : null;
      },
      cancel: () => this.#processing && this.client.sessionRoot.findRunningTurn() != null,
      catalog: () => {
        const connectionId = (this.client.sessionRoot.kvs.connection ?? "").trim();
        const spec = connectionId === "" ? undefined : this.client.kernelRoot.connections[connectionId];
        const models = spec == null ? [] : Array.isArray(spec.live.models) ? spec.live.models : [];
        return { connectionId, readyState: spec?.readyState ?? null, modelCount: models.length };
      },
      slash: () => slashVerb(this.draft.draft),
      error: () => this.#errorAnnotation()?.message ?? "",
    });
  }

  get #inputting(): boolean {
    return (
      this.#callback !== undefined && hasInputHole(this.#callback.surface) && !this.#oauthWaiting && !this.#processing
    );
  }

  @computed
  get #commands(): readonly ComposerCommand[] {
    const byVerb = new Map<string, ComposerCommand>();
    for (const spec of Object.values(this.client.kernelRoot.commands)) {
      if (spec.verb === "" || isHostVerb(spec.verb)) continue;
      byVerb.set(spec.verb, {
        name: spec.verb,
        description: spec.description === "" ? undefined : spec.description,
        aliases: spec.aliases,
      });
    }
    const compact = this.client.kernelRoot.commands.compact;
    byVerb.set("compact", {
      name: "compact",
      description:
        compact?.description !== undefined && compact.description !== ""
          ? compact.description
          : "Compact conversation context",
      aliases: compact?.aliases,
    });
    const rename = this.client.kernelRoot.commands.rename;
    byVerb.set("rename", {
      name: "rename",
      description:
        rename?.description !== undefined && rename.description !== ""
          ? rename.description
          : "Set or clear the session title",
      aliases: rename?.aliases,
    });
    const minted = this.client.kernelRoot.commands.new;
    byVerb.set("new", {
      name: "new",
      description:
        minted?.description !== undefined && minted.description !== "" ? minted.description : "Mint a new session",
      aliases: minted?.aliases,
    });
    const quit = this.client.kernelRoot.commands.quit;
    byVerb.set("quit", {
      name: "quit",
      description: quit?.description !== undefined && quit.description !== "" ? quit.description : "Leave the TUI",
      aliases: quit?.aliases,
    });
    const agentic = this.client.kernelRoot.commands.agentic;
    byVerb.set("agentic", {
      name: "agentic",
      description:
        agentic?.description !== undefined && agentic.description !== ""
          ? agentic.description
          : "Keep the session running without a client",
      aliases: agentic?.aliases,
    });
    const background = this.client.kernelRoot.commands.background;
    byVerb.set("background", {
      name: "background",
      description:
        background?.description !== undefined && background.description !== ""
          ? background.description
          : "Keep the session running and leave the TUI",
      aliases: background?.aliases,
    });
    const rewind = this.client.kernelRoot.commands.rewind;
    byVerb.set("rewind", {
      name: "rewind",
      description:
        rewind?.description !== undefined && rewind.description !== ""
          ? rewind.description
          : "Rewind conversation one step; files stay",
      aliases: rewind?.aliases ?? ["undo"],
    });
    const permissions = this.client.kernelRoot.commands.permissions;
    byVerb.set("permissions", {
      name: "permissions",
      description:
        permissions?.description !== undefined && permissions.description !== ""
          ? permissions.description
          : "Mode, grants, acknowledgements; explain a call",
      aliases: permissions?.aliases,
    });
    const skillEscape = new Set<string>();
    for (const skill of this.client.sessionRoot.skills) {
      const verb = skill.invoke === "" ? skill.name : skill.invoke;
      if (verb !== "" && !isHostVerb(verb) && !byVerb.has(verb)) {
        byVerb.set(verb, {
          name: verb,
          description: skill.description === "" ? undefined : skill.description,
        });
      }
      if (skillEscape.has(skill.name)) continue;
      skillEscape.add(skill.name);
      const escape = `skill:${skill.name}`;
      if (escape === "" || isHostVerb(escape) || byVerb.has(escape)) continue;
      byVerb.set(escape, {
        name: escape,
        description: skill.description === "" ? undefined : skill.description,
      });
    }
    return [...byVerb.values()];
  }

  #skillVerb(verb: string): boolean {
    if (isHostVerb(verb) || this.client.kernelRoot.commands[verb] !== undefined) return false;
    return this.client.sessionRoot.skills.some((skill) => skillMatchesVerb(skill, verb));
  }

  @computed
  get #parentNode(): UiNode | undefined {
    if (this.#callback !== undefined) return this.#callback.surface;
    if (this.#focus !== undefined) return this.#focus;
    return this.#commandSurface;
  }

  @computed
  get #inCommand(): boolean {
    const verb = slashVerb(this.draft.draft);
    if (verb === null) return false;
    if (isHostVerb(verb)) return true;
    if (this.client.kernelRoot.commands[verb] !== undefined) return true;
    return this.#skillVerb(verb);
  }

  @computed
  get #atCatalog(): boolean {
    if (this.#parentNode !== undefined) return false;
    if (this.#inCommand) return false;
    return (this.draft.draft.split("\n")[0] ?? "").trim().startsWith("/");
  }

  @computed
  get #pickerRows(): readonly UiNode[] | undefined {
    if (this.#focus !== undefined) {
      return this.#focus.choices.filter((child) => child.name !== "");
    }
    const parent = this.#parentNode;
    if (parent !== undefined) {
      const verb = slashVerb(this.draft.draft) ?? "";
      const needle = (this.draft.draft.split("\n")[0] ?? "")
        .trim()
        .slice(verb.length + 1)
        .trim()
        .toLowerCase();
      const named = parent.choices.filter((child) => child.name !== "");
      const exact = named.some((child) => child.name.toLowerCase() === needle);
      return named.filter((child) => {
        if (needle === "" || exact) return true;
        const hay = [child.name, child.annotation, child.description, child.healthAnnotation, ...child.aliases]
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    if (this.#atCatalog) return this.#catalogNodes;
    if (this.#inCommand) return [];
    return undefined;
  }

  @computed
  get #catalogNodes(): readonly UiNode[] {
    return matchComposerCommand(this.draft.draft, this.#commands).matches.map(
      (cmd) =>
        new UiNode(
          cmd.name.replace(/^\//, ""),
          cmd.description ?? "",
          cmd.aliases ?? [],
          "ok",
          "",
          undefined,
          [],
          [],
          [],
          null,
          {},
        ),
    );
  }

  @computed
  get #commandChoices(): readonly ComposerCommandChoice[] | undefined {
    const rows = this.#pickerRows;
    if (rows === undefined) return undefined;
    const catalog = this.#atCatalog;
    const parent = this.#focus === undefined ? this.#parentNode : this.#focus;
    const named = parent === undefined ? undefined : parent.choices.filter((child) => child.name !== "");
    return rows.map((node) => {
      const unfilteredIndex = named === undefined ? -1 : named.indexOf(node);
      const name = catalog && !node.name.startsWith("/") ? `/${node.name}` : node.name;
      const annotation = node.annotation.trim();
      const description = node.description.trim();
      const healthAnnotation = node.healthAnnotation.trim();
      return {
        key: catalog ? catalogKey(node.name) : `choice:${unfilteredIndex}:${node.name}`,
        name,
        description: description || healthAnnotation || undefined,
        annotation: annotation === "" ? undefined : annotation,
        status: node.health === "ok" ? undefined : node.health,
        actionDisplayName: primaryDisplayName(node) ?? (isActivatable(node, catalog) ? "select" : undefined),
        actions: pickerActions(node, catalog),
      };
    });
  }

  @computed
  get effectiveKey(): string | null {
    return reconcileSelectedKey(this.selectedCommandKey, this.#commandChoices ?? []);
  }

  @computed
  get #commandAction(): ComposerCommandFallback | undefined {
    const surface = this.#parentNode;
    if (surface === undefined) return undefined;
    const row =
      surface.description.trim() === ""
        ? (primaryDisplayName(surface) ??
          (surface.action[0]?.name === "" ? "select" : (surface.action[0]?.name ?? surface.name)))
        : surface.description;
    if (this.#processing) {
      return { name: row, displayName: row, actions: [], href: urlFrom(surface) };
    }
    const actions = this.#oauthWaiting
      ? pickerActions(surface).filter((item) => item.hotkey?.toLowerCase() === "escape")
      : pickerActions(surface);
    if (actions.length === 0) return undefined;
    return {
      name: row,
      displayName: row,
      actions,
      href: urlFrom(surface),
    };
  }

  /** Picker rows. Logic reads this; paint is not the catalog. */
  get commandChoices(): readonly ComposerCommandChoice[] | undefined {
    return this.#commandChoices;
  }

  /** Composer title. Manual title wins; otherwise the latest metadata claim. */
  get sessionTitle(): string {
    return this.#sessionTitle;
  }

  /** Quota windows Tea hands to paint. Paint spells the remaining label. */
  get quotaWindows(): readonly ChromeQuotaWindow[] {
    return this.#quotaWindows ?? [];
  }

  /** Parked confirm / oauth surface. Null when the composer owns the draft. */
  get callbackSurface(): UiNode | null {
    return this.#callback?.surface ?? null;
  }

  // COMMAND_SURFACE_KEEPALIVE: isolated-ask paint skips this surface for a
  // tick. Without keepAlive, onBecomeUnobserved runs exec.get() and aborts
  // the command-body eval.
  @computed({ keepAlive: true })
  get #commandSurface(): UiNode | undefined {
    if (this.#callback !== undefined) return this.#callback.surface;
    const verb = slashVerb(this.draft.draft);
    if (verb === null) return undefined;
    const body = this.client.kernelRoot.commands[verb]?.body;
    if (body === undefined || body === "") return undefined;
    const surface = this.#execFor(verb, body, this.client.kernelRoot).get();
    if (verb === "model") this.#noteModelEval(surface);
    return surface instanceof UiNode ? surface : undefined;
  }

  #noteModelEval(surface: unknown): void {
    const kernel = this.client.kernelRoot;
    const session = this.client.sessionRoot;
    const connections = Object.values(kernel.connections).map((spec) => {
      const models = Array.isArray(spec.live.models) ? spec.live.models.map(String) : [];
      const can = spec.driver?.abilityClaim ?? [];
      return `${spec.id} can=${can.join(",") || "(none)"} ready=${spec.readyState} models=${models.length}`;
    });
    const choices =
      surface instanceof UiNode ? surface.choices.filter((child) => child.name !== "").length : "no-surface";
    const replica = this.client.kernelPlexus.doc;
    const line = `command evaluation: current connection=${session.kvs.connection ?? ""} model=${session.kvs.model ?? ""} surface=${choices} replica=guid=${replica.guid} client=${replica.clientID} ${connections.join("; ") || "connections=(none)"}`;
    if (line === this.#lastModelEvalLog) return;
    this.#lastModelEvalLog = line;
    step(line);
  }

  #commandConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kernel: this.client.kernelRoot,
      session: this.client.sessionRoot,
      rpc: (method: string, params?: unknown) => this.client.request(method, params),
      ...extra,
    };
  }

  #execFor(verb: string, body: string, kernel: KernelRoot): ComputedExecBox<unknown> {
    const hit = this.#execs.get(verb);
    if (hit !== undefined && hit.body === body) return hit.exec;
    const box = new ComputedExecBox(body, {
      capabilities: COMMAND_CAPABILITIES,
      config: this.#commandConfig({ kernel }),
    });
    this.#execs.set(verb, { body, exec: box });
    return box;
  }

  @computed
  get #selectedIndex(): number {
    const keyed = this.#commandChoices;
    if (keyed === undefined || keyed.length === 0) return 0;
    const i = keyed.findIndex((row) => row.key === this.effectiveKey);
    return Math.max(i, 0);
  }

  @action
  focusAt(index: number): void {
    const keyed = this.#commandChoices;
    if (keyed === undefined || keyed.length === 0) return;
    const i = ((index % keyed.length) + keyed.length) % keyed.length;
    this.selectedCommandKey = keyed[i]!.key ?? null;
    const sel = keyed.findIndex((row) => row.key === this.selectedCommandKey);
    this.scrollOffset = peekScroll(sel, keyed.length, COMPOSER_COMMAND_MAX_VISIBLE, this.scrollOffset);
  }

  #draftFromKey(
    state: DraftState,
    event: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean },
  ): DraftState | null {
    const op = keyEventToDraftOp(event);
    if (op === null || op === "clear") return null;
    return applyDraftOp(state, maybeVisualMotion(op, state, rootInnerWidth(this.cols)));
  }

  #peekSelection(): void {
    const keyed = this.#commandChoices;
    if (keyed === undefined || keyed.length === 0) {
      if (omniboxStackPanel(this.#omniboxValue).body === "") this.scrollOffset = 0;
      return;
    }
    const sel = keyed.findIndex((row) => row.key === this.effectiveKey);
    this.scrollOffset = peekScroll(sel, keyed.length, COMPOSER_COMMAND_MAX_VISIBLE, this.scrollOffset);
  }

  #resetSelection(): void {
    this.selectedCommandKey = null;
    this.#peekSelection();
  }

  @action
  handle(message: BoxBusUpMessage): void {
    switch (message.kind) {
      case "resize":
        this.cols = message.cols;
        this.rows = message.rows;
        return;
      case "input_events": {
        this.#stepCoverThrottle();
        if (this.#askHead != null || this.#drainAsk) this.#askHold = true;
        if (this.#agentsOpen && this.#omniboxValue.ask !== null) this.#closeAgents();
        let draftChanged = false;
        for (const event of message.events) {
          if (this.escClearArmed && event.key !== "Escape") this.escClearArmed = false;
          if (this.#handleHotkey(event)) continue;
          if (this.#askIsolated) {
            const next = this.#draftFromKey(this.#coverDraft, event);
            if (next === null) continue;
            Object.assign(this.#coverDraft, next);
            continue;
          }
          if (this.#historyHidesOmnibox) continue;
          if (this.#busy && !this.#inputting) continue;
          const prevVerb = slashVerb(this.draft.draft);
          const prevInCommand = this.#inCommand;
          const prevText = this.draft.draft;
          const next = this.#draftFromKey(this.draft, event);
          if (next === null) continue;
          if (next.draft !== this.draft.draft) {
            draftChanged = true;
            if (slashVerb(next.draft) !== prevVerb) this.#focus = undefined;
          }
          Object.assign(this.draft, next);
          if (next.draft !== prevText) {
            this.#askHold = false;
            this.#drainAsk = false;
          }
          // see COMMAND_SURFACE_KEEPALIVE.
          if (this.#inCommand !== prevInCommand || (this.#inCommand && slashVerb(this.draft.draft) !== prevVerb)) {
            this.selectedCommandKey = null;
          }
        }
        if (this.#askHead == null && !this.#drainAsk) this.#askHold = false;
        if (draftChanged) this.#peekSelection();
        return;
      }
      case "picker_activate": {
        const keyed = this.#commandChoices;
        const nodes = this.#pickerRows;
        if (keyed === undefined || nodes === undefined) return;
        const i = keyed.findIndex((row) => row.key === message.key);
        if (i !== -1) this.#pick(nodes[i]!, true);
        return;
      }
      case "picker_scroll": {
        const panel = omniboxStackPanel(this.#omniboxValue);
        if (panel.body !== "") {
          const n = panel.body.split("\n").length;
          const viewport = panel.viewport ?? n;
          const maxS = Math.max(0, n - viewport);
          this.scrollOffset = Math.min(maxS, Math.max(0, this.scrollOffset + message.delta));
          return;
        }
        const n = this.#commandChoices?.length ?? 0;
        const maxS = Math.max(0, n - COMPOSER_COMMAND_MAX_VISIBLE);
        this.scrollOffset = Math.min(maxS, Math.max(0, this.scrollOffset + message.delta));
        return;
      }
      case "agents_scroll":
        if (!this.#agentsOpen || this.#agentsPreview !== null) return;
        this.#agentsScroll = Math.max(0, this.#agentsScroll + message.delta);
        return;
      case "agents_focus":
        if (!this.#agentsOpen || this.#agentsPreview !== null) return;
        this.#focusAgentsKey(message.key);
        return;
      case "agents_hover": {
        if (!this.#agentsOpen || this.#agentsPreview !== null) return;
        if (message.key == null) {
          this.#agentsHover = null;
          return;
        }
        const row = agentsRowKeyFromHit(message.key) ?? message.key;
        this.#agentsHover = this.#agentsRowKeys().includes(row) ? row : null;
        return;
      }
      case "submit": {
        const received = receiveSubmit(message);
        if (received !== null) this.submission = received;
        return;
      }
      case "activate":
        if (this.#agentsPreview !== null) {
          if (message.key.endsWith(":backdrop")) this.#closeAgentsPreview();
          return;
        }
        if (message.key.startsWith("mention:")) {
          const call = mentionedAgentCall(this.client, `call:${message.key.slice("mention:".length)}`);
          if (call != null) {
            this.#openAgentsPreview(call.key, call.sessionId);
            return;
          }
        }
        if (this.#agentsOpen) {
          if (message.key.endsWith(":backdrop")) {
            this.#closeAgents();
            return;
          }
          this.#activateAgentsKey(message.key);
          return;
        }
        {
          const pin = this.#pinById(message.key);
          if (pin != null) this.#moveView(pin);
        }
        return;
      default:
        return;
    }
  }

  /**
   * Honest submit wins. Text parts join into the prompt. Picture bytes ride
   * beside it. The command stays out of both. With no submission, the typed
   * string goes as before.
   */
  #submitTurn(kind?: "queue"): boolean {
    const typed = this.draft.draft.trim();
    const honest = this.submission;
    const joined = honest !== null && honest.parts.length > 0 ? promptFromParts(honest.parts) : null;
    const prompt = joined === null ? typed : joined.text;
    const visuals = joined?.visuals ?? [];
    if (prompt.trim() === "" && visuals.length === 0) return false;
    const params: Record<string, unknown> = { prompt };
    if (kind !== undefined) params.kind = kind;
    if (visuals.length > 0) params.visuals = visuals;
    trace("harness:turn", `submit chars=${prompt.trim().length}`);
    this.#fire([new UiNode("turn", "", [], "ok", "", undefined, [], [], [], "turn", params)], true);
    this.submission = null;
    return true;
  }

  #fire(leaves: readonly UiNode[] | undefined, dismiss = false): void {
    if (leaves === undefined || leaves.length === 0) return;
    if (this.#resolveWaiter !== undefined) {
      const leaf = leaves.find((item) => item.op === "ui/resolve") ?? leaves[0];
      if (leaf?.op === "ui/resolve") {
        this.#completeCallback(fillParams(jsonParams(leaf.params), this.#remainder));
      }
      return;
    }
    if (this.#busy) return;
    void this.#run(leaves, dismiss);
  }

  /** One named RPC at a time. A `{ form: "ui" }` result parks in the omnibox. */
  async #run(leaves: readonly UiNode[], dismiss = false): Promise<void> {
    const saved = dismiss ? { draft: this.draft.draft, cursor: this.draft.cursor, mark: this.draft.mark } : null;
    runInAction(() => {
      if (dismiss) {
        this.#savedDraft = saved ?? undefined;
        this.#focus = undefined;
        this.escClearArmed = false;
        Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
        this.#resetSelection();
      }
      this.#busy = true;
    });
    try {
      for (const leaf of leaves) {
        if (leaf.op == null) continue;
        const params = fillParams(jsonParams(leaf.params), this.#remainder);
        let log = `tea ${leaf.op}`;
        if (leaf.op === "kv/set" || leaf.op === "kv/clear") {
          const key = typeof params.key === "string" ? params.key : "";
          if (key !== "") {
            const scope = params.scope === "kernel" || params.scope === "project" ? params.scope : "session";
            if (leaf.op === "kv/clear") {
              log += ` ${scope} ${key}`;
            } else {
              const value = typeof params.value === "string" ? params.value : "";
              log += ` ${scope} ${key}=${value}`;
            }
          }
        }
        step(log);
        let result: unknown = await this.client.request(leaf.op, params);
        while (isUiForm(result)) {
          result = await this.#awaitCallback(result);
        }
        const refused = refusalOf(result);
        if (refused !== undefined) throw new Error(refused);
        if (leaf.op === "connect/adopt") {
          const value = typeof result === "object" && result !== null ? (result as { id?: unknown }).id : undefined;
          const id = typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
          if (id !== undefined) {
            const connection = { key: "connection", value: id };
            step(`tea kv/set session connection=${id}`);
            await this.client.request("kv/set", connection);
            runInAction(() => {
              this.#savedDraft = undefined;
              this.draft = { draft: "/model", cursor: 6, mark: null };
              this.#resetSelection();
            });
          }
        }
      }
      const kvs = this.client.sessionRoot.kvs;
      step(`tea replica model=${kvs.model ?? ""} connection=${kvs.connection ?? ""}`);
    } catch (error) {
      if (saved !== null) {
        runInAction(() => {
          Object.assign(this.draft, saved);
        });
      }
      fail("tea run", error);
      await this.#showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      runInAction(() => {
        this.#busy = false;
        this.#processing = false;
        this.#callback = undefined;
        this.#focus = undefined;
      });
    }
  }

  async #showNotice(message: string): Promise<void> {
    const surface = new UiNode(
      message,
      "",
      [],
      "ok",
      "",
      undefined,
      [new UiNode("Dismiss", "", [], "ok", "", undefined, [], [], [], "ui/resolve", { pending: "", kind: "dismiss" })],
      [new UiNode("Dismiss", "", [], "ok", "", "escape", [], [], [], "ui/resolve", { pending: "", kind: "dismiss" })],
      [],
      null,
      {},
    );
    await this.#parkSurface(surface);
  }

  /** Park a surface in the omnibox until one of its `ui/resolve` leaves fires; the draft comes back after. */
  async #parkSurface(surface: UiNode): Promise<Record<string, unknown>> {
    const saved = { ...this.draft };
    this.#savedDraft = saved;
    runInAction(() => {
      this.#callback = { pending: "", surface };
      this.#focus = undefined;
      this.draft = { draft: "", cursor: 0, mark: null };
      this.#resetSelection();
      this.escClearArmed = false;
    });
    try {
      return await new Promise<Record<string, unknown>>((resolve) => {
        this.#resolveWaiter = resolve;
      });
    } finally {
      this.#resolveWaiter = undefined;
      runInAction(() => {
        this.#callback = undefined;
        this.#processing = false;
        Object.assign(this.draft, this.#savedDraft ?? saved);
        this.#savedDraft = undefined;
      });
    }
  }

  /** `/permissions [probe]`: the view, then Enter on a stored row revokes it and the view reloads. */
  async #showPermissions(probe: string): Promise<void> {
    const root = this.client.sessionRoot;
    let explain: PermissionsInput["explain"];
    const parsed = parseProbe(probe);
    for (;;) {
      if (parsed !== null) {
        explain = await this.client.request("policy/explain", { probe: parsed }).then(
          (outcome) => ({ probe, outcome: outcome as ExplainOutcome }),
          (error: unknown) => ({
            probe,
            outcome: null,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      const listing = { sessionId: root.sessionId, projectPath: root.path };
      const rows = async (method: "grant/list" | "ack/list"): Promise<GrantRow[]> =>
        this.client.request(method, listing).then(
          (out) => (out as { rows: GrantRow[] }).rows,
          (error: unknown) => {
            fail(method, error);
            return [];
          },
        );
      const view = permissionsView({
        mode: root.permissionMode,
        layers: layersOf({
          user: root.authorizationUserJson,
          project: root.authorizationProjectJson,
          session: root.authorizationOverlayJson,
        }),
        grants: await rows("grant/list"),
        acks: await rows("ack/list"),
        nowMs: this.#now(),
        ...(explain === undefined ? {} : { explain }),
      });
      const answer = await this.#parkSurface(permissionsSurface(view));
      const picked =
        answer.kind === "revoke" && typeof answer.index === "number" ? view.revocable[answer.index] : undefined;
      if (picked === undefined) return;
      await this.client
        .request(picked.revoke.method, picked.revoke.params)
        .catch((error) => fail(picked.revoke.method, error));
    }
  }

  async #awaitCallback(form: UiForm): Promise<unknown> {
    const values = await exec(form.body, {
      capabilities: COMMAND_CAPABILITIES,
      config: this.#commandConfig({ pending: form.pending }),
    });
    const surface = values.at(-1);
    invariant(surface instanceof UiNode, "ui form body did not eval to a UiNode");
    const saved = this.#savedDraft ?? {
      draft: this.draft.draft,
      cursor: this.draft.cursor,
      mark: this.draft.mark,
    };
    this.#savedDraft = saved;
    runInAction(() => {
      this.#callback = { pending: form.pending, surface };
      this.#processing = false;
      this.#focus = undefined;
      this.draft = { draft: "", cursor: 0, mark: null };
      this.#resetSelection();
      this.escClearArmed = false;
    });
    const answerPromise = new Promise<Record<string, unknown>>((resolve) => {
      this.#resolveWaiter = resolve;
    });
    const url = urlFrom(surface);
    // No field to type in (Nous): the link opens now and Enter means "continue".
    if (url !== undefined && !hasInputHole(surface)) this.#openUrl(url);
    try {
      let answer = await answerPromise;
      step(`oauth resolve keys=${Object.keys(answer).sort().join(",")}`);
      // An empty field on a link park is "open it": the daemon owns the callback and waits for it.
      if (url !== undefined && answer.kind === "text" && answer.input === "") {
        this.#openUrl(url);
        answer = { kind: "opened", url };
      }
      if (answer.kind === "opened") {
        this.#waitingPending = form.pending;
        runInAction(() => {
          this.#oauthWaiting = true;
        });
      }
      return await this.client.request("ui/resolve", { pending: form.pending, ...answer });
    } finally {
      this.#waitingPending = undefined;
      this.#resolveWaiter = undefined;
      runInAction(() => {
        this.#oauthWaiting = false;
        this.#processing = false;
        this.#callback = undefined;
        Object.assign(this.draft, this.#savedDraft ?? saved);
        this.#savedDraft = undefined;
      });
    }
  }

  #openUrl(url: string): void {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = "invalid";
    }
    step(`oauth open ${host}`);
    this.#open(url);
  }

  /** Esc on "Waiting for the browser…": abort the daemon's wait; the `opened` request then settles. */
  #cancelWaiting(): void {
    const pending = this.#waitingPending;
    if (pending === undefined) return;
    this.#waitingPending = undefined;
    this.client.request("ui/resolve", { pending, kind: "cancel" }).catch((error: unknown) => {
      fail("oauth cancel", error);
    });
  }

  #completeCallback(params: Record<string, unknown>): void {
    const waiter = this.#resolveWaiter;
    this.#resolveWaiter = undefined;
    if (params.kind !== "cancel") {
      runInAction(() => {
        this.#processing = true;
      });
    }
    waiter?.(params);
  }

  @computed
  get #activeConnection(): ConnectionSpec | undefined {
    const connectionId = (this.client.sessionRoot.kvs.connection ?? "").trim();
    return connectionId === "" ? undefined : this.client.kernelRoot.connections[connectionId];
  }

  /** Top-right omnibox annotation: failed head, else the selected wire's sticky error. */
  #errorAnnotation(): ComposerErrorAnnotation | undefined {
    const head = this.client.sessionRoot.head;
    if (head instanceof SessionTurn && !isRetrying(head, this.#now())) {
      const chunks = reactChunks(head);
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        const pew = tapeCompletion(chunks[i]);
        if (pew == null || pew.outcome !== "failed") continue;
        if (isCompletionCutoff(pew)) continue;
        const picked = pew.endDetail ?? pew.failReason;
        return { level: "error", message: picked == null ? "turn failed" : picked.trim() };
      }
    }
    const connection = this.#activeConnection;
    if (connection != null) {
      const message = nonempty(connection.error);
      const failed = connection.readyState === "failed";
      const authLine = failed && authStatusLine(message);
      if (authLine) return { level: "error", message: "The key was refused. Reconnect." };
      if (failed && message !== "") return { level: "error", message };
      if (connection.live.auth === "needs-auth") {
        const id = connection.id.trim();
        const who = id === "" ? "connection" : `connection ${id}`;
        return { level: "error", message: `${who} needs auth — reconnect` };
      }
      if (failed) return { level: "error", message: "connection failed" };
    }
    return this.#pluginAnnotation();
  }

  /** The session's plugin behavior problem, else the first installed plugin that failed to load. */
  #pluginAnnotation(): ComposerErrorAnnotation | undefined {
    const session = nonempty(this.client.sessionRoot.pluginProblem);
    if (session !== "") return { level: "warning", message: session };
    for (const plugin of Object.values(this.client.kernelRoot.plugins ?? {})) {
      const problem = plugin.enabled ? nonempty(plugin.problem) : "";
      if (problem !== "") return { level: "warning", message: `${plugin.pluginName}: ${problem}` };
    }
    return undefined;
  }

  /** Persist-mod overlay data. Paint spells remaining from resetAt; Tea does not. */
  @computed({ equals: comparer.structural })
  get #quotaWindows(): readonly ChromeQuotaWindow[] | undefined {
    return quotaWindowsOf(this.#activeConnection);
  }

  /** Bottom-right omnibox chips: model, wire name, then auto / always approve. Manual is blank. */
  @computed({ equals: comparer.structural })
  get #statusItems(): readonly ChromeStatusItem[] | undefined {
    const session = this.client.sessionRoot;
    const kvs = session.kvs;
    const model = (kvs.model ?? "").trim();
    const connectionId = (kvs.connection ?? "").trim();
    const connection = this.#activeConnection;
    const provider =
      nonempty(typeof connection?.live?.catalogName === "string" ? connection.live.catalogName.trim() : "") ||
      nonempty(connection?.name) ||
      nonempty(connection?.driver?.name) ||
      connectionId;
    const items: ChromeStatusItem[] = [];
    if (model !== "") items.push(model);
    if (provider !== "") items.push(provider);
    const chip = policyChip(session);
    if (chip !== null) items.push(chip);
    return items.length > 0 ? items : undefined;
  }

  get #remainder(): string {
    const line = (this.draft.draft.split("\n")[0] ?? "").trim();
    if (this.#callback !== undefined) return line;
    const verb = slashVerb(this.draft.draft);
    if (verb === null) return line;
    return line.slice(verb.length + 1).trim();
  }

  @action
  #stepCoverThrottle(): void {
    const leaf = this.#askHead;
    const pendingLeafId = askLeafId(leaf);
    const now = this.#now();
    if (pendingLeafId === null) {
      if (!this.#askHold && !this.#drainAsk) {
        this.#coverThrottle = { episodeFrom: null, armedUntil: 0 };
      }
      this.#coverConfirmLive = false;
    } else {
      if (this.#coverThrottle.episodeFrom === null) {
        const throttleMs = Math.max(0, this.client.kernelRoot.approvalAskThrottleMs);
        this.#coverThrottle = {
          episodeFrom: pendingLeafId,
          armedUntil: this.draft.draft.trim() !== "" && throttleMs > 0 ? now + throttleMs : 0,
        };
      }
      this.#coverConfirmLive = now >= this.#coverThrottle.armedUntil;
    }
    if (this.#coverTimer !== undefined) {
      clearTimeout(this.#coverTimer);
      this.#coverTimer = undefined;
    }
    if (leaf === null) {
      this.#coverDraft = { draft: "", cursor: 0, mark: null };
      return;
    }
    if (!this.#coverConfirmLive && this.#coverThrottle.armedUntil > this.#now()) {
      const wait = this.#coverThrottle.armedUntil - this.#now();
      this.#coverTimer = setTimeout(() => {
        runInAction(() => this.#stepCoverThrottle());
      }, wait);
    }
  }

  #fireHotkeyEvent(event: string): boolean {
    switch (event) {
      case HOTKEY_EVENT.allow:
        if (this.#processing || this.#oauthWaiting) return true;
        this.#answerAsk(true);
        return true;
      case HOTKEY_EVENT.allowSession:
        if (this.#processing || this.#oauthWaiting) return true;
        this.#answerAsk(true, { remember: "session" });
        return true;
      case HOTKEY_EVENT.allowAlways:
        if (this.#processing || this.#oauthWaiting) return true;
        this.#answerAsk(true, { remember: "project" });
        return true;
      case HOTKEY_EVENT.ackRemember: {
        if (this.#processing || this.#oauthWaiting) return true;
        const choice = this.#ackPrompt?.choices[this.#ackIndex];
        if (choice !== undefined) this.#answerAsk(true, { ackChoice: choice });
        return true;
      }
      case HOTKEY_EVENT.ackNext:
      case HOTKEY_EVENT.ackPrev: {
        const leaf = this.#askHead;
        const size = this.#ackPrompt?.choices.length ?? 0;
        if (leaf == null || size === 0) return true;
        this.#ackPick = {
          id: leaf.uuid,
          index: cycleAck(this.#ackIndex, size, event === HOTKEY_EVENT.ackNext ? 1 : -1),
        };
        return true;
      }
      case HOTKEY_EVENT.allowWiden: {
        if (this.#processing || this.#oauthWaiting) return true;
        const widen = this.#readWiden;
        this.#answerAsk(true, { widen: widen?.path });
        return true;
      }
      case HOTKEY_EVENT.deny:
        if (this.#processing) return true;
        this.#answerAsk(false);
        return true;
      case HOTKEY_EVENT.denySession:
        if (this.#processing) return true;
        this.#answerAsk(false, { persist: "session" });
        return true;
      case HOTKEY_EVENT.denyAlways:
        if (this.#processing) return true;
        this.#answerAsk(false, { persist: "always" });
        return true;
      case HOTKEY_EVENT.retry:
        if (this.#processing || this.#oauthWaiting) return true;
        this.#fire([new UiNode("turn/retry", "", [], "ok", "", undefined, [], [], [], "turn/retry", {})], true);
        return true;
      case HOTKEY_EVENT.queueMessage: {
        if (this.#processing || this.#oauthWaiting) return true;
        if (!this.#submitTurn("queue")) return true;
        return true;
      }
      case HOTKEY_EVENT.steerFirst:
        if (this.#processing || this.#oauthWaiting) return true;
        this.#queueMove("queue/steer-first", this.client.sessionRoot.promptQueue[0]);
        return true;
      case HOTKEY_EVENT.continue: {
        if (this.#processing || this.#oauthWaiting) return true;
        const head = this.client.sessionRoot.head;
        if (head instanceof SessionTurn && head.lastTurnIncomplete && isAtTip(head, this.client.sessionRoot.tip)) {
          this.#fire(
            [
              new UiNode("turn", "", [], "ok", "", undefined, [], [], [], "turn", {
                prompt: "",
                kind: "continue",
              }),
            ],
            true,
          );
        }
        return true;
      }
      case HOTKEY_EVENT.clear:
        Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
        this.escClearArmed = false;
        this.#resetSelection();
        return true;
      case HOTKEY_EVENT.cancelTurn: {
        const running = this.client.sessionRoot.findRunningTurn();
        this.escClearArmed = false;
        this.#drainAsk = false;
        this.#askHold = false;
        if (running != null) this.#requestTurnCancel(running);
        return true;
      }
      default:
        return true;
    }
  }

  /**
   * One human answer. `remember` stores the family the daemon offered for this exact call (an ask;
   * a soft-deny offers none). `widen` says yes to "Treat <folder> as part of this session?".
   * `persist` hides a refused MCP look-up. The daemon checks all three; a refusal here is a no-op.
   */
  #answerAsk(
    allow: boolean,
    opts: {
      readonly remember?: "session" | "project";
      readonly widen?: string;
      readonly persist?: McpPersistScope;
      /** Remember the acknowledgement as this option (the picked scope and subject). */
      readonly ackChoice?: AckChoice;
    } = {},
  ): void {
    const leaf = this.#askHead;
    if (leaf === null || leaf.humanApprove !== null) return;
    const comment = this.#coverDraft.draft.trim();
    const desk = this.client.sessionRoot;
    const ack = this.#ackPrompt;
    let combinedAckStore: { scope: AckScope; subject: GrantSubject } | undefined;
    if (ack !== null) {
      const picked = ack.choices[this.#ackIndex];
      const ackStore =
        !allow || comment !== ""
          ? undefined
          : opts.ackChoice !== undefined
            ? { scope: opts.ackChoice.scope, subject: opts.ackChoice.subject }
            : opts.remember !== undefined && picked !== undefined
              ? { scope: opts.remember, subject: picked.subject }
              : undefined;
      const own = desk.findRunningTurn()?.approvalHead === leaf;
      const sessionId = own ? desk.sessionId : (this.#askPlexus?.root.sessionId ?? desk.sessionId);
      if (ack.variant === "ack") {
        // Allowed by policy; only the acknowledgement is asked.
        void this.client
          .request("ack/answer", {
            sessionId,
            jobId: leaf.uuid,
            ackId: leaf.uuid,
            accept: allow,
            ...(ackStore === undefined ? {} : { store: ackStore }),
            ...(comment === "" ? {} : { comment }),
          })
          .catch((error) => fail("ack/answer", error));
        this.#drainAsk = true;
        this.#askHold = true;
        this.#coverDraft = { draft: "", cursor: 0, mark: null };
        this.#stepCoverThrottle();
        return;
      }
      // A combined prompt: the human yes settles both; remembering the flag rides as `ackStore`.
      combinedAckStore = ackStore;
    }
    // A kernel-wide "never this tool" is a kernel RPC; everything on the session is the daemon's answer.
    if (
      opts.persist === "always" &&
      comment === "" &&
      !allow &&
      leaf instanceof MCPToolJob &&
      mcpReadFloorDenies(leaf.serverToolName)
    )
      this.#persistGlobal(leaf, false);
    const subject = leaf.grantOptions[0]?.subject;
    const store =
      allow && comment === "" && opts.remember !== undefined && subject !== undefined
        ? { scope: opts.remember, subject }
        : undefined;
    const own = desk.findRunningTurn()?.approvalHead === leaf;
    void this.client
      .request("ask/answer", {
        sessionId: own ? desk.sessionId : (this.#askPlexus?.root.sessionId ?? desk.sessionId),
        jobId: leaf.uuid,
        allow,
        ...(comment === "" ? {} : { comment }),
        ...(opts.widen === undefined || opts.widen === "" ? {} : { widen: opts.widen }),
        ...(store === undefined ? {} : { store }),
        ...(combinedAckStore === undefined ? {} : { ackStore: combinedAckStore }),
        ...(opts.persist === undefined || allow ? {} : { persist: opts.persist }),
      })
      .catch((error) => fail("ask/answer", error));
    this.#drainAsk = true;
    this.#askHold = true;
    this.#coverDraft = { draft: "", cursor: 0, mark: null };
    this.#stepCoverThrottle();
  }

  #setResident(resident: boolean): Promise<unknown> {
    return this.client.request("resident/set", { resident }).catch((error) => fail("resident/set", error));
  }

  /** The daemon moves the row; a local shift would merge with its turn-close drain. */
  #queueMove(op: "queue/steer-first" | "queue/retract-last", row: { readonly uuid: string } | undefined): void {
    if (row == null) return;
    this.#fire([new UiNode(op, "", [], "ok", "", undefined, [], [], [], op, { id: row.uuid })]);
  }

  /** Paint the cancel before the daemon stamps it; the turn's flag stays the daemon's to write. */
  #askCancel(turn: SessionTurn): void {
    runInAction(() => this.#cancelAsked.add(turn));
    this.#disposers.push(
      when(
        () => turn.cutOff || !turn.inLoop,
        () => runInAction(() => this.#cancelAsked.delete(turn)),
      ),
    );
  }

  #requestTurnCancel(turn: SessionTurn): void {
    this.#askCancel(turn);
    this.#rewindGraceUntil = this.#now() + REWIND_GRACE_MS;
    this.#fire(
      [
        new UiNode("turn/cancel", "", [], "ok", "", undefined, [], [], [], "turn/cancel", {
          turnId: turn.uuid,
        }),
      ],
      true,
    );
  }

  #handleEscapeUnwind(seat: OmniboxSeat): boolean {
    if (this.#oauthWaiting) {
      this.#cancelWaiting();
      return true;
    }
    if (this.#processing) return true;
    if (seat.input === "overlay" || seat.input === "auth" || this.#callback !== undefined) {
      this.#completeCallback({ kind: "cancel" });
      return true;
    }
    if (this.#focus !== undefined) {
      this.#focus = undefined;
      this.#resetSelection();
      this.escClearArmed = false;
      return true;
    }
    if (this.draft.draft.length > 0 && !this.#historyNav) {
      if (this.escClearArmed) {
        Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
        this.escClearArmed = false;
        this.#resetSelection();
      } else {
        this.escClearArmed = true;
      }
      return true;
    }
    // see omnibox-seat.ts, CHANGE ONLY.
    if (this.client.sessionRoot.promptQueue.length > 0 && !this.#drainAsk && !this.#askHold) {
      this.#queueMove("queue/retract-last", this.client.sessionRoot.promptQueue.at(-1));
      this.escClearArmed = false;
      return true;
    }
    const running = this.client.sessionRoot.findRunningTurn();
    if (running != null) {
      if (this.escClearArmed) {
        this.escClearArmed = false;
        this.#drainAsk = false;
        this.#askHold = false;
        this.#requestTurnCancel(running);
      } else {
        this.escClearArmed = true;
      }
      return true;
    }
    if (this.#historyNav) {
      this.#leaveHistory();
      this.escClearArmed = false;
      return true;
    }
    if (this.#rewindGraceActive()) {
      this.escClearArmed = false;
      return true;
    }
    if (this.#viewTurn() == null) {
      this.escClearArmed = false;
      return true;
    }
    if (this.escClearArmed) {
      this.escClearArmed = false;
      this.#enterHistory();
    } else {
      this.escClearArmed = true;
    }
    return true;
  }

  #rewindGraceActive(): boolean {
    if (this.client.sessionRoot.findRunningTurn() != null) return false;
    return this.#now() < this.#rewindGraceUntil;
  }

  #handleRewindArrows(
    event: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean },
    chord: boolean,
  ): boolean {
    if (this.#callback !== undefined) return false;
    if (chord || event.shift === true) return false;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    if (!this.#browsing()) return false;
    if (this.client.sessionRoot.findRunningTurn() != null) return false;
    const view = this.#viewTurn();
    const target = event.key === "ArrowUp" ? previousPin(view) : view ? (this.#aheadOf(view)[0] ?? null) : null;
    if (target != null) this.#moveView(target);
    return true;
  }

  #hostRewind(): void {
    if (this.#remainder.trim() !== "") {
      void this.#showNotice("usage: /rewind");
      return;
    }
    const pin = previousPin(this.#viewTurn());
    if (pin == null) {
      void this.#showNotice("nothing to rewind");
      return;
    }
    Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
    this.#resetSelection();
    this.#moveView(pin);
  }

  #confirmHistory(): void {
    if (this.#rewindPending) return;
    const target = this.#viewTurn();
    if (target == null) return;
    if (target.visuals.length > 0) {
      void this.#showNotice("pictures on this turn can be edited in the web or mobile app");
      return;
    }
    const head = this.client.sessionRoot.head;
    const tip = resolvedTip(head, this.client.sessionRoot.tip);
    // The selected message is what the operator is about to resend, so it
    // leaves the tape. Head lands on the previous user message. The immediate
    // tail is often a promptless continue or compact, and the daemon refuses
    // those (`not-a-pin`). Nothing before the first message is a prefill.
    const before = previousPin(target);
    const ceiling = target === head && isAtTip(head, tip);
    if (before == null || (ceiling && target.prompt.trim() === "")) {
      // First message, or a promptless ceiling: there is no pin to cut to.
      // Prefilling "" and closing navigation lets the same Enter fall through
      // into `kind: "continue"`. A real first-message prompt is the resend.
      const prefill = ceiling && target.prompt.trim() === "" ? "" : target.prompt;
      this.#restoredDraft = prefill === "" ? null : { turnId: target.uuid, prompt: prefill };
      Object.assign(this.draft, { draft: prefill, cursor: prefill.length, mark: null });
      this.#resetSelection();
      this.#leaveHistory();
      return;
    }
    void this.#requestRewind(before.uuid, target.prompt);
  }

  async #requestRewind(turnId: string, draft: string): Promise<void> {
    if (this.#rewindPending) return;
    this.#rewindPending = true;
    try {
      const result = await this.client.request("turn/rewind", { turnId });
      if (
        typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        (result as { ok?: unknown }).ok === false
      ) {
        await this.#showNotice("nothing to rewind");
        return;
      }
      runInAction(() => {
        this.#restoredDraft = draft === "" ? null : { turnId, prompt: draft };
        Object.assign(this.draft, { draft, cursor: draft.length, mark: null });
        this.#resetSelection();
        this.#leaveHistory();
      });
    } catch (error) {
      await this.#showNotice(error instanceof Error ? error.message : String(error));
    } finally {
      this.#rewindPending = false;
    }
  }

  #hostNew(): void {
    const remainder = this.#remainder;
    const path = this.client.sessionRoot.path;
    // The turn is shared. Cancel only when this window is the last seat —
    // another open window is still watching the loop.
    const running =
      otherSessionSeatCount(this.client.kernelPlexus.awareness, this.client.sessionId) === 0
        ? this.client.sessionRoot.findRunningTurn()
        : null;
    Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
    this.#resetSelection();
    if (this.#replaceSession === undefined) return;
    const fire = (): void => {
      this.#replaceSession?.({ path, ...(remainder === "" ? {} : { draft: remainder }) });
    };
    if (running == null) {
      fire();
      return;
    }
    this.#processing = true;
    this.#askCancel(running);
    void this.client
      .request("turn/cancel", { turnId: running.uuid })
      .catch((error) => fail("turn/cancel", error))
      .finally(() => {
        this.#processing = false;
        fire();
      });
  }

  #persistGlobal(leaf: MCPToolJob, allow: boolean): void {
    const method = allow ? "connect/always-allow" : "connect/exclude-tool";
    void this.client.request(method, { id: leaf.connectionKey, tool: leaf.serverToolName }).catch((error) => {
      fail(method, error);
    });
  }

  #handleHotkey(event: { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }): boolean {
    const seat = this.#omnibox;
    const rows = this.#pickerRows;
    const i = this.#selectedIndex;
    const selected = rows?.[i];
    const chord = event.ctrl === true || event.meta === true || event.alt === true;
    if (this.#handleAgentsChord(event, seat)) return true;
    if (event.key === "Tab" && event.shift === true && !chord) {
      const ids = PERMISSION_MODES;
      const current = this.#askedPolicy ?? this.client.sessionRoot.permissionMode;
      const next = ids[(ids.indexOf(current) + 1) % ids.length]!;
      // The daemon writes the mode; cycle from what was asked until the replica shows it.
      this.#askedPolicy = next;
      void this.client
        .request("policy/set", { policy: next })
        .catch((error) => {
          fail("policy/set", error);
        })
        .finally(() => {
          if (this.#askedPolicy === next) this.#askedPolicy = null;
        });
      return true;
    }
    if (
      this.#browsing() &&
      this.#callback === undefined &&
      !chord &&
      event.shift !== true &&
      (event.key === "Enter" || event.key === "Escape")
    ) {
      if (event.key === "Escape") {
        if (!this.#rewindPending) this.#leaveHistory();
        return true;
      }
      this.#confirmHistory();
      return true;
    }
    if (this.#historyHidesOmnibox && !chord && event.shift !== true && this.#handleRewindArrows(event, chord))
      return true;
    if (event.key === "Escape" && !chord) {
      const target = this.#askIsolated ? this.#coverDraft : this.draft;
      if (target.mark !== null && target.mark !== target.cursor) {
        Object.assign(target, { draft: target.draft, cursor: target.cursor, mark: null });
        return true;
      }
    }
    const painted = this.#paintComposerFace().hotkeys;
    const hit = painted?.find((hotkey) => hotkey.event !== undefined && eventMatchesChord(event, hotkey.key));
    if (hit?.event !== undefined) {
      if (seat.askChords === "inert") return true;
      // see omnibox-seat.ts, CHANGE ONLY.
      if ((this.#drainAsk || this.#askHold) && seat.askChords === "off" && event.key === "Enter") {
        return true;
      }
      return this.#fireHotkeyEvent(hit.event);
    }
    if (seat.askChords !== "off" && (event.key === "Enter" || event.key === "Escape")) {
      return true;
    }
    if ((this.#drainAsk || this.#askHold) && event.key === "Enter") {
      return true;
    }
    if (seat.input === "ask") return false;
    if (event.key === "Enter" && !chord && event.shift !== true) {
      if (this.#processing || this.#oauthWaiting) return true;
      if (selected !== undefined) {
        this.#pick(selected, true);
        return true;
      }
      if (seat.input === "overlay" || this.#callback !== undefined) {
        this.#fire(this.#parentNode?.action, true);
        return true;
      }
      if (this.#historyNav) {
        this.#confirmHistory();
        return true;
      }
      const verb = slashVerb(this.draft.draft);
      if (verb === "compact") {
        const focus = this.#remainder;
        this.#fire(
          [new UiNode("compact", "", [], "ok", "", undefined, [], [], [], "compact", focus === "" ? {} : { focus })],
          true,
        );
        return true;
      }
      if (verb === "rename") {
        const rest = this.#remainder;
        this.#fire(
          [
            new UiNode("rename", "", [], "ok", "", undefined, [], [], [], "rename", {
              title: rest === "--auto" ? "" : rest,
            }),
          ],
          true,
        );
        return true;
      }
      if (verb !== null && isHostVerb(verb) && verb !== "compact" && verb !== "rename") {
        this.#invokeHostVerb(verb);
        return true;
      }
      if (verb !== null && this.#skillVerb(verb)) {
        this.#submitTurn(seat.input === "queue" ? "queue" : undefined);
        return true;
      }
      if (seat.input === "slash" || verb !== null) {
        this.#fire(this.#parentNode?.action, true);
        return true;
      }
      if (seat.input === "queue") {
        if (this.#submitTurn("queue")) return true;
        this.#queueMove("queue/steer-first", this.client.sessionRoot.promptQueue[0]);
        return true;
      }
      if (this.#submitTurn()) return true;
      const head = this.client.sessionRoot.head;
      if (!isAtTip(head, this.client.sessionRoot.tip)) return true;
      if (head instanceof SessionTurn && head.lastTurnIncomplete) {
        this.#fire(
          [
            new UiNode("turn", "", [], "ok", "", undefined, [], [], [], "turn", {
              prompt: "",
              kind: "continue",
            }),
          ],
          true,
        );
        return true;
      }
      this.#fire(this.#parentNode?.action, true);
      return true;
    }
    if (event.key === "Escape" && !chord) {
      return this.#handleEscapeUnwind(seat);
    }
    if (rows !== undefined && rows.length > 0 && selected !== undefined && !chord && event.shift !== true) {
      if (event.key === "ArrowUp") {
        this.focusAt(i - 1);
        return true;
      }
      if (event.key === "ArrowDown") {
        this.focusAt(i + 1);
        return true;
      }
      if (event.key === "Tab") {
        this.#pick(selected, false);
        return true;
      }
    }
    if (this.#handleRewindArrows(event, chord)) return true;
    const alt =
      selected?.alternateActions.find((item) => eventMatchesChord(event, item.hotkey ?? "")) ??
      this.#parentNode?.alternateActions.find((item) => eventMatchesChord(event, item.hotkey ?? ""));
    if (alt !== undefined) {
      this.#fire([alt]);
      return true;
    }
    return false;
  }

  #pick(node: UiNode, invoke: boolean): void {
    if (this.#atCatalog || node.choices.length > 0) {
      if (invoke && this.#atCatalog) {
        const verb = node.name.replace(/^\//, "");
        if (isHostVerb(verb) && verb !== "compact" && verb !== "rename") {
          this.#completeName(node);
          this.#resetSelection();
          this.#invokeHostVerb(verb);
          return;
        }
      }
      if (!this.#atCatalog) this.#focus = node;
      this.#completeName(node);
      this.#resetSelection();
      return;
    }
    this.#completeName(node);
    if (invoke && node.action.length > 0) this.#fire(node.action, true);
  }

  /** Catalog Enter on a host verb that has no CommandSpec body. */
  #invokeHostVerb(verb: (typeof HOST_VERBS)[number]): void {
    if (verb === "quit") {
      Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
      this.#resetSelection();
      this.#quit?.();
      return;
    }
    if (verb === "new") {
      this.#hostNew();
      return;
    }
    if (verb === "agentic") {
      const rest = this.#remainder.trim().toLowerCase();
      const flag = rest === "true" ? true : rest === "false" ? false : null;
      if (flag === null) return;
      void this.#setResident(flag);
      Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
      this.#resetSelection();
      return;
    }
    if (verb === "background") {
      Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
      this.#resetSelection();
      // Leave only after the daemon holds the bit; a replica write could die with this process.
      void this.#setResident(true).finally(() => this.#quit?.());
      return;
    }
    if (verb === "rewind" || verb === "undo") {
      this.#hostRewind();
      return;
    }
    if (verb === "permissions") {
      if (this.#callback !== undefined) return;
      const probe = this.#remainder.trim();
      Object.assign(this.draft, { draft: "", cursor: 0, mark: null });
      this.#resetSelection();
      void this.#showPermissions(probe);
    }
  }

  #completeName(node: UiNode): void {
    if (this.#atCatalog) {
      const draft = this.draft.draft;
      const nl = draft.indexOf("\n");
      const first = nl === -1 ? draft : draft.slice(0, nl);
      const rest = nl === -1 ? "" : draft.slice(nl);
      const lead = first.match(/^\s*/)?.[0] ?? "";
      const after = first.slice(lead.length);
      if (!after.startsWith("/")) {
        Object.assign(this.draft, { draft, cursor: draft.length, mark: null });
        return;
      }
      const sp = after.search(/\s/);
      const args = sp < 0 ? " " : after.slice(sp);
      const verb = node.name.replace(/^\//, "");
      const nextFirst = `${lead}/${verb}${args}`;
      Object.assign(this.draft, {
        draft: `${nextFirst}${rest}`,
        cursor: nextFirst.length,
        mark: null,
      });
      return;
    }
    const verb = slashVerb(this.draft.draft);
    if (verb === null) return;
    const draft = this.draft.draft;
    const nl = draft.indexOf("\n");
    const rest = nl === -1 ? "" : draft.slice(nl);
    const lead = (nl === -1 ? draft : draft.slice(0, nl)).match(/^\s*/)?.[0] ?? "";
    const nextFirst = `${lead}/${verb} ${node.name}`;
    Object.assign(this.draft, {
      draft: `${nextFirst}${rest}`,
      cursor: nextFirst.length,
      mark: null,
    });
  }

  /**
   * What the open picker looks at: the connections it lists, and the drivers
   * whose adopt doors it lists (so a driver can keep its offers fresh).
   */
  @computed
  get #attentionSubjects(): readonly (ConnectionSpec | DriverSpec)[] {
    const rows = this.#pickerRows;
    if (rows === undefined) return [];
    const { connections, drivers } = this.client.kernelRoot;
    const out = new Set<ConnectionSpec | DriverSpec>();
    for (const node of rows) {
      for (const leaf of node.action) {
        const spec =
          leaf.op === "kv/set" && leaf.params.key === "connection"
            ? connections[paramString(leaf.params.value)]
            : leaf.op === "connect/adopt"
              ? drivers[paramString(leaf.params.driver)]
              : undefined;
        if (spec === undefined) continue;
        out.add(spec);
        break;
      }
    }
    return [...out];
  }

  [Symbol.dispose](): void {
    if (this.#coverTimer !== undefined) {
      clearTimeout(this.#coverTimer);
      this.#coverTimer = undefined;
    }
    this.client.releasePeek();
    this.client.releaseAsk();
    this.client.setComputedAttention(() => []);
    this.client.setComputedAttentionFocus(() => null);
    this.#cancelWaiting();
    this.#completeCallback({ kind: "cancel" });
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.#paint[Symbol.dispose]();
  }
}

function primaryDisplayName(node: UiNode): string | undefined {
  const first = node.action[0];
  if (first === undefined) return undefined;
  const label = first.name.trim();
  if (label !== "" && label !== (first.op ?? "")) return label;
  return "select";
}

function isActivatable(node: UiNode, catalog: boolean): boolean {
  return catalog || node.choices.length > 0 || node.action.length > 0;
}

function pickerActions(node: UiNode, catalog = false): ComposerCommandAction[] {
  const first = node.action[0];
  const head: ComposerCommandAction[] = isActivatable(node, catalog)
    ? [
        {
          name: first?.op ?? first?.name ?? node.name,
          displayName: primaryDisplayName(node) ?? "select",
          hotkey: "Enter",
        },
      ]
    : [];
  const alts = node.alternateActions.map((alt) => ({
    name: alt.op ?? alt.name,
    displayName: alt.name,
    hotkey: alt.hotkey,
  }));
  return [...head, ...alts];
}

function urlFrom(node: UiNode): string | undefined {
  for (const item of [node, ...node.action, ...node.alternateActions]) {
    const url = item.params.url;
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) return url.trim();
  }
  return undefined;
}

/** `{ ok: false, error }` is how a host verb such as `plugin/method` refuses without throwing. */
function refusalOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const record = result as { ok?: unknown; error?: unknown };
  return record.ok === false && typeof record.error === "string" ? record.error : undefined;
}

/** A scheme-built param is a bare string, a boxed `{ __string__ }`, or a spec with an `id`. */
function paramString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const rec = value as { __string__?: unknown; id?: unknown };
  if (typeof rec.__string__ === "string") return rec.__string__;
  return typeof rec.id === "string" ? rec.id : "";
}

function fillParams(params: Record<string, unknown>, remainder: string): Record<string, unknown> {
  if (remainder === "") return params;
  let next = params;
  if (Object.prototype.hasOwnProperty.call(params, "input") && (params.input === undefined || params.input === "")) {
    next = { ...next, input: remainder };
  }
  if (Object.prototype.hasOwnProperty.call(params, "value") && params.value === "") {
    next = { ...next, value: remainder };
  }
  return next;
}

function hasInputHole(node: UiNode): boolean {
  const walk = [node, ...node.action, ...node.alternateActions, ...node.choices];
  return walk.some(
    (item) =>
      item.op != null &&
      Object.prototype.hasOwnProperty.call(item.params, "input") &&
      (item.params.input === undefined || item.params.input === ""),
  );
}

/** Text parts join in order. Picture bytes are standard base64 beside the prompt. */
function promptFromParts(parts: readonly SubmitPart[]): {
  readonly text: string;
  readonly visuals: readonly { readonly mime: string; readonly bytesBase64: string }[];
} {
  const visuals: { mime: string; bytesBase64: string }[] = [];
  let text = "";
  for (const part of parts) {
    const image = part.image;
    if (image !== undefined) {
      visuals.push({ mime: image.mime, bytesBase64: Buffer.from(image.bytes).toString("base64") });
    }
    if (typeof part.text === "string") text += part.text;
  }
  return { text, visuals };
}

function jsonParams(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  try {
    return JSON.parse(
      JSON.stringify(params, (_key, value: unknown) => {
        if (typeof value === "boolean") return value;
        if (typeof value !== "object" || value === null) return value;
        const rec = value as { __string__?: unknown; __boolean__?: unknown; id?: unknown; name?: unknown };
        if (typeof rec.__boolean__ === "boolean") return rec.__boolean__;
        if (typeof rec.__string__ === "string") return rec.__string__;
        if (typeof rec.id === "string" && rec.id.length > 0 && "configuration" in rec) return rec.id;
        if (typeof rec.name === "string" && "importPath" in rec) return rec.name;
        return value;
      }),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nonempty(value: string | null | undefined): string {
  return (value ?? "").trim();
}

/** 401 or 403 as a status, not a digit inside a longer number. Same test as connect.scm `auth-line?`. */
function authStatusLine(line: string): boolean {
  return /(?:^|\D)40[13](?:\D|$)/.test(line);
}

function askStack(
  leaf: ApprovableJob,
  rows: number,
  bots: Readonly<Record<string, { readonly description?: string }>> = {},
): {
  stackedBody?: string;
  stackedViewport?: number;
  stackedLang?: string;
} {
  if (leaf instanceof CallJob || leaf instanceof AgentMessageJob) {
    const description = agentRecipeDescription(bots, agentSpecKey(leaf));
    let body = nonempty(agentAskStackedBody(agentCoverPrompt(leaf), description));
    if (body === "" && leaf instanceof CallJob) {
      const args = { ...(leaf.args ?? {}) };
      delete args.spec;
      body = nonempty(formatMcpArgs(args));
    }
    if (body === "") return {};
    return { stackedBody: body, stackedViewport: mcpConfirmViewport(rows) };
  }
  if (leaf instanceof MCPToolJob) {
    const body = nonempty(formatMcpArgs(leaf.args));
    if (body === "") return {};
    return { stackedBody: body, stackedViewport: mcpConfirmViewport(rows) };
  }
  const command = shellAskCommand(leaf);
  if (command === undefined) return {};
  return {
    stackedBody: command,
    stackedViewport: mcpConfirmViewport(rows),
    stackedLang: "bash",
  };
}

function policyChip(session: { permissionMode: PermissionMode }): ChromeStatusItem | null {
  if (session.permissionMode === "yolo") return { text: "always approve", role: "attention" };
  if (session.permissionMode !== "auto") return null;
  return { text: "auto", role: "auto" };
}

/**
 * The line over an approval: what kind of question this is and why the floor asked, the judge's
 * reason when it weighed in, what the call is, and the folder question when one is suggested.
 */
export function askAnnotation(
  leaf: ApprovableJob,
  asked: string | undefined,
  widen: { readonly label: string } | undefined,
  ack?: AckPromptModel,
): string | undefined {
  // An allowed call that only waits for an acknowledgement is not an ask: its own header leads.
  if (ack?.variant === "ack") {
    return [ackAnnotation(ack), asked].filter((part): part is string => part !== undefined && part !== "").join(" · ");
  }
  const tier = leaf.policyResult === "deny" ? "Soft-deny" : "Ask";
  const why = leaf.policyClasses.map((id) => CLASSES[id].label).join(", ");
  const parts = [
    why === "" ? tier : `${tier} · ${why}`,
    leaf.policyResult === "deny" ? "licensed every time, nothing is remembered" : undefined,
    leaf.classifierResult !== null && leaf.judgeReason ? `Judge: ${leaf.judgeReason}` : undefined,
    ack === undefined ? undefined : ackAnnotation(ack),
    asked,
    widen === undefined ? undefined : `Treat ${widen.label} as part of this session?`,
  ].filter((part): part is string => part !== undefined && part !== "");
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function catalogContextLimit(connection: ConnectionSpec | undefined, model: string | undefined): number {
  const windows = connection?.live?.windows;
  if (typeof windows !== "object" || windows === null) return 0;
  const id = (model ?? "").trim();
  const raw = id === "" ? undefined : (windows as Record<string, unknown>)[id];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function quotaWindowsOf(connection: ConnectionSpec | undefined): ChromeQuotaWindow[] | undefined {
  const account = connection?.live?.account;
  if (typeof account !== "object" || account === null) return undefined;
  const detail = (account as { balanceDetail?: unknown }).balanceDetail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const rows = (detail as { windows?: unknown }).windows;
  if (!Array.isArray(rows)) return undefined;
  const out: ChromeQuotaWindow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as { remainingPercent?: unknown; resetAt?: unknown };
    const remaining = numberOf(rec.remainingPercent);
    if (remaining === undefined) continue;
    const remainingPercent = Math.round(Math.min(100, Math.max(0, remaining)));
    const resetAtRaw = numberOf(rec.resetAt);
    const resetAt = resetAtRaw === undefined ? undefined : Math.trunc(resetAtRaw);
    out.push(resetAt === undefined ? { remainingPercent } : { remainingPercent, resetAt });
  }
  return out.length > 0 ? out : undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

function askLeafId(leaf: ApprovableJob | null): string | null {
  if (leaf === null) return null;
  if (leaf instanceof ToolCallJob && leaf.toolCallId !== "") return leaf.toolCallId;
  if (leaf instanceof ToolCallJob && leaf.name !== "") return leaf.name;
  return "ask";
}

function agentTapeGlance(
  job: CallJob,
  kernel: KernelRoot,
  parentModel: string | undefined,
): { readonly status: string; readonly model: string } {
  const id = job.workerSessionId.trim();
  const glance = id === "" ? undefined : kernel.sessions[id];
  const recap = (glance?.status ?? "").replaceAll(/\s+/g, " ").trim();
  const live = !job.completed || glance?.midMotion === true;
  const status = recap === "" ? (glance?.asking === true ? "blocked" : live ? "active" : "") : recap;
  const model = (glance?.model.trim() || parentModel?.trim() || "").trim();
  return { status, model };
}

function tapeSpine(head: SessionUnit | null): SessionTurn[] {
  const spine: SessionTurn[] = [];
  const seen = new Set<SessionUnit>();
  let cell = head;
  while (cell !== null && !seen.has(cell)) {
    seen.add(cell);
    if (cell instanceof SessionTurn) spine.push(cell);
    cell = cell.turnTail;
  }
  spine.reverse();
  return spine;
}

function slashVerb(draft: string): string | null {
  const token = (draft.split("\n")[0] ?? "").trim().split(/\s/)[0] ?? "";
  if (!token.startsWith("/") || token.length < 2) return null;
  return token.slice(1);
}

function isRetrying(turn: SessionTurn | null, now: number): boolean {
  if (turn == null) return false;
  const chunks = reactChunks(turn);
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const pew = tapeCompletion(chunks[i]);
    if (pew == null) continue;
    if (pew.outcome != null) return false;
    const retryUntilMs = pew.report?.retryUntilMs;
    return typeof retryUntilMs === "number" && retryUntilMs > now;
  }
  return false;
}
