import { forwardRef, type ReactNode } from "react";
import {
  FieldError,
  Label,
  Radio as AriaRadio,
  RadioGroup as AriaRadioGroup,
  Text,
  type RadioProps as AriaRadioProps,
  type RadioGroupProps as AriaRadioGroupProps,
  type ValidationResult,
} from "react-aria-components";

import { choiceClassName, choiceIndicatorClassName } from "./control-styles.js";
import { cn } from "../../lib/cn.js";

export interface RadioGroupProps extends Omit<AriaRadioGroupProps, "className" | "children"> {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode | ((validation: ValidationResult) => ReactNode);
  className?: string;
  children: ReactNode;
}

export const RadioGroup = forwardRef<HTMLDivElement, RadioGroupProps>(function RadioGroupControl(
  { label, description, errorMessage, className, children, ...props },
  ref,
) {
  return (
    <AriaRadioGroup {...props} ref={ref} className={cn("flex flex-col gap-1 text-sm", className)}>
      <Label className="text-sm text-ink">{label}</Label>
      {description != null && (
        <Text slot="description" className="text-xs text-muted">
          {description}
        </Text>
      )}
      <div className={cn("flex gap-2", props.orientation === "horizontal" ? "flex-row" : "flex-col")}>{children}</div>
      <FieldError className="text-xs text-danger">{errorMessage}</FieldError>
    </AriaRadioGroup>
  );
});

export interface RadioProps extends Omit<AriaRadioProps, "className" | "children"> {
  className?: string;
  children: ReactNode;
}

export const Radio = forwardRef<HTMLLabelElement, RadioProps>(function RadioControl(
  { children, className, ...props },
  ref,
) {
  return (
    <AriaRadio {...props} ref={ref} className={cn(choiceClassName, className)}>
      <span aria-hidden="true" className={choiceIndicatorClassName}>
        <span className="size-2 bg-current opacity-0 group-data-[selected]:opacity-100" />
      </span>
      <span>{children}</span>
    </AriaRadio>
  );
});
