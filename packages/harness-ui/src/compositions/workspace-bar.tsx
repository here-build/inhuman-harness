import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { Button } from "../primitives/button.js";
import { DENSITY_BOUNDARY, SurfaceScope, type DensityValue, type SurfaceValue } from "../theme/index.js";
import { useVoice } from "../voice/index.js";

/** Mobile sidebar drawer toggle configuration for {@link WorkspaceBar}. */
export interface MobileNavToggle {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly controls?: string;
  readonly openAriaLabel?: string;
  readonly closeAriaLabel?: string;
  readonly openText?: string;
  readonly closeText?: string;
}

/** Props for {@link WorkspaceBar}. */
export interface WorkspaceBarProps {
  readonly surface?: SurfaceValue;
  readonly density?: DensityValue;
  readonly leadingAction?: ReactNode;
  readonly mobileNavToggle?: MobileNavToggle;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Bottom or top workspace strip holding settings trigger, mobile nav toggle, and project tabs. */
export function WorkspaceBar({
  surface = "soft",
  density,
  leadingAction,
  mobileNavToggle,
  className,
  children,
}: WorkspaceBarProps) {
  const voice = useVoice();
  const controlsId = mobileNavToggle?.controls ?? "navigation-rail";
  const openAria = mobileNavToggle?.openAriaLabel ?? voice.workspace.openSidebarLabel;
  const closeAria = mobileNavToggle?.closeAriaLabel ?? voice.workspace.closeSidebarLabel;
  const openLabel = mobileNavToggle?.openText ?? voice.common.close;
  const closedLabel = mobileNavToggle?.closeText ?? "Browse";
  return (
    <SurfaceScope
      as="div"
      surface={surface}
      data-density={density}
      className={cn(density != null && DENSITY_BOUNDARY, "project-strip", className)}
    >
      {leadingAction}
      {mobileNavToggle == null ? null : (
        <Button
          variant="ghost"
          className="min-[64rem]:hidden"
          aria-label={mobileNavToggle.open ? closeAria : openAria}
          aria-controls={controlsId}
          aria-expanded={mobileNavToggle.open}
          onClick={mobileNavToggle.onToggle}
        >
          {mobileNavToggle.open ? openLabel : closedLabel}
        </Button>
      )}
      {children}
    </SurfaceScope>
  );
}
