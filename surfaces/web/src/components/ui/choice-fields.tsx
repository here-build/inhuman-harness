import { forwardRef, type ComponentProps } from "react";
import {
  CheckboxField as AriaCheckboxField,
  CheckboxButton as AriaCheckboxButton,
  RadioField as AriaRadioField,
  RadioButton as AriaRadioButton,
  SwitchField as AriaSwitchField,
  SwitchButton as AriaSwitchButton,
  composeRenderProps,
} from "react-aria-components";

import { choiceClassName, choiceIndicatorClassName } from "./control-styles.js";
import { cn } from "../../lib/cn.js";

// RAC 1.22 separates field semantics (description/validation) from its clickable
// label. Keep these composable alongside the existing convenience controls.
const fieldClassName = "flex flex-col items-start gap-1 text-sm data-[disabled]:opacity-50";

export const CheckboxField = forwardRef<HTMLDivElement, ComponentProps<typeof AriaCheckboxField>>(
  function CheckboxFieldControl({ className, ...props }, ref) {
    return (
      <AriaCheckboxField
        {...props}
        ref={ref}
        className={composeRenderProps(className, (value) => cn(fieldClassName, value))}
      />
    );
  },
);
export const RadioField = forwardRef<HTMLDivElement, ComponentProps<typeof AriaRadioField>>(function RadioFieldControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaRadioField
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) => cn(fieldClassName, value))}
    />
  );
});
export const SwitchField = forwardRef<HTMLDivElement, ComponentProps<typeof AriaSwitchField>>(
  function SwitchFieldControl({ className, ...props }, ref) {
    return (
      <AriaSwitchField
        {...props}
        ref={ref}
        className={composeRenderProps(className, (value) => cn(fieldClassName, value))}
      />
    );
  },
);

export const CheckboxButton = forwardRef<HTMLLabelElement, ComponentProps<typeof AriaCheckboxButton>>(
  function CheckboxButtonControl({ children, className, ...props }, ref) {
    return (
      <AriaCheckboxButton
        {...props}
        ref={ref}
        className={composeRenderProps(className, (value) => cn(choiceClassName, value))}
      >
        {composeRenderProps(children, (content, state) => (
          <>
            <span aria-hidden="true" className={choiceIndicatorClassName}>
              {state.isIndeterminate ? "−" : state.isSelected ? "✓" : null}
            </span>
            <span>{content}</span>
          </>
        ))}
      </AriaCheckboxButton>
    );
  },
);
export const RadioButton = forwardRef<HTMLLabelElement, ComponentProps<typeof AriaRadioButton>>(
  function RadioButtonControl({ children, className, ...props }, ref) {
    return (
      <AriaRadioButton
        {...props}
        ref={ref}
        className={composeRenderProps(className, (value) => cn(choiceClassName, value))}
      >
        {composeRenderProps(children, (content) => (
          <>
            <span aria-hidden="true" className={cn(choiceIndicatorClassName, "rounded-full")}>
              <span className="size-2 rounded-full bg-current opacity-0 group-data-[selected]:opacity-100" />
            </span>
            <span>{content}</span>
          </>
        ))}
      </AriaRadioButton>
    );
  },
);
export const SwitchButton = forwardRef<HTMLLabelElement, ComponentProps<typeof AriaSwitchButton>>(
  function SwitchButtonControl({ children, className, ...props }, ref) {
    return (
      <AriaSwitchButton
        {...props}
        ref={ref}
        className={composeRenderProps(className, (value) => cn(choiceClassName, value))}
      >
        {composeRenderProps(children, (content) => (
          <>
            <span
              aria-hidden="true"
              className="inline-flex h-5 w-9 shrink-0 items-center border border-edge bg-field p-px group-data-[selected]:border-[var(--accent)] group-data-[selected]:bg-[var(--accent)] group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-[var(--focus)]"
            >
              <span className="h-3.5 w-3.5 bg-muted group-data-[selected]:translate-x-4 group-data-[selected]:bg-[var(--accent-ink)]" />
            </span>
            <span>{content}</span>
          </>
        ))}
      </AriaSwitchButton>
    );
  },
);
