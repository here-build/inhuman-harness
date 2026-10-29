import type { ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn.js";

export const buttonVariants = cva(
  "touch-target inline-flex min-h-8 items-center justify-center rounded-sm px-3 py-1 text-sm font-normal transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-ink text-canvas hover:bg-[color-mix(in_oklab,var(--ink),var(--canvas)_14%)]",
        // 14% canvas on danger falls under 4.5:1 for this text in light. 12% holds.
        danger: "bg-danger text-canvas hover:bg-[color-mix(in_oklab,var(--danger),var(--canvas)_12%)]",
        secondary: "border border-edge hover:bg-hover",
        ghost: "hover:bg-hover",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Button({
  className,
  variant,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} type={type} {...props} />;
}
