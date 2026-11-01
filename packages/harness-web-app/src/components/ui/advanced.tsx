import { forwardRef, type RefAttributes } from "react";
import {
  TokenField as AriaTokenField,
  TokenInput as AriaTokenInput,
  Token as AriaToken,
  NavigationTree as AriaNavigationTree,
  NavigationTreeItem as AriaNavigationTreeItem,
  NavigationTreeItemContent as AriaNavigationTreeItemContent,
  NavigationTreeSection as AriaNavigationTreeSection,
  NavigationTreeHeader as AriaNavigationTreeHeader,
  composeRenderProps,
  type TokenFieldValue,
  type TokenFieldProps,
  type TokenInputProps,
  type TokenProps,
  type NavigationTreeProps,
  type NavigationTreeItemProps,
  type NavigationTreeItemContentProps,
  type NavigationTreeSectionProps,
  type NavigationTreeHeaderProps,
} from "react-aria-components";

import { cn } from "../../lib/cn.js";

// These utilities have no visual surface. Virtualizer delegates appearance to its
// child collection; see the styled, bounded ListBox in the advanced stories.
export {
  Focusable,
  Pressable,
  VisuallyHidden,
  I18nProvider,
  RouterProvider,
  useFilter,
  useListData,
  useAsyncList,
  useTreeData,
  Virtualizer,
  ListLayout,
  GridLayout,
  TableLayout,
  WaterfallLayout,
  Layout,
  LayoutInfo,
  Size,
  Rect,
  Point,
  TokenFieldValue,
} from "react-aria-components";
export type {
  TokenFieldProps,
  TokenInputProps,
  TokenProps,
  NavigationTreeProps,
  NavigationTreeItemProps,
  NavigationTreeItemContentProps,
  NavigationTreeSectionProps,
  NavigationTreeHeaderProps,
  VirtualizerProps,
  ListLayoutOptions,
  GridLayoutOptions,
  TableLayoutProps,
  WaterfallLayoutOptions,
} from "react-aria-components";

const focusClassName =
  "outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)]";

// React 19 ref props retain RAC's generic value/collection inference without
// narrowing it to object through forwardRef.
export function TokenField<T extends TokenFieldValue = TokenFieldValue>({
  className,
  ...props
}: TokenFieldProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTokenField
      {...props}
      className={composeRenderProps(className, (value) =>
        cn("gp-token-field flex flex-col gap-1 text-sm text-ink data-[disabled]:opacity-50", value),
      )}
    />
  );
}

export function TokenInput<T extends TokenFieldValue = TokenFieldValue>({
  className,
  ...props
}: TokenInputProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTokenInput
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "gp-token-input min-h-10 whitespace-pre-wrap break-words rounded-none border border-edge bg-canvas px-3 py-2 text-sm text-ink data-[hovered]:border-muted data-[disabled]:cursor-not-allowed data-[readonly]:text-muted",
          focusClassName,
          value,
        ),
      )}
    />
  );
}

export const Token = forwardRef<HTMLSpanElement, TokenProps>(function TokenControl({ className, ...props }, ref) {
  return (
    <AriaToken
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "gp-token inline rounded-none border border-edge border-b-2 bg-canvas px-1 py-0.5 text-sm text-ink data-[selected]:border-b-[var(--selection-marker)] data-[selected]:bg-hover data-[disabled]:opacity-50",
          value,
        ),
      )}
    />
  );
});

export function NavigationTree<T>({ className, ...props }: NavigationTreeProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaNavigationTree
      {...props}
      className={composeRenderProps(className, (value) =>
        cn("gp-navigation-tree flex flex-col gap-1 text-sm text-ink", focusClassName, value),
      )}
    />
  );
}

export function NavigationTreeItem<T extends object>({
  className,
  ...props
}: NavigationTreeItemProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaNavigationTreeItem
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "gp-navigation-tree-item group rounded-none border-s-2 border-transparent text-sm text-ink data-[hovered]:bg-hover data-[current]:border-s-[var(--selection-marker)] data-[current]:bg-hover data-[disabled]:opacity-50",
          focusClassName,
          value,
        ),
      )}
    />
  );
}

// RAC owns the gridcell and link context. A presentation-only inner wrapper
// preserves both static children and the complete state render prop.
export function NavigationTreeItemContent({ children }: NavigationTreeItemContentProps) {
  return (
    <AriaNavigationTreeItemContent>
      {(state) => (
        <div className="gp-navigation-tree-item-content flex min-h-10 items-center gap-2 py-1 pe-3 ps-[calc((var(--tree-item-level)-1)*1rem+0.5rem)]">
          {typeof children === "function" ? children(state) : children}
        </div>
      )}
    </AriaNavigationTreeItemContent>
  );
}

export function NavigationTreeSection<T extends object>({ className, ...props }: NavigationTreeSectionProps<T>) {
  return (
    <AriaNavigationTreeSection {...props} className={cn("gp-navigation-tree-section flex flex-col gap-1", className)} />
  );
}

export function NavigationTreeHeader({ className, ...props }: NavigationTreeHeaderProps) {
  return (
    <AriaNavigationTreeHeader
      {...props}
      className={cn("gp-navigation-tree-header px-3 py-2 text-xs text-muted", className)}
    />
  );
}

// SharedElementTransition, PreviewTrigger, and Sheet are intentionally not
// promoted as styled production components here. The installed experimental
// APIs need separate transition, overlay, and anchor-semantics validation.
