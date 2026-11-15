import type { ReactNode } from "react";

import { cn } from "../lib/cn.js";
import { DENSITY_BOUNDARY, SurfaceScope, type DensityValue, type SurfaceValue } from "../theme/index.js";
import { useVoice } from "../voice/index.js";

/** Props for {@link SessionSidebar}. */
export interface SessionSidebarProps {
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly open?: boolean;
  readonly brand?: ReactNode;
  readonly headerAction?: ReactNode;
  readonly surface?: SurfaceValue;
  readonly density?: DensityValue;
  readonly className?: string;
  readonly children?: ReactNode;
}

/** Collapsible navigation rail wrapping workspace brand header, machine link, and session/bot index. */
export function SessionSidebar({
  id = "navigation-rail",
  ariaLabel,
  open = false,
  brand,
  headerAction,
  surface = "soft",
  density,
  className,
  children,
}: SessionSidebarProps) {
  const voice = useVoice();
  return (
    <SurfaceScope
      as="aside"
      surface={surface}
      id={id}
      aria-label={ariaLabel ?? voice.workspace.sessionsLabel}
      data-density={density}
      className={cn(
        "rail w-full shrink-0 flex-col overflow-y-auto bg-wash max-[63.999rem]:max-h-[70dvh] min-[64rem]:w-72 min-[64rem]:max-h-none min-[64rem]:overflow-hidden min-[64rem]:border-r min-[64rem]:border-line",
        density != null && DENSITY_BOUNDARY,
        open ? "flex max-[63.999rem]:border-b max-[63.999rem]:border-line" : "hidden min-[64rem]:flex",
        className,
      )}
    >
      {typeof brand === "string" ? <h1 className="rail-brand">{brand}</h1> : brand}
      {headerAction}
      <div className="flex flex-col min-[64rem]:min-h-0 min-[64rem]:flex-1">{children}</div>
    </SurfaceScope>
  );
}
