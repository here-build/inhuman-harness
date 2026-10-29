import { useEffect, useState, type ReactNode, type RefObject } from "react";

import { bindWindowFileDrop, type WindowDropPhase } from "./window-drop.js";

/** The composer field as the drop target for a window-wide file drag. */
export function PictureDrop({
  fieldRef,
  enabled,
  onDrop,
  children,
}: {
  readonly fieldRef: RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
  readonly onDrop: (files: readonly File[]) => void;
  readonly children: ReactNode;
}) {
  const [phase, setPhase] = useState<WindowDropPhase>("idle");

  useEffect(() => {
    if (!enabled) return;
    return bindWindowFileDrop({
      hot: () => fieldRef.current,
      onPhase: setPhase,
      onDrop,
    });
  }, [enabled, fieldRef, onDrop]);

  useEffect(() => {
    if (enabled) return;
    setPhase("idle");
  }, [enabled]);

  return (
    <div
      ref={fieldRef}
      className="composer-pill relative overflow-hidden"
      data-drop={phase === "idle" ? undefined : phase}
    >
      {children}
      {phase === "idle" ? null : (
        <div className="composer-drop" aria-hidden="true">
          Drop here
        </div>
      )}
    </div>
  );
}
