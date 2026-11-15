import type { ReactNode, Ref, UIEventHandler } from "react";

import { cn } from "../lib/cn.js";
import { SurfaceScope, type SurfaceValue } from "../theme/index.js";

/** Props for {@link ConversationStage}. */
export interface ConversationStageProps {
  readonly scrollRef?: Ref<HTMLElement>;
  readonly onScroll?: UIEventHandler<HTMLElement>;
  readonly ariaLabel?: string;
  readonly surface?: SurfaceValue;
  readonly className?: string;
  readonly children?: ReactNode;
  readonly composer?: ReactNode;
}

/** Main scrollable conversation tape hosting transcript beats, scroll anchor, and composer dock. */
export function ConversationStage({
  scrollRef,
  onScroll,
  ariaLabel = "Conversation",
  surface = "paper",
  className,
  children,
  composer,
}: ConversationStageProps) {
  return (
    <SurfaceScope
      as="main"
      ref={scrollRef}
      onScroll={onScroll}
      surface={surface}
      aria-label={ariaLabel}
      className={cn("tape", className)}
    >
      {children}
      <div className="anchor" />
      {composer}
    </SurfaceScope>
  );
}
