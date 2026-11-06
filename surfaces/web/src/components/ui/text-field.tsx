import { forwardRef, type ComponentProps, type ReactNode } from "react";
import {
  FieldError,
  Input as AriaInput,
  Label,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
  type ValidationResult,
} from "react-aria-components";

import { fieldControlClassName } from "./input.js";
import { cn } from "../../lib/cn.js";

export interface TextFieldProps extends Omit<AriaTextFieldProps, "children" | "className" | "spellCheck"> {
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode | ((validation: ValidationResult) => ReactNode);
  placeholder?: string;
  spellCheck?: ComponentProps<typeof AriaInput>["spellCheck"];
  className?: string;
  inputClassName?: string;
  multiline?: boolean;
  rows?: number;
}

// RAC owns the input's name, value, validation, and aria-describedby links.
// Labels are always present; placeholders are hints, not replacements.
export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(function TextFieldControl(
  {
    label,
    description,
    errorMessage,
    placeholder,
    spellCheck,
    className,
    inputClassName,
    multiline,
    rows = 3,
    ...props
  },
  ref,
) {
  return (
    <AriaTextField {...props} className={cn("flex flex-col gap-1 text-sm data-[disabled]:opacity-50", className)}>
      <Label className="text-sm text-ink">{label}</Label>
      {multiline ? (
        <AriaTextArea
          ref={ref as ComponentProps<typeof AriaTextArea>["ref"]}
          className={cn(fieldControlClassName, "resize-y py-2", inputClassName)}
          placeholder={placeholder}
          spellCheck={spellCheck}
          rows={rows}
        />
      ) : (
        <AriaInput
          ref={ref as ComponentProps<typeof AriaInput>["ref"]}
          className={cn(fieldControlClassName, "h-9", inputClassName)}
          placeholder={placeholder}
          spellCheck={spellCheck}
        />
      )}
      {description != null && (
        <Text slot="description" className="text-xs text-muted">
          {description}
        </Text>
      )}
      <FieldError className="text-xs text-danger">{errorMessage}</FieldError>
    </AriaTextField>
  );
});
