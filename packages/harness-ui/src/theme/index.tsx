import { Activity, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "../lib/cn.js";

/** Rendering lifecycle and layout mode matching Mercury's five-state Visibility contract. */
export type VisibilityMode = "visible" | "hidden" | "display-none" | "unmounted" | "invisible";

export interface VisibilityProps {
  readonly mode: VisibilityMode;
  readonly children?: ReactNode;
  readonly className?: string;
}

/** Controls mounting, React Activity suspension, display collapse, or layout-preserving invisibility. */
export function Visibility({ mode, children, className }: VisibilityProps) {
  switch (mode) {
    case "unmounted":
      return null;
    case "visible":
      return <Activity mode="visible">{children}</Activity>;
    case "hidden":
      return <Activity mode="hidden">{children}</Activity>;
    case "display-none":
      return (
        <div data-visibility="display-none" className={className} hidden aria-hidden="true">
          {children}
        </div>
      );
    case "invisible":
      return (
        <div data-visibility="invisible" className={className} aria-hidden="true">
          {children}
        </div>
      );
  }
}

export type SurfaceValue = "paper" | "soft" | "well" | "raised" | "field";
export type ProminenceValue = "ambient" | "standard" | "raised" | "focal";
export type EmphasisValue = "quiet" | "neutral" | "accent" | "danger" | "warning" | "success";
export type DensityValue = "compact" | "cozy" | "comfortable";

export const SURFACE_BOUNDARY = "surface-boundary";
export const PROMINENCE_BOUNDARY = "prominence-boundary";
export const EMPHASIS_BOUNDARY = "emphasis-boundary";
export const DENSITY_BOUNDARY = "density-boundary";

export type ScopeTag = "div" | "section" | "aside" | "nav" | "span" | "main" | "header" | "footer";

interface AxisScopeBaseProps extends Omit<HTMLAttributes<HTMLElement>, "children" | "className" | "style"> {
  readonly as?: ScopeTag;
  readonly ref?: Ref<HTMLElement>;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}

export interface SurfaceScopeProps extends AxisScopeBaseProps {
  readonly surface: SurfaceValue;
}

/** Creates an isolated `@scope` surface context stopped by `.surface-boundary`. */
export function SurfaceScope({
  surface,
  as: Tag = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: SurfaceScopeProps) {
  return (
    <Tag {...rest} ref={ref as never} data-surface={surface} className={cn(SURFACE_BOUNDARY, className)} style={style}>
      {children}
    </Tag>
  );
}

export interface ProminenceScopeProps extends AxisScopeBaseProps {
  readonly prominence: ProminenceValue;
}

/** Creates an isolated `@scope` prominence context stopped by `.prominence-boundary`. */
export function ProminenceScope({
  prominence,
  as: Tag = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: ProminenceScopeProps) {
  return (
    <Tag
      {...rest}
      ref={ref as never}
      data-prominence={prominence}
      className={cn(PROMINENCE_BOUNDARY, className)}
      style={style}
    >
      {children}
    </Tag>
  );
}

export interface EmphasisScopeProps extends AxisScopeBaseProps {
  readonly emphasis: EmphasisValue;
}

/** Creates an isolated `@scope` emphasis context stopped by `.emphasis-boundary`. */
export function EmphasisScope({
  emphasis,
  as: Tag = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: EmphasisScopeProps) {
  return (
    <Tag
      {...rest}
      ref={ref as never}
      data-emphasis={emphasis}
      className={cn(EMPHASIS_BOUNDARY, className)}
      style={style}
    >
      {children}
    </Tag>
  );
}

export interface DensityScopeProps extends AxisScopeBaseProps {
  readonly density: DensityValue;
}

/** Creates an isolated `@scope` density context stopped by `.density-boundary`. */
export function DensityScope({
  density,
  as: Tag = "div",
  ref,
  className,
  style,
  children,
  ...rest
}: DensityScopeProps) {
  return (
    <Tag {...rest} ref={ref as never} data-density={density} className={cn(DENSITY_BOUNDARY, className)} style={style}>
      {children}
    </Tag>
  );
}
