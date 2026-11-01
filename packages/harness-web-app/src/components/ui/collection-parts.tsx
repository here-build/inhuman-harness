import type { ComponentProps, RefAttributes } from "react";
import * as Aria from "react-aria-components";

import { cn } from "../../lib/cn.js";

const section = "flex flex-col py-1";
const header = "px-3 py-2 font-heading text-sm text-muted";
const loading = "px-3 py-2 text-sm text-muted";

export function ListBoxSection<T>({ className, ...props }: Aria.ListBoxSectionProps<T> & RefAttributes<HTMLElement>) {
  return <Aria.ListBoxSection {...props} className={cn(section, className)} />;
}
export function GridListSection<T>({
  className,
  ...props
}: Aria.GridListSectionProps<T> & RefAttributes<HTMLDivElement>) {
  return <Aria.GridListSection {...props} className={cn(section, className)} />;
}
export function GridListHeader({ className, ...props }: Aria.GridListHeaderProps) {
  return <Aria.GridListHeader {...props} className={cn(header, className)} />;
}
export function TreeSection<T>({ className, ...props }: ComponentProps<typeof Aria.TreeSection<T>>) {
  return <Aria.TreeSection {...props} className={cn(section, className)} />;
}
export function TreeHeader({ className, ...props }: ComponentProps<typeof Aria.TreeHeader>) {
  return <Aria.TreeHeader {...props} className={cn(header, className)} />;
}

// A sentinel does not invent a percentage or animate. The caller supplies real
// loading/error content and onLoadMore; RAC owns intersection and collection state.
export function ListBoxLoadMoreItem({
  className,
  ...props
}: Aria.ListBoxLoadMoreItemProps & RefAttributes<HTMLDivElement>) {
  return <Aria.ListBoxLoadMoreItem {...props} className={cn(loading, className)} />;
}
export function GridListLoadMoreItem({
  className,
  ...props
}: Aria.GridListLoadMoreItemProps & RefAttributes<HTMLDivElement>) {
  return <Aria.GridListLoadMoreItem {...props} className={cn(loading, className)} />;
}
export function TreeLoadMoreItem<T>({ className, ...props }: ComponentProps<typeof Aria.TreeLoadMoreItem<T>>) {
  return (
    <Aria.TreeLoadMoreItem<T>
      {...props}
      className={Aria.composeRenderProps(className, (value) => cn(loading, value))}
    />
  );
}
export function MenuLoadMoreItem({ className, ...props }: Aria.MenuLoadMoreItemProps & RefAttributes<HTMLDivElement>) {
  return <Aria.MenuLoadMoreItem {...props} className={cn(loading, className)} />;
}
