import { forwardRef, type SelectHTMLAttributes } from "react";
import { mergeProps, useFocusRing } from "react-aria";

import { fieldControlClassName } from "./input.js";
import { cn } from "../../lib/cn.js";

// The OS owns this menu's placement and interaction. Use DropdownSelect when a
// product-owned anchored list is needed, not an untested replacement in a form.
// This adapter deliberately preserves native ChangeEvent, form/reset, and ref APIs.
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelectControl({ className, ...props }, ref) {
    const { focusProps, isFocusVisible } = useFocusRing();
    return (
      <select
        {...mergeProps(props, focusProps)}
        ref={ref}
        className={cn(fieldControlClassName, "h-9 cursor-pointer", className)}
        data-focus-visible={isFocusVisible || undefined}
        data-disabled={props.disabled || undefined}
        data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true" || undefined}
      />
    );
  },
);
