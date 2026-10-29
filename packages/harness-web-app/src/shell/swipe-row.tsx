import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { resist, swipeRelease, type SwipeDecision } from "./row-swipe.js";

/** Resting width of a swipe button. "Delete" and "Log out" fit. */
const ACTION = 84;

export type SwipeAction = {
  readonly label: string;
  readonly name: string;
  readonly tone: "destructive" | "action" | "quiet";
  readonly onPress: () => Promise<unknown> | void;
};

type Side = "leading" | "trailing";

const closers = new Set<() => void>();

export function closeOpenSwipes(except?: () => void): void {
  for (const close of closers) if (close !== except) close();
}

/**
 * A settings row that slides aside to reveal one button, the way a list row does.
 * A press toggles while the row is shut, and shuts it when a button is showing.
 * Vertical movement stays a scroll; a horizontal drag is claimed once it is clearly sideways.
 */
export function SwipeRow({
  label,
  title,
  detail,
  failed = false,
  checked,
  disabled = false,
  leading,
  trailing,
  onToggle,
}: {
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly failed?: boolean;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly leading?: SwipeAction;
  readonly trailing?: SwipeAction;
  readonly onToggle: () => void;
}) {
  const clip = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Side | null>(null);
  const rest = useRef(0);
  const origin = useRef<{ x: number; y: number; t: number; offset: number } | null>(null);
  const samples = useRef<{ x: number; t: number }[]>([]);
  const dragged = useRef(false);
  const suppressClick = useRef(false);
  const gen = useRef(0);
  const mounted = useRef(true);
  const closer = useRef<() => void>(() => undefined);
  const leadingRef = useRef(leading);
  const trailingRef = useRef(trailing);
  const onToggleRef = useRef(onToggle);
  leadingRef.current = leading;
  trailingRef.current = trailing;
  onToggleRef.current = onToggle;

  const settle = useCallback((to: number, after?: () => void) => {
    const mine = ++gen.current;
    rest.current = to;
    setDragging(false);
    setX(to);
    setOpen(to < 0 ? "trailing" : to > 0 ? "leading" : null);
    if (after == null) return;
    window.setTimeout(() => {
      if (gen.current !== mine || !mounted.current) return;
      after();
    }, motion());
  }, []);

  useEffect(() => {
    mounted.current = true;
    const close = () => settle(0);
    closer.current = close;
    closers.add(close);
    return () => {
      mounted.current = false;
      closers.delete(close);
    };
  }, [settle]);

  useEffect(() => {
    const measure = () => {
      const node = clip.current;
      if (node != null) setWidth(node.clientWidth);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const run = useCallback(
    (action: SwipeAction) => {
      const result = action.onPress();
      if (result == null) {
        if (mounted.current) settle(0);
        return;
      }
      void result.then(() => {
        if (mounted.current) settle(0);
        return undefined;
      });
    },
    [settle],
  );

  const apply = (decision: SwipeDecision) => {
    const span = width || ACTION;
    if (decision === "commit-trailing" && trailingRef.current != null) {
      settle(-span, () => {
        if (trailingRef.current != null) run(trailingRef.current);
      });
      return;
    }
    if (decision === "commit-leading" && leadingRef.current != null) {
      settle(span, () => {
        if (leadingRef.current != null) run(leadingRef.current);
      });
      return;
    }
    if (decision === "open-trailing" && trailingRef.current != null) {
      settle(-ACTION);
      return;
    }
    if (decision === "open-leading" && leadingRef.current != null) {
      settle(ACTION);
      return;
    }
    settle(0);
  };

  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = origin.current;
    origin.current = null;
    if (start == null) return;
    const dx = event.clientX - start.x;
    const wasDrag = dragged.current;
    dragged.current = false;
    setDragging(false);
    if (!wasDrag) return;
    suppressClick.current = true;
    const recent = samples.current;
    const first = recent[0] ?? { x: start.x, t: start.t };
    const last = recent[recent.length - 1] ?? first;
    const velocity = last.t === first.t ? 0 : (last.x - first.x) / (last.t - first.t);
    apply(
      swipeRelease(start.offset + dx, velocity, width, ACTION, {
        leading: leading != null,
        trailing: trailing != null,
      }),
    );
  };

  const span = Math.max(width, ACTION);
  const trailingWidth = x >= 0 ? 0 : Math.min(span, -x);
  const leadingWidth = x <= 0 ? 0 : Math.min(span, x);

  return (
    <div ref={clip} className="swipe-clip" data-dragging={dragging ? "true" : "false"}>
      {leading == null ? null : (
        <Action
          action={leading}
          side="leading"
          width={leadingWidth}
          open={open === "leading"}
          disabled={disabled}
          onRun={() => run(leading)}
        />
      )}
      {trailing == null ? null : (
        <Action
          action={trailing}
          side="trailing"
          width={trailingWidth}
          open={open === "trailing"}
          disabled={disabled}
          onRun={() => run(trailing)}
        />
      )}
      <button
        type="button"
        role="switch"
        className="swipe-main touch-target"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        style={swipeShift(x)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && trailing != null) {
            event.preventDefault();
            closeOpenSwipes(closer.current);
            settle(-ACTION);
          } else if (event.key === "ArrowRight" && leading != null) {
            event.preventDefault();
            closeOpenSwipes(closer.current);
            settle(ACTION);
          }
        }}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          closeOpenSwipes(closer.current);
          origin.current = { x: event.clientX, y: event.clientY, t: event.timeStamp, offset: rest.current };
          samples.current = [{ x: event.clientX, t: event.timeStamp }];
          dragged.current = false;
        }}
        onPointerMove={(event) => {
          const start = origin.current;
          if (start == null) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!dragged.current) {
            if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
            dragged.current = true;
            setDragging(true);
            const target = event.currentTarget;
            if (typeof target.setPointerCapture === "function") {
              try {
                target.setPointerCapture(event.pointerId);
              } catch {
                // A pointer that has already ended cannot be captured. Tracking continues.
              }
            }
          }
          const now = event.timeStamp;
          samples.current = [...samples.current.filter((sample) => now - sample.t < 80), { x: event.clientX, t: now }];
          const min = trailing == null ? 0 : -(width || ACTION);
          const max = leading == null ? 0 : width || ACTION;
          setX(resist(start.offset + dx, min, max));
        }}
        onPointerUp={finish}
        onPointerCancel={() => {
          origin.current = null;
          dragged.current = false;
          suppressClick.current = true;
          settle(0);
        }}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (rest.current !== 0) {
            settle(0);
            return;
          }
          onToggleRef.current();
        }}
      >
        <span className="settings-grow">
          <span className="block truncate text-sm font-strong">{title}</span>
          <span className={`block truncate text-sm ${failed ? "text-danger" : "text-muted"}`}>{detail}</span>
        </span>
        <span className="settings-switch" data-on={checked ? "true" : "false"} />
      </button>
    </div>
  );
}

function Action({
  action,
  side,
  width,
  open,
  disabled,
  onRun,
}: {
  readonly action: SwipeAction;
  readonly side: Side;
  readonly width: number;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
}) {
  return (
    <button
      type="button"
      className="swipe-action"
      data-tone={action.tone}
      data-side={side}
      data-live={width > 24 ? "true" : "false"}
      style={{ width }}
      aria-label={action.name}
      aria-hidden={open ? undefined : true}
      tabIndex={open ? 0 : -1}
      disabled={disabled}
      onClick={onRun}
    >
      {action.label}
    </button>
  );
}

function motion(): number {
  if (typeof globalThis.matchMedia !== "function") return 160;
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160;
}

/** Slide the face, and pad the revealed side so the name stays inside the clip. */
function swipeShift(x: number): CSSProperties {
  return {
    "--swipe-x": `${x}px`,
    "--swipe-pad-start": `${Math.max(-x, 0)}px`,
    "--swipe-pad-end": `${Math.max(x, 0)}px`,
  } as CSSProperties;
}
