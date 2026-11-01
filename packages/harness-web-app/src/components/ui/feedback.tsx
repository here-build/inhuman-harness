import { forwardRef, type ComponentPropsWithoutRef, type RefAttributes } from "react";
import {
  Dialog as AriaDialog,
  DropZone as AriaDropZone,
  UNSTABLE_Toast as AriaToast,
  UNSTABLE_ToastRegion as AriaToastRegion,
  UNSTABLE_ToastContent as AriaToastContent,
  composeRenderProps,
  type DialogProps,
  type DropZoneProps,
  type ToastProps,
  type ToastRegionProps,
} from "react-aria-components";

import { cn } from "../../lib/cn.js";

// These are semantic/interaction contexts, not positioned overlays. FileTrigger
// styles its visible pressable child (FieldButton), not the hidden file input.
export { FileTrigger, TooltipTrigger } from "react-aria-components";

// RAC 1.22 exposes toast APIs only under UNSTABLE names. Keep that dependency
// explicit here while providing the same typed queue and content API to callers.
export { UNSTABLE_ToastQueue as ToastQueue } from "react-aria-components";

// Standalone semantics only: the native <dialog> adapter owns showModal, Escape,
// backdrop dismissal and focus restoration. RAC Modal/ModalOverlay would install
// another portal/focus owner and are deliberately not exported here.
export const Dialog = forwardRef<HTMLElement, DialogProps>(function DialogControl({ className, ...props }, ref) {
  return (
    <AriaDialog
      {...props}
      ref={ref}
      className={cn("flex flex-col gap-4 rounded-none bg-canvas p-6 text-ink outline-none", className)}
    />
  );
});

export const DropZone = forwardRef<HTMLDivElement, DropZoneProps>(function DropZoneControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDropZone
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex flex-col items-start gap-3 rounded-none border border-dashed border-edge bg-field p-4 text-sm text-ink outline-none data-[hovered]:bg-hover data-[drop-target]:border-[var(--accent)] data-[drop-target]:bg-hover data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)] data-[disabled]:opacity-50",
          value,
        ),
      )}
    />
  );
});

export function ToastRegion<T>({ className, ...props }: ToastRegionProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaToastRegion
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex flex-col gap-2 outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
}

export function Toast<T>({ className, ...props }: ToastProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaToast
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex items-start justify-between gap-4 rounded-none border border-edge bg-canvas p-4 text-sm text-ink outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
}

export const ToastContent: typeof AriaToastContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof AriaToastContent>
>(function ToastContentControl({ className, ...props }, ref) {
  return <AriaToastContent {...props} ref={ref} className={cn("flex flex-col gap-1", className)} />;
});
