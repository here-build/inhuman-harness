/**
 * Catalog as a retained paint source — same bind/snapshot seam as the
 * product TUI. The shell tree IS the frame (no assemblePaintFrame column).
 *
 * Facts are observable. `snapshot` is a `@computed` — cadence reads it;
 * the aesthetic timer does not rebuild. Clock and shader I/O are actions
 * / reactions, never inside the computed.
 *
 * No MST. No harness imports. Input lands as BoxBusUpMessage from cadence.
 */
import { action, computed, observable, reaction } from "mobx";

import { filterCatalog } from "./catalog.js";
import { buildShell } from "./shell.js";
import { SHADOW_STREAM_SCRIPT_LEN } from "./stories/shadow-stream.js";
import { activateShadertoy } from "../internals/bgfx/index.js";
import { collectProgressSites } from "../layout/index.js";
import {
  collectBirthSites,
  EMPTY_PREPARED_COMPOSER,
  type BoxBusUpMessage,
  type DecodedKeyEvent,
  type PaintLocal,
  type PaintSink,
  type PreparedPaint,
  type RetainedPaintSource,
} from "../runtime/index.js";
import { expandWidgetPriors } from "../widgets/index.js";

export type CatalogFocus = "list" | "demo";

export type CatalogState = {
  filter: string;
  selected: number;
  focus: CatalogFocus;
  sample: number;
  filtering: boolean;
  filterBuf: string;
};

/** ~180ms/word. Hold full stream, then soft-restart. */
export const INK_MS_PER_WORD = 180;
/** Hold full stream before demo restart (ms). */
export const INK_HOLD_MS = 4000;

export function createCatalogStore(): CatalogState {
  return observable({
    filter: "",
    selected: 0,
    focus: "list" as CatalogFocus,
    sample: 0,
    filtering: false,
    filterBuf: "",
  });
}

/**
 * Content-clock ink phase — grow words, hold, restart.
 * Rejected: bare `% 40` sawtooth (wiped T→0 every 7.2s and hard-reset M).
 */
export function inkPhase(scriptLen: number, nowMs: number = Date.now()): { tick: number; restarted: boolean } {
  const grow = scriptLen;
  const holdTicks = Math.ceil(INK_HOLD_MS / INK_MS_PER_WORD);
  const cycle = grow + 1 + holdTicks;
  const raw = Math.floor(nowMs / INK_MS_PER_WORD);
  const phase = raw % cycle;
  const tick = Math.min(phase, grow);
  const prevPhase = (raw - 1 + cycle) % cycle;
  const restarted = phase === 0 && prevPhase === cycle - 1 && raw > 0;
  return { tick, restarted };
}

export type CatalogHandleOpts = {
  readonly onQuit: () => void;
};

export type CatalogController = RetainedPaintSource & {
  readonly store: CatalogState;
  handle(message: BoxBusUpMessage, opts: CatalogHandleOpts): void;
};

export class CatalogSource implements CatalogController {
  readonly store: CatalogState;
  @observable.ref accessor #local: PaintLocal | null = null;
  /** Ink frontier. Written by the one-shot timer action — not Date.now(). */
  @observable accessor #inkTick = 0;
  #sink: PaintSink | null = null;
  #inkTimer: ReturnType<typeof setTimeout> | null = null;
  #stops: Array<() => void> = [];

  constructor(store: CatalogState = createCatalogStore()) {
    this.store = store;
  }

  @computed
  get #stories() {
    return filterCatalog(this.store.filter);
  }

  @computed
  get #entry() {
    const stories = this.#stories;
    const n = stories.length;
    if (n === 0) return undefined;
    const selected = Math.min(Math.max(0, this.store.selected), n - 1);
    return stories[selected];
  }

  @computed
  get snapshot(): PreparedPaint {
    const local = this.#local;
    const cols = local?.cols ?? 80;
    const rows = local?.rows ?? 24;
    const store = this.store;
    const filter = store.filtering ? store.filterBuf : store.filter;
    const stories = this.#stories;
    const n = stories.length;
    const selected = n === 0 ? 0 : Math.min(Math.max(0, store.selected), n - 1);
    const entry = stories[selected];
    const tick = entry?.liveBirth ? this.#inkTick : 0;
    const tree = buildShell({
      cols,
      rows,
      filter,
      selected,
      focus: store.focus,
      tick,
      sample: store.sample,
      stories,
    });
    const expanded = expandWidgetPriors(tree, { width: cols });
    return {
      root: expanded,
      composer: { ...EMPTY_PREPARED_COMPOSER, interactive: false },
      birthSites: collectBirthSites(expanded),
      progressSites: collectProgressSites(expanded),
      picker: null,
      contentIdentity: [
        cols,
        rows,
        store.filter,
        selected,
        store.focus,
        store.sample,
        store.filtering ? store.filterBuf : "",
      ].join("|"),
    };
  }

  prepare(): PreparedPaint {
    return this.snapshot;
  }

  bind(nextSink: PaintSink, nextLocal: PaintLocal): Disposable {
    this.#disposeStops();
    this.#sink = nextSink;
    this.#local = nextLocal;
    this.#stops.push(
      reaction(
        () => this.snapshot,
        () => this.#sink?.requestPaint(),
        { fireImmediately: true },
      ),
    );
    this.#stops.push(
      reaction(
        () => this.#entry?.fxId,
        (id) => {
          if (!id) return;
          void activateShadertoy(id).then((changed) => {
            if (!changed) return;
            return this.#sink?.requestPaint();
          });
        },
        { fireImmediately: true },
      ),
    );
    this.#stops.push(
      reaction(
        () => this.#entry?.liveBirth === true,
        (live) => this.#armInk(live),
        { fireImmediately: true },
      ),
    );
    return {
      [Symbol.dispose]: () => {
        this.#disposeStops();
        this.#sink = null;
        this.#local = null;
      },
    };
  }

  @action
  handle(message: BoxBusUpMessage, opts: CatalogHandleOpts): void {
    switch (message.kind) {
      case "input_events":
        for (const event of message.events) {
          this.#applyKey(event, opts);
        }
        break;
      case "activate":
      case "picker_activate":
        this.#activateStory(message.key);
        break;
      case "resize":
      case "picker_scroll":
      case "agents_scroll":
      case "agents_focus":
      case "agents_hover":
      case "submit":
        break;
    }
  }

  #applyKey(event: DecodedKeyEvent, opts: CatalogHandleOpts): void {
    const store = this.store;
    if (store.filtering) {
      if (event.key === "Enter") {
        store.filter = store.filterBuf;
        store.filtering = false;
        store.selected = 0;
        return;
      }
      if (event.key === "Escape") {
        store.filtering = false;
        store.filterBuf = store.filter;
        return;
      }
      if (event.key === "Backspace") {
        store.filterBuf = store.filterBuf.slice(0, -1);
        return;
      }
      if (event.key.length === 1 && event.key >= " " && !event.ctrl && !event.meta && !event.alt) {
        store.filterBuf += event.key;
        return;
      }
      return;
    }

    if (event.key === "q" && !event.ctrl && !event.meta && !event.alt) {
      opts.onQuit();
      return;
    }
    if (event.key === "/") {
      store.filtering = true;
      store.filterBuf = store.filter;
      store.focus = "list";
      return;
    }
    if (event.key === "Tab") {
      store.focus = store.focus === "list" ? "demo" : "list";
      return;
    }
    if (event.key === "Escape") {
      store.focus = "list";
      return;
    }
    if (store.focus === "list") {
      if (event.key === "j" || event.key === "ArrowDown") {
        const n = filterCatalog(store.filter).length;
        if (n === 0) return;
        store.selected = Math.min(n - 1, store.selected + 1);
        return;
      }
      if (event.key === "k" || event.key === "ArrowUp") {
        store.selected = Math.max(0, store.selected - 1);
        return;
      }
    }
    if (event.key === "ArrowRight") {
      store.sample += 1;
      return;
    }
    if (event.key === "ArrowLeft") {
      store.sample = Math.max(0, store.sample - 1);
    }
  }

  #activateStory(key: string): void {
    if (!key.startsWith("s-")) return;
    const id = key.slice(2);
    const stories = filterCatalog(this.store.filter);
    const idx = stories.findIndex((s) => s.id === id);
    if (idx === -1) return;
    this.store.selected = idx;
    this.store.focus = "list";
  }

  @action
  #stepInk(): void {
    if (this.#entry?.liveBirth !== true) {
      this.#armInk(false);
      return;
    }
    this.#inkTick = inkPhase(SHADOW_STREAM_SCRIPT_LEN).tick;
    this.#armInk(true);
  }

  #armInk(liveBirth: boolean): void {
    if (this.#inkTimer !== null) {
      clearTimeout(this.#inkTimer);
      this.#inkTimer = null;
    }
    if (!liveBirth || this.#sink === null) return;
    this.#inkTimer = setTimeout(() => this.#stepInk(), INK_MS_PER_WORD);
  }

  #disposeStops(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    if (this.#inkTimer !== null) {
      clearTimeout(this.#inkTimer);
      this.#inkTimer = null;
    }
  }
}

export function createCatalogController(store: CatalogState = createCatalogStore()): CatalogController {
  return new CatalogSource(store);
}
