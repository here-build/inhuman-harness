import { forwardRef, type ComponentPropsWithoutRef, type RefAttributes } from "react";
import {
  Link as AriaLink,
  Breadcrumbs as AriaBreadcrumbs,
  Breadcrumb as AriaBreadcrumb,
  Disclosure as AriaDisclosure,
  DisclosureGroup as AriaDisclosureGroup,
  DisclosurePanel as AriaDisclosurePanel,
  Toolbar as AriaToolbar,
  Separator as AriaSeparator,
  Heading as AriaHeading,
  Text as AriaText,
  Keyboard as AriaKeyboard,
  Button as AriaButton,
  composeRenderProps,
  type LinkProps,
  type BreadcrumbsProps,
  type BreadcrumbProps,
  type DisclosureProps,
  type DisclosureGroupProps,
  type DisclosurePanelProps,
  type ToolbarProps,
  type SeparatorProps,
  type HeadingProps,
  type TextProps,
  type ButtonProps,
} from "react-aria-components";

import { cn } from "../../lib/cn.js";

export interface SystemLinkProps extends LinkProps {
  title?: string;
  /** Commands/navigation are symbols; linked object names remain content. */
  isCommand?: boolean;
}

export const Link = forwardRef<HTMLAnchorElement, SystemLinkProps>(function LinkControl(
  { className, isCommand = false, ...props },
  ref,
) {
  return (
    <AriaLink
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "cursor-pointer text-ink underline underline-offset-4 outline-none data-[hovered]:text-ink data-[current]:text-ink data-[current]:no-underline data-[pressed]:opacity-80 data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)] data-[disabled]:cursor-default data-[disabled]:opacity-50",
          isCommand && "label",
          value,
        ),
      )}
    />
  );
});

// Keep the collection item type inferred, including function children and render overrides.
export function Breadcrumbs<T>({ className, ...props }: BreadcrumbsProps<T> & RefAttributes<HTMLOListElement>) {
  return <AriaBreadcrumbs {...props} className={cn("flex flex-wrap items-center gap-2 text-sm", className)} />;
}

export const Breadcrumb = forwardRef<HTMLLIElement, BreadcrumbProps>(function BreadcrumbControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaBreadcrumb
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex items-center gap-2 text-muted after:text-muted after:content-['/'] last:after:hidden data-[current]:text-ink",
          value,
        ),
      )}
    />
  );
});

export const Disclosure = forwardRef<HTMLDivElement, DisclosureProps>(function DisclosureControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDisclosure
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) => cn("border-b border-edge py-2", value))}
    />
  );
});

export const DisclosureGroup = forwardRef<HTMLDivElement, DisclosureGroupProps>(function DisclosureGroupControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDisclosureGroup
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) => cn("flex flex-col", value))}
    />
  );
});

export const DisclosurePanel = forwardRef<HTMLDivElement, DisclosurePanelProps>(function DisclosurePanelControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaDisclosurePanel
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn("px-3 py-2 text-sm text-ink data-[focus-visible-within]:outline-[var(--focus)]", value),
      )}
    />
  );
});

// RAC's button context connects disclosure, file, toast, and tooltip triggers.
// The app's native Button deliberately retains a different, native event API.
export const FieldButton = forwardRef<HTMLButtonElement, ButtonProps>(function FieldButtonControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaButton
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "label touch-target inline-flex min-h-8 items-center justify-center gap-2 rounded-none border border-edge px-3 py-1 text-sm outline-none data-[hovered]:bg-hover data-[pressed]:bg-hover data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[pending]:cursor-wait",
          value,
        ),
      )}
    />
  );
});

export const Toolbar = forwardRef<HTMLDivElement, ToolbarProps>(function ToolbarControl({ className, ...props }, ref) {
  return (
    <AriaToolbar
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex flex-wrap items-center gap-2 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-start",
          value,
        ),
      )}
    />
  );
});

export const Separator = forwardRef<HTMLElement, SeparatorProps>(function SeparatorControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaSeparator
      {...props}
      ref={ref}
      className={cn(
        "shrink-0 border-0 bg-edge",
        props.orientation === "vertical" ? "mx-1 h-5 w-px" : "my-2 h-px w-full",
        className,
      )}
    />
  );
});

export const Heading = forwardRef<HTMLHeadingElement, HeadingProps>(function HeadingControl(
  { className, ...props },
  ref,
) {
  return <AriaHeading {...props} ref={ref} className={cn("text-xl font-normal leading-tight", className)} />;
});

export const Text = forwardRef<HTMLElement, TextProps>(function TextControl({ className, ...props }, ref) {
  return <AriaText {...props} ref={ref} className={cn("text-sm leading-relaxed", className)} />;
});

export const Keyboard: typeof AriaKeyboard = forwardRef<HTMLElement, ComponentPropsWithoutRef<typeof AriaKeyboard>>(
  function KeyboardControl({ className, ...props }, ref) {
    return <AriaKeyboard {...props} ref={ref} className={cn("font-mono text-xs text-muted", className)} />;
  },
);
