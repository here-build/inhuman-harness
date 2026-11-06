import { forwardRef, useRef, type ButtonHTMLAttributes, type KeyboardEvent } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeProps, useButton, useFocusRing, useObjectRef, type AriaButtonProps } from "react-aria";

import { cn } from "../../lib/cn.js";

export const buttonVariants = cva(
  "rounded-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)] data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)] data-[pressed]:brightness-90 disabled:pointer-events-none disabled:opacity-50 data-[busy]:cursor-wait",
  {
    variants: {
      variant: {
        default:
          "touch-target label inline-flex text-sm font-normal min-h-8 items-center justify-center gap-2 px-3 py-1 bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[color-mix(in_oklab,var(--accent),var(--canvas)_12%)]",
        danger:
          "touch-target label inline-flex text-sm font-normal min-h-8 items-center justify-center gap-2 px-3 py-1 bg-danger text-canvas hover:bg-[color-mix(in_oklab,var(--danger),var(--canvas)_12%)]",
        secondary:
          "touch-target label inline-flex text-sm font-normal min-h-8 items-center justify-center gap-2 px-3 py-1 border border-edge hover:bg-hover",
        ghost:
          "touch-target label inline-flex text-sm font-normal min-h-8 items-center justify-center gap-2 px-3 py-1 hover:bg-hover",
        content: "",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    onPress?: AriaButtonProps["onPress"];
    isBusy?: boolean;
  };

// Keep native events and form/popover attributes: existing callers use onClick,
// submit buttons, and refs. useButton normalizes press/keyboard behavior instead
// of changing this public surface to RAC's event API.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function ButtonControl(
  {
    className,
    variant,
    type = "button",
    disabled = false,
    isBusy = false,
    onPress,
    onClick,
    onKeyDown,
    onKeyUp,
    tabIndex,
    ...props
  },
  forwardedRef,
) {
  const ref = useObjectRef(forwardedRef);
  const keyboardClickSuppressed = useRef(false);
  const isDisabled = disabled || isBusy;
  const { buttonProps, isPressed } = useButton(
    {
      type,
      isDisabled,
      onPressStart(event) {
        event.continuePropagation();
      },
      onPressEnd(event) {
        event.continuePropagation();
      },
      onPress(event) {
        event.continuePropagation();
        onPress?.(event);
        // Restore only keyboard clicks suppressed by useButton. A native click
        // during the press reaches onClick without re-entering onPress. macOS
        // Enter and submit/reset buttons retain their browser default activation.
        if (event.pointerType === "keyboard" && type === "button" && keyboardClickSuppressed.current) {
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) {
            ref.current?.dispatchEvent(
              new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                altKey: event.altKey,
                metaKey: event.metaKey,
              }),
            );
          } else {
            ref.current?.click();
          }
        }
      },
    },
    ref,
  );
  const { focusProps, isFocusVisible } = useFocusRing();
  return (
    <button
      {...mergeProps(props, buttonProps, focusProps, {
        tabIndex,
        onClick: isDisabled ? undefined : onClick,
      })}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) {
          keyboardClickSuppressed.current = false;
          return;
        }
        buttonProps.onKeyDown?.(event);
        if (event.key === "Enter" || event.key === " ") {
          keyboardClickSuppressed.current = event.defaultPrevented;
        }
      }}
      onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => {
        onKeyUp?.(event);
        if (!event.defaultPrevented) buttonProps.onKeyUp?.(event);
      }}
      ref={ref}
      className={cn(buttonVariants({ variant }), className)}
      aria-busy={isBusy ? true : props["aria-busy"]}
      data-busy={isBusy || undefined}
      data-disabled={disabled || isBusy || undefined}
      data-pressed={isPressed || undefined}
      data-focus-visible={isFocusVisible || undefined}
    />
  );
});
