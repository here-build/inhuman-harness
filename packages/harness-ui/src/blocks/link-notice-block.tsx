import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";

export interface LinkNoticeBlockProps {
  /** Waiting indicator vs actionable connection or navigation boundary. */
  readonly mode: "waiting" | "needs";
  readonly message: ReactNode;
  readonly actionLabel?: string;
  readonly actionDisabled?: boolean;
  readonly onAction?: () => void;
  readonly className?: string;
}

/** Single-sentence connection/route status notice with optional recovery action. */
export function LinkNoticeBlock({
  mode,
  message,
  actionLabel,
  actionDisabled = false,
  onAction,
  className,
}: LinkNoticeBlockProps) {
  if (mode === "waiting") {
    return (
      <p className={cn("link-notice", className)} data-waiting="" role="status">
        <span className="link-glyph" data-waiting="" aria-hidden />
        <span className="link-text">{message}</span>
      </p>
    );
  }
  return (
    <p className={cn("link-notice", className)} role="status">
      <span className="link-glyph" data-needs="" aria-hidden />
      <span className="link-text">{message}</span>
      {actionLabel == null ? null : (
        <Button variant="secondary" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </p>
  );
}
