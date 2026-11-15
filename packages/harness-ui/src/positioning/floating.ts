import { useLayoutEffect, type RefObject } from "react";

/** Supported placements for top-layer floating popovers and tooltips without CSS Anchors. */
export type FloatingPlacement =
  | "bottom-start"
  | "bottom-end"
  | "bottom"
  | "top-start"
  | "top-end"
  | "top"
  | "right-start"
  | "right-end"
  | "left-start"
  | "left-end";

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SizeLike {
  readonly width: number;
  readonly height: number;
}

export interface FloatingPositionInput {
  readonly triggerRect: RectLike;
  readonly floatingSize: SizeLike;
  readonly viewport: SizeLike;
  readonly placement?: string;
  readonly offset?: number;
  readonly viewportMargin?: number;
  readonly matchTriggerWidth?: boolean;
}

export interface FloatingPositionResult {
  readonly x: number;
  readonly y: number;
  readonly maxHeight: number;
  readonly maxWidth: number;
  readonly triggerWidth: number;
  readonly resolvedPlacement: FloatingPlacement;
  readonly transformOrigin: string;
}

const PLACEMENT_ALIASES: Readonly<Record<string, FloatingPlacement>> = {
  "bottom-start": "bottom-start",
  "bottom start": "bottom-start",
  "bottom left": "bottom-start",
  "bottom-end": "bottom-end",
  "bottom end": "bottom-end",
  "bottom right": "bottom-end",
  bottom: "bottom",
  "top-start": "top-start",
  "top start": "top-start",
  "top left": "top-start",
  "top-end": "top-end",
  "top end": "top-end",
  "top right": "top-end",
  top: "top",
  "right-start": "right-start",
  "right start": "right-start",
  "right top": "right-start",
  right: "right-start",
  "end top": "right-start",
  "end start": "right-start",
  end: "right-start",
  "right-end": "right-end",
  "right end": "right-end",
  "right bottom": "right-end",
  "end bottom": "right-end",
  "end end": "right-end",
  "left-start": "left-start",
  "left start": "left-start",
  "left top": "left-start",
  left: "left-start",
  "start top": "left-start",
  "start start": "left-start",
  start: "left-start",
  "left-end": "left-end",
  "left end": "left-end",
  "left bottom": "left-end",
  "start bottom": "left-end",
  "start end": "left-end",
};

/**
 * Normalizes hyphenated, space-separated, or logical placement strings (such as RAC's
 * `"bottom start"` or `"end top"`) into a canonical {@link FloatingPlacement}.
 */
export function normalizePlacement(
  placement: unknown,
  fallback: FloatingPlacement = "bottom-start",
): FloatingPlacement {
  if (typeof placement !== "string") return fallback;
  const key = placement.trim().toLowerCase().replaceAll(/\s+/g, " ");
  return PLACEMENT_ALIASES[key] ?? fallback;
}

const FLIPPED_PLACEMENT: Readonly<Record<FloatingPlacement, FloatingPlacement>> = {
  "bottom-start": "top-start",
  "bottom-end": "top-end",
  bottom: "top",
  "top-start": "bottom-start",
  "top-end": "bottom-end",
  top: "bottom",
  "right-start": "left-start",
  "right-end": "left-end",
  "left-start": "right-start",
  "left-end": "right-end",
};

const ORIGIN_BY_PLACEMENT: Readonly<Record<FloatingPlacement, string>> = {
  "bottom-start": "top left",
  "bottom-end": "top right",
  bottom: "top center",
  "top-start": "bottom left",
  "top-end": "bottom right",
  top: "bottom center",
  "right-start": "top left",
  "right-end": "bottom left",
  "left-start": "top right",
  "left-end": "bottom right",
};

function flipPlacement(placement: FloatingPlacement): FloatingPlacement {
  return FLIPPED_PLACEMENT[placement];
}

function originForPlacement(placement: FloatingPlacement): string {
  return ORIGIN_BY_PLACEMENT[placement];
}

function clamp(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Pure geometry solver for Safari 18.7+ viewport-clamped popovers and tooltips.
 * Flips across the primary axis when the opposite side has more room and the
 * preferred side overflows the viewport.
 */
export function computeFloatingPosition({
  triggerRect,
  floatingSize,
  viewport,
  placement = "bottom-start",
  offset = 4,
  viewportMargin = 8,
  matchTriggerWidth = false,
}: FloatingPositionInput): FloatingPositionResult {
  const safeViewportW = viewport.width > 0 ? viewport.width : 1024;
  const safeViewportH = viewport.height > 0 ? viewport.height : 768;

  const effectiveWidth = matchTriggerWidth ? Math.max(floatingSize.width, triggerRect.width) : floatingSize.width;
  const effectiveHeight = floatingSize.height;

  const spaceBelow = Math.max(0, safeViewportH - triggerRect.bottom - offset - viewportMargin);
  const spaceAbove = Math.max(0, triggerRect.top - offset - viewportMargin);
  const spaceRight = Math.max(0, safeViewportW - triggerRect.right - offset - viewportMargin);
  const spaceLeft = Math.max(0, triggerRect.left - offset - viewportMargin);

  const normalizedPlacement = normalizePlacement(placement);
  let resolvedPlacement = normalizedPlacement;
  if (
    normalizedPlacement.startsWith("bottom") &&
    effectiveHeight > 0 &&
    effectiveHeight > spaceBelow &&
    spaceAbove > spaceBelow
  ) {
    resolvedPlacement = flipPlacement(normalizedPlacement);
  } else if (
    normalizedPlacement.startsWith("top") &&
    effectiveHeight > 0 &&
    effectiveHeight > spaceAbove &&
    spaceBelow > spaceAbove
  ) {
    resolvedPlacement = flipPlacement(normalizedPlacement);
  } else if (
    normalizedPlacement.startsWith("right") &&
    effectiveWidth > 0 &&
    effectiveWidth > spaceRight &&
    spaceLeft > spaceRight
  ) {
    resolvedPlacement = flipPlacement(normalizedPlacement);
  } else if (
    normalizedPlacement.startsWith("left") &&
    effectiveWidth > 0 &&
    effectiveWidth > spaceLeft &&
    spaceRight > spaceLeft
  ) {
    resolvedPlacement = flipPlacement(normalizedPlacement);
  }

  let x: number;
  let y: number;
  let maxHeight = Math.max(96, safeViewportH - viewportMargin * 2);

  if (resolvedPlacement.startsWith("bottom") || resolvedPlacement.startsWith("top")) {
    const isTop = resolvedPlacement.startsWith("top");
    maxHeight = Math.max(96, isTop ? spaceAbove : spaceBelow);
    const renderedHeight = Math.min(effectiveHeight, maxHeight);
    y = isTop ? triggerRect.top - offset - renderedHeight : triggerRect.bottom + offset;

    if (resolvedPlacement.endsWith("-end")) {
      x = triggerRect.right - effectiveWidth;
    } else if (resolvedPlacement === "top" || resolvedPlacement === "bottom") {
      x = triggerRect.left + (triggerRect.width - effectiveWidth) / 2;
    } else {
      x = triggerRect.left;
    }

    x = clamp(x, viewportMargin, Math.max(viewportMargin, safeViewportW - viewportMargin - effectiveWidth));
    y = clamp(y, viewportMargin, Math.max(viewportMargin, safeViewportH - viewportMargin - renderedHeight));
  } else {
    const isLeft = resolvedPlacement.startsWith("left");
    x = isLeft ? triggerRect.left - offset - effectiveWidth : triggerRect.right + offset;
    y = resolvedPlacement.endsWith("-end") ? triggerRect.bottom - effectiveHeight : triggerRect.top;

    x = clamp(x, viewportMargin, Math.max(viewportMargin, safeViewportW - viewportMargin - effectiveWidth));
    y = clamp(y, viewportMargin, Math.max(viewportMargin, safeViewportH - viewportMargin - effectiveHeight));
  }

  return {
    x: Math.round(x),
    y: Math.round(y),
    maxHeight: Math.round(maxHeight),
    maxWidth: Math.round(Math.max(120, safeViewportW - viewportMargin * 2)),
    triggerWidth: Math.round(triggerRect.width),
    resolvedPlacement,
    transformOrigin: originForPlacement(resolvedPlacement),
  };
}

export interface UseFloatingPositionOptions {
  readonly triggerRef: RefObject<Element | null> | undefined;
  readonly floatingRef: RefObject<HTMLElement | null>;
  readonly isOpen: boolean;
  readonly placement?: string;
  readonly offset?: number;
  readonly viewportMargin?: number;
  readonly matchTriggerWidth?: boolean;
}

/**
 * Synchronizes viewport-clamped `--rt-x`, `--rt-y`, `--rt-max-h`, `--rt-max-w`,
 * `--rt-trigger-w`, and `--rt-origin` CSS custom properties onto a floating overlay element.
 */
export function useFloatingPosition({
  triggerRef,
  floatingRef,
  isOpen,
  placement = "bottom-start",
  offset = 4,
  viewportMargin = 8,
  matchTriggerWidth = false,
}: UseFloatingPositionOptions): void {
  useLayoutEffect(() => {
    if (!isOpen || typeof window === "undefined" || !triggerRef) return;
    const trigger = triggerRef.current;
    const floating = floatingRef.current;
    if (!trigger || !floating) return;

    const normalizedPlacement = normalizePlacement(placement);

    const apply = (): void => {
      const triggerRect = trigger.getBoundingClientRect();
      const floatingRect = floating.getBoundingClientRect();
      const floatingWidth = floatingRect.width > 0 ? floatingRect.width : floating.offsetWidth;
      const floatingHeight = floatingRect.height > 0 ? floatingRect.height : floating.offsetHeight;

      const next = computeFloatingPosition({
        triggerRect,
        floatingSize: { width: floatingWidth, height: floatingHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        placement: normalizedPlacement,
        offset,
        viewportMargin,
        matchTriggerWidth,
      });

      floating.style.setProperty("--rt-x", `${next.x}px`);
      floating.style.setProperty("--rt-y", `${next.y}px`);
      floating.style.setProperty("--rt-max-h", `${next.maxHeight}px`);
      floating.style.setProperty("--rt-max-w", `${next.maxWidth}px`);
      floating.style.setProperty("--rt-trigger-w", `${next.triggerWidth}px`);
      floating.style.setProperty("--rt-origin", next.transformOrigin);
      floating.dataset.resolvedPlacement = next.resolvedPlacement;
    };

    apply();
    const rafId = window.requestAnimationFrame(apply);

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    observer?.observe(trigger);
    observer?.observe(floating);

    const handleToggle = (): void => {
      apply();
    };

    floating.addEventListener("toggle", handleToggle);
    window.addEventListener("scroll", apply, { capture: true, passive: true });
    window.addEventListener("resize", apply);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
      floating.removeEventListener("toggle", handleToggle);
      window.removeEventListener("scroll", apply, { capture: true });
      window.removeEventListener("resize", apply);
    };
  }, [triggerRef, floatingRef, isOpen, placement, offset, viewportMargin, matchTriggerWidth]);
}
