import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../lib/cn.js";

export interface ControlGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** Axis along which grouped sibling controls collapse borders and share outer corners. */
  readonly orientation?: "horizontal" | "vertical";
}

/** Composes adjacent interactive controls (`Button`, `FieldButton`, `Input`) into a single hairline frame. */
export const ControlGroup = forwardRef<HTMLDivElement, ControlGroupProps>(function ControlGroupControl(
  { orientation = "horizontal", className, role = "group", ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      role={role}
      data-ui="control-group"
      data-orientation={orientation}
      className={cn(className)}
    />
  );
});
