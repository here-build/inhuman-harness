import type { CSSProperties, ReactNode } from "react";

import { cn } from "../lib/cn.js";

/** Top-level arrangement of workspace chrome relative to the conversation stage. */
export type WorkspaceLayout = "rail-left" | "header-top";

/** Props for {@link WorkspaceShell}. */
export interface WorkspaceShellProps {
  readonly layout?: WorkspaceLayout;
  readonly embed?: boolean;
  readonly picking?: boolean;
  readonly style?: CSSProperties;
  readonly className?: string;
  readonly sidebar?: ReactNode;
  readonly stage: ReactNode;
  readonly inspector?: ReactNode;
  readonly workspaceBar?: ReactNode;
  readonly overlay?: ReactNode;
}

/** Structural Lego shell combining optional navigation sidebar, central stage, inspector drawer, and workspace bar. */
export function WorkspaceShell({
  layout = "rail-left",
  embed = false,
  picking = false,
  style,
  className,
  sidebar,
  stage,
  inspector,
  workspaceBar,
  overlay,
}: WorkspaceShellProps) {
  const layoutAttr = layout === "header-top" ? "header-top" : undefined;
  if (embed) {
    return (
      <div className={cn("frame", className)} data-embed="" data-layout={layoutAttr} style={style}>
        {stage}
        {inspector}
        {overlay}
      </div>
    );
  }
  return (
    <div
      className={cn("frame", className)}
      data-layout={layoutAttr}
      data-picking={picking ? "" : undefined}
      style={style}
    >
      <div className="frame-body">
        {sidebar}
        {stage}
        {inspector}
      </div>
      {workspaceBar}
      {picking ? <div className="picker-backdrop" aria-hidden="true" /> : null}
      {overlay}
    </div>
  );
}
