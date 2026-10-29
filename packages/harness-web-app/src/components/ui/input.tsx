import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/cn.js";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-sm border border-edge bg-field px-3 py-1 text-sm text-ink placeholder:text-subtle",
        className,
      )}
      {...props}
    />
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextareaField({ className, ...props }, ref) {
    return (
      <textarea
        className={cn(
          "composer-field w-full resize-none rounded-sm border border-edge bg-field px-3 py-2 text-sm text-ink placeholder:text-subtle",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
