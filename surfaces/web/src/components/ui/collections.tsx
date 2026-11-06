import type { RefAttributes } from "react";
import {
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  ListBoxSection as AriaSection,
  Header as AriaHeader,
  Separator as AriaSeparator,
  GridList as AriaGridList,
  GridListItem as AriaGridListItem,
  Table as AriaTable,
  TableHeader as AriaTableHeader,
  TableBody as AriaTableBody,
  Column as AriaColumn,
  Row as AriaRow,
  Cell as AriaCell,
  Tree as AriaTree,
  TreeItem as AriaTreeItem,
  TreeItemContent as AriaTreeItemContent,
  TagGroup as AriaTagGroup,
  TagList as AriaTagList,
  Tag as AriaTag,
  SelectionIndicator as AriaSelectionIndicator,
  DropIndicator as AriaDropIndicator,
  composeRenderProps,
  type ListBoxProps,
  type ListBoxItemProps,
  type ListBoxSectionProps as SectionProps,
  type HeaderProps,
  type SeparatorProps,
  type GridListProps,
  type GridListItemProps,
  type TableProps,
  type TableHeaderProps,
  type TableBodyProps,
  type ColumnProps,
  type RowProps,
  type CellProps,
  type TreeProps,
  type TreeItemProps,
  type TreeItemContentProps as AriaTreeItemContentProps,
  type TreeItemContentRenderProps,
  type TagGroupProps,
  type TagListProps,
  type TagProps,
  type SelectionIndicatorProps,
  type DropIndicatorProps,
} from "react-aria-components";

import { cn } from "../../lib/cn.js";

export { Collection, SharedElementTransition, useDragAndDrop } from "react-aria-components";
export type { DragAndDropHooks, DragAndDropOptions, Key, Selection, SortDescriptor } from "react-aria-components";

const focus =
  "outline-none data-[focus-visible]:outline-solid data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)]";
const collection = "rounded-none bg-field font-sans text-sm text-ink normal-case tabular-nums";
const item =
  "min-h-9 cursor-default rounded-none border-l-2 border-transparent px-3 py-2 font-sans text-sm normal-case tabular-nums data-[hovered]:bg-hover data-[selected]:border-[var(--selection-marker)] data-[selected]:bg-selected data-[selected]:text-ink data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[dragging]:opacity-50 data-[drop-target]:outline-solid data-[drop-target]:outline-2 data-[drop-target]:outline-[var(--focus)]";

// React 19 ref props keep each collection's item type inferred without a forwardRef cast.
export function ListBox<T>({ className, ...props }: ListBoxProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaListBox
      {...props}
      className={composeRenderProps(className, (value) => cn(collection, focus, "overflow-auto", value))}
    />
  );
}

export function ListBoxItem<T = object>({ className, ...props }: ListBoxItemProps<T> & RefAttributes<HTMLDivElement>) {
  return <AriaListBoxItem {...props} className={composeRenderProps(className, (value) => cn(item, focus, value))} />;
}

export function Section<T>({ className, ...props }: SectionProps<T> & RefAttributes<HTMLElement>) {
  return <AriaSection {...props} className={cn("py-1", className)} />;
}

export function Header({ className, ...props }: HeaderProps & RefAttributes<HTMLElement>) {
  return (
    <AriaHeader
      {...props}
      className={cn("px-3 py-2 font-heading text-sm [font-weight:620] text-muted normal-case", className)}
    />
  );
}

export function Separator({ className, ...props }: SeparatorProps & RefAttributes<HTMLElement>) {
  return (
    <AriaSeparator
      {...props}
      className={cn(
        "my-1 h-px border-0 bg-line aria-[orientation=vertical]:mx-2 aria-[orientation=vertical]:my-0 aria-[orientation=vertical]:h-auto aria-[orientation=vertical]:w-px aria-[orientation=vertical]:self-stretch",
        className,
      )}
    />
  );
}

export function GridList<T>({ className, ...props }: GridListProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaGridList
      {...props}
      className={composeRenderProps(className, (value) => cn(collection, focus, "overflow-auto", value))}
    />
  );
}

export function GridListItem<T = object>({
  className,
  ...props
}: GridListItemProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaGridListItem
      {...props}
      className={composeRenderProps(className, (value) => cn(item, focus, "flex items-center gap-3", value))}
    />
  );
}

export function Table({ className, ...props }: TableProps & RefAttributes<HTMLDivElement | HTMLTableElement>) {
  return (
    <AriaTable
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(collection, focus, "w-full border-collapse text-left", value),
      )}
    />
  );
}

export function TableHeader<T>({
  className,
  ...props
}: TableHeaderProps<T> & RefAttributes<HTMLDivElement | HTMLTableSectionElement>) {
  return <AriaTableHeader {...props} className={cn("border-b border-edge bg-wash text-muted", className)} />;
}

export function TableBody<T>({
  className,
  ...props
}: TableBodyProps<T> & RefAttributes<HTMLDivElement | HTMLTableSectionElement>) {
  return <AriaTableBody {...props} className={composeRenderProps(className, (value) => cn("align-top", value))} />;
}

export function Column({
  className,
  children,
  ...props
}: ColumnProps & RefAttributes<HTMLDivElement | HTMLTableCellElement>) {
  return (
    <AriaColumn
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          focus,
          "px-3 py-2 text-left font-sans [font-weight:620] normal-case tabular-nums data-[allows-sorting]:cursor-pointer data-[hovered]:bg-hover",
          value,
        ),
      )}
    >
      {composeRenderProps(children, (content, { allowsSorting, sortDirection }) => (
        <>
          {content}
          {allowsSorting && (
            <span aria-hidden="true" className="ml-2 inline-block w-3 text-muted">
              {sortDirection === "ascending" ? "↑" : sortDirection === "descending" ? "↓" : "↕"}
            </span>
          )}
        </>
      ))}
    </AriaColumn>
  );
}

export function Row<T>({ className, ...props }: RowProps<T> & RefAttributes<HTMLDivElement | HTMLTableRowElement>) {
  return (
    <AriaRow
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          focus,
          "border-b border-line font-sans normal-case tabular-nums data-[hovered]:bg-hover data-[selected]:bg-selected [&[data-selected]>:first-child]:shadow-[inset_2px_0_0_var(--selection-marker)] data-[disabled]:opacity-50 data-[dragging]:opacity-50 data-[drop-target]:outline-solid data-[drop-target]:outline-2 data-[drop-target]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
}

export function Cell({ className, ...props }: CellProps & RefAttributes<HTMLDivElement | HTMLTableCellElement>) {
  return (
    <AriaCell
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(focus, "px-3 py-2 font-sans text-sm normal-case tabular-nums", value),
      )}
    />
  );
}

export function Tree<T>({ className, ...props }: TreeProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTree
      {...props}
      className={composeRenderProps(className, (value) => cn(collection, focus, "overflow-auto", value))}
    />
  );
}

export function TreeItem<T = object>({ className, ...props }: TreeItemProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTreeItem {...props} className={composeRenderProps(className, (value) => cn(item, focus, "p-0", value))} />
  );
}

export interface TreeItemContentProps extends AriaTreeItemContentProps {
  className?: string | ((values: TreeItemContentRenderProps) => string);
}

// RAC's content node has no DOM of its own. Put layout and the ref on its visible content.
export function TreeItemContent({ children, className, ref }: TreeItemContentProps & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTreeItemContent>
      {(values) => (
        <div
          ref={ref}
          className={cn(
            "flex min-h-9 items-center gap-2 py-2 pr-3 pl-[calc((var(--tree-item-level)_-_1)*1rem_+_0.75rem)]",
            typeof className === "function" ? className(values) : className,
          )}
        >
          {typeof children === "function" ? children(values) : children}
        </div>
      )}
    </AriaTreeItemContent>
  );
}

export function TagGroup({ className, ...props }: TagGroupProps & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTagGroup {...props} className={cn("flex flex-col gap-2 font-sans text-sm text-ink normal-case", className)} />
  );
}

export function TagList<T>({ className, ...props }: TagListProps<T> & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTagList
      {...props}
      className={composeRenderProps(className, (value) => cn(focus, "flex flex-wrap gap-2", value))}
    />
  );
}

export function Tag({ className, ...props }: TagProps & RefAttributes<HTMLDivElement>) {
  return (
    <AriaTag
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          item,
          focus,
          "inline-flex items-center gap-2 border border-edge bg-wash px-2 py-1 data-[selected]:border-[var(--selection-marker)] data-[selected]:shadow-[inset_2px_0_0_var(--selection-marker)]",
          value,
        ),
      )}
    />
  );
}

export function SelectionIndicator({ className, ...props }: SelectionIndicatorProps & RefAttributes<HTMLDivElement>) {
  return (
    <AriaSelectionIndicator
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-none bg-selection-marker motion-reduce:transition-none motion-reduce:animate-none",
          value,
        ),
      )}
    />
  );
}

export function DropIndicator({ className, ...props }: DropIndicatorProps & RefAttributes<HTMLElement>) {
  return (
    <AriaDropIndicator
      {...props}
      className={composeRenderProps(className, (value) =>
        cn(
          "relative h-0.5 list-none bg-transparent outline-none data-[drop-target]:bg-selection-marker data-[drop-target]:outline-solid data-[drop-target]:outline-2 data-[drop-target]:outline-[var(--focus)]",
          value,
        ),
      )}
    />
  );
}
