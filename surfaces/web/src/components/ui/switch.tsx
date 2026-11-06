import { forwardRef, type ReactNode } from "react";
import { Switch as AriaSwitch, type SwitchProps as AriaSwitchProps } from "react-aria-components";

import { choiceClassName } from "./control-styles.js";
import { cn } from "../../lib/cn.js";

export interface SwitchProps extends Omit<AriaSwitchProps, "className" | "children"> {
  className?: string;
  children: ReactNode;
}

export const Switch = forwardRef<HTMLLabelElement, SwitchProps>(function SwitchControl(
  { children, className, ...props },
  ref,
) {
  return (
    <AriaSwitch {...props} ref={ref} className={cn(choiceClassName, className)}>
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-8 shrink-0 items-center rounded-none border border-edge bg-field p-0.5 group-data-[selected]:border-[var(--accent)] group-data-[selected]:bg-[var(--accent)] group-data-[focus-visible]:outline-2 group-data-[focus-visible]:outline-offset-2 group-data-[focus-visible]:outline-[var(--focus)] group-data-[pressed]:brightness-90"
      >
        <span className="size-2.5 bg-muted transition-transform motion-reduce:transition-none group-data-[selected]:translate-x-4 group-data-[selected]:bg-[var(--accent-ink)]" />
      </span>
      <span>{children}</span>
    </AriaSwitch>
  );
});
