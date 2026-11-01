import { forwardRef, type ReactNode } from "react";
import { Checkbox as AriaCheckbox, type CheckboxProps as AriaCheckboxProps } from "react-aria-components";

import { choiceClassName, choiceIndicatorClassName } from "./control-styles.js";
import { cn } from "../../lib/cn.js";

export interface CheckboxProps extends Omit<AriaCheckboxProps, "className" | "children"> {
  className?: string;
  children: ReactNode;
}

export const Checkbox = forwardRef<HTMLLabelElement, CheckboxProps>(function CheckboxControl(
  { children, className, ...props },
  ref,
) {
  return (
    <AriaCheckbox {...props} ref={ref} className={cn(choiceClassName, className)}>
      {({ isSelected, isIndeterminate }) => (
        <>
          <span aria-hidden="true" className={choiceIndicatorClassName}>
            {isIndeterminate ? "−" : isSelected ? "✓" : null}
          </span>
          <span>{children}</span>
        </>
      )}
    </AriaCheckbox>
  );
});
