import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Input as AriaInput, TextArea as AriaTextArea } from "react-aria-components";

import { cn } from "../../lib/cn.js";

export const fieldControlClassName =
  "w-full rounded-none border border-edge bg-field px-3 py-1 text-sm text-ink placeholder:text-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger data-[invalid]:border-danger";

// These low-level controls deliberately retain the entire native input API
// (including non-text types and native ChangeEvents). Use TextField for a
// persistently labeled text input with RAC description/validation wiring.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function InputControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaInput
      {...props}
      ref={ref}
      className={cn(fieldControlClassName, "flex h-9", className)}
      data-disabled={props.disabled ? true : undefined}
      data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true" || undefined}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextareaField({ className, ...props }, ref) {
    return (
      <AriaTextArea
        {...props}
        ref={ref}
        className={cn(fieldControlClassName, "composer-field resize-none py-2", className)}
        data-disabled={props.disabled ? true : undefined}
        data-invalid={props["aria-invalid"] === true || props["aria-invalid"] === "true" || undefined}
      />
    );
  },
);
