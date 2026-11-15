import { forwardRef } from "react";
import {
  Tab as AriaTab,
  TabList as AriaTabList,
  TabPanel as AriaTabPanel,
  Tabs as AriaTabs,
  composeRenderProps,
  type TabListProps,
  type TabPanelProps,
  type TabProps,
  type TabsProps,
} from "react-aria-components";

import { cn } from "../lib/cn.js";

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function TabsControl({ className, ...props }, ref) {
  return (
    <AriaTabs
      {...props}
      ref={ref}
      data-ui="tabs"
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
      data-ui="tab-list"
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
      data-ui="tab"
      className={composeRenderProps(className, (value) =>
        cn(
          "label touch-target cursor-pointer rounded-[var(--radius-sm)] px-3 py-2 text-muted outline-none data-[selected]:bg-[var(--selected)] data-[selected]:font-semibold data-[selected]:text-ink data-[hovered]:bg-hover data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
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
      data-ui="tab-panel"
      className={composeRenderProps(className, (value) =>
        cn(
          "text-sm outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-2 data-[focus-visible]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
});
