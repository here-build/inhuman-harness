import { forwardRef } from "react";
import {
  Tabs as AriaTabs,
  TabList as AriaTabList,
  Tab as AriaTab,
  TabPanel as AriaTabPanel,
  composeRenderProps,
  type TabsProps,
  type TabListProps,
  type TabProps,
  type TabPanelProps,
} from "react-aria-components";

import { cn } from "../../lib/cn.js";

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function TabsControl({ className, ...props }, ref) {
  return (
    <AriaTabs
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn("flex flex-col gap-3 data-[orientation=vertical]:flex-row", value),
      )}
    />
  );
});

export const TabList = forwardRef<HTMLDivElement, TabListProps<object>>(function TabListControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaTabList
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "flex gap-1 border-b border-edge data-[orientation=vertical]:flex-col data-[orientation=vertical]:border-r data-[orientation=vertical]:border-b-0",
          value,
        ),
      )}
    />
  );
});

export const Tab = forwardRef<HTMLDivElement, TabProps>(function TabControl({ className, ...props }, ref) {
  return (
    <AriaTab
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "label touch-target cursor-pointer rounded-none border-b-2 border-transparent px-3 py-2 text-muted outline-none data-[selected]:border-[var(--selection-marker)] data-[selected]:text-ink data-[hovered]:bg-hover data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          value,
        ),
      )}
    />
  );
});

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(function TabPanelControl(
  { className, ...props },
  ref,
) {
  return (
    <AriaTabPanel
      {...props}
      ref={ref}
      className={composeRenderProps(className, (value) =>
        cn(
          "text-sm outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
});
