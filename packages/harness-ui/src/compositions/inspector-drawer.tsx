import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import { SurfaceScope, type SurfaceValue } from "../theme/index.js";
import { useVoice } from "../voice/index.js";

/** Props for {@link InspectorDrawer}. */
export interface InspectorDrawerProps {
  readonly title?: string;
  readonly titleTooltip?: string;
  readonly ariaLabel?: string;
  readonly closeAriaLabel?: string;
  readonly closeLabel?: string;
  readonly busy?: boolean;
  readonly surface?: SurfaceValue;
  readonly className?: string;
  readonly onClose?: () => void;
  readonly children?: ReactNode;
}

/** Docked or overlaid inspector drawer for file previews, diff panels, or secondary details. */
export function InspectorDrawer({
  title,
  titleTooltip,
  ariaLabel,
  closeAriaLabel = "Close inspector",
  closeLabel,
  busy,
  surface = "paper",
  className,
  onClose,
  children,
}: InspectorDrawerProps) {
  const voice = useVoice();
  const hasHeader = title != null || onClose != null;
  return (
    <SurfaceScope
      as="aside"
      surface={surface}
      aria-label={ariaLabel ?? voice.workspace.filesLabel}
      className={cn("file-sidebar", className)}
    >
      {hasHeader ? (
        <>
          <header className="file-sidebar-head">
            {title == null ? (
              <span />
            ) : (
              <h2 className="mono" title={titleTooltip ?? title}>
                {title}
              </h2>
            )}
            {onClose == null ? null : (
              <Button variant="ghost" aria-label={closeAriaLabel} onClick={onClose}>
                {closeLabel ?? voice.common.close}
              </Button>
            )}
          </header>
          <div className="file-sidebar-body" aria-busy={busy}>
            {children}
          </div>
        </>
      ) : (
        children
      )}
    </SurfaceScope>
  );
}
