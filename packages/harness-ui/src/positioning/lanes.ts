import { useLayoutEffect, type RefObject } from "react";

export interface LaneSlotInput {
  readonly id: string;
  readonly startTop: number;
  readonly naturalHeight: number;
  /** Optional bottom boundary relative to pane top used for sticky glide room or model span foot. */
  readonly spanBottom?: number;
  /** Optional gap separating adjacent notes below the current slot. */
  readonly gap?: number;
}

export interface LaneSlotOutput {
  readonly id: string;
  readonly top: number;
  readonly height: number;
}

/**
 * Pure vertical constraint solver for margin annotation panes (Safari 18.7+).
 * Ensures subsequent slots never overlap prior notes while giving each slot its
 * sticky travel range down to `spanBottom` when available.
 */
export function solveLaneSlots(slots: readonly LaneSlotInput[], defaultGap = 8): LaneSlotOutput[] {
  let cursor = 0;
  const result: LaneSlotOutput[] = [];

  for (const slot of slots) {
    const gap = slot.gap ?? defaultGap;
    const top = Math.max(0, slot.startTop, cursor);
    const height = slot.spanBottom != null ? Math.max(slot.naturalHeight, slot.spanBottom - top) : slot.naturalHeight;

    result.push({
      id: slot.id,
      top: Math.round(top),
      height: Math.round(height),
    });

    cursor = top + slot.naturalHeight + gap;
  }

  return result;
}

export interface UseLaneLayoutOptions {
  readonly timelineRef: RefObject<HTMLElement | null>;
  readonly enabled?: boolean;
  /** CSS dependency key that triggers re-measurement when beats or notes change. */
  readonly version?: number | string;
}

/**
 * Measures beat bodies inside `.timeline-main` and positions `.annotation-slot` items inside
 * `.side-pane`s via `--rt-slot-top` and `--rt-slot-height` without CSS Anchor Positioning.
 */
export function useLaneLayout({ timelineRef, enabled = true, version }: UseLaneLayoutOptions): void {
  useLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const timeline = timelineRef.current;
    if (!timeline) return;

    const layoutPane = (pane: HTMLElement): void => {
      const paneRect = pane.getBoundingClientRect();
      const beatBodies = new Map<number, DOMRect>();
      for (const beat of timeline.querySelectorAll<HTMLElement>(".beat[data-beat-row]")) {
        const row = Number(beat.dataset.beatRow);
        if (Number.isFinite(row)) {
          const target = beat.querySelector<HTMLElement>(".beat-body") ?? beat;
          beatBodies.set(row, target.getBoundingClientRect());
        }
      }

      const notesList = pane.querySelector(".side-notes");
      const rawGap = notesList instanceof HTMLElement ? getComputedStyle(notesList).rowGap : "";
      const parsedGap = Number.parseFloat(rawGap);
      const defaultGap = Number.isFinite(parsedGap) ? parsedGap : 24;

      const inputs: LaneSlotInput[] = [];
      const slotMap = new Map<string, HTMLElement>();

      let slotIndex = 0;
      for (const slot of pane.querySelectorAll<HTMLElement>(".annotation-slot")) {
        const startRow = Number(slot.dataset.beatRow);
        const startRect = Number.isFinite(startRow) ? beatBodies.get(startRow) : undefined;
        const startTop = startRect ? startRect.top - paneRect.top : 0;

        const isModelSlot = slot.classList.contains("model-slot");
        const lastRow = Number(slot.dataset.modelLastRow);
        const endRow = Number(slot.dataset.endRow);

        let spanBottom: number | undefined;
        if (isModelSlot && Number.isFinite(lastRow)) {
          const lastRect = beatBodies.get(lastRow);
          if (lastRect) {
            spanBottom = lastRect.bottom - paneRect.top;
          }
        } else if (Number.isFinite(endRow)) {
          const endRect = beatBodies.get(endRow);
          if (endRect) {
            spanBottom = endRect.top - paneRect.top;
          }
        } else if (paneRect.height > 0) {
          spanBottom = paneRect.height;
        }

        const noteEl = slot.firstElementChild instanceof HTMLElement ? slot.firstElementChild : null;
        const noteHeight = noteEl
          ? Math.max(noteEl.offsetHeight, noteEl.getBoundingClientRect().height)
          : slot.offsetHeight;

        const id = String(slotIndex);
        slotIndex += 1;
        slotMap.set(id, slot);
        inputs.push({
          id,
          startTop,
          naturalHeight: noteHeight,
          spanBottom,
        });
      }

      const solved = solveLaneSlots(inputs, defaultGap);
      for (const item of solved) {
        const slot = slotMap.get(item.id);
        if (!slot) continue;
        slot.style.setProperty("--rt-slot-top", `${item.top}px`);
        slot.style.setProperty("--rt-slot-height", `${item.height}px`);
      }
    };

    const apply = (): void => {
      for (const pane of timeline.querySelectorAll<HTMLElement>(".side-pane")) {
        layoutPane(pane);
      }
    };

    apply();

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    observer?.observe(timeline);
    const main = timeline.querySelector<HTMLElement>(".timeline-main");
    if (main) observer?.observe(main);
    for (const slot of timeline.querySelectorAll<HTMLElement>(".annotation-slot > *")) {
      observer?.observe(slot);
    }

    window.addEventListener("resize", apply);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [timelineRef, enabled, version]);
}
