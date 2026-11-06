// @vitest-environment happy-dom

import { act, createElement as h, createRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "react-aria-components";
import { userEvent, within } from "storybook/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ListBox,
  ListBoxItem,
  Section,
  Header,
  Separator,
  GridList,
  GridListItem,
  Table,
  TableHeader,
  TableBody,
  Column,
  Row,
  Cell,
  Tree,
  TreeItem,
  TreeItemContent,
  TagGroup,
  TagList,
  Tag,
  SelectionIndicator,
  DropIndicator,
  Collection,
  useDragAndDrop,
  SharedElementTransition,
  type SortDescriptor,
} from "../components/ui/collections.js";

let container: HTMLDivElement;
let root: Root;
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  user = userEvent.setup({ document });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => root.render(node));
}

async function interact(action: () => unknown) {
  await act(async () => {
    await action();
  });
}

const projects = [
  { id: "launch", name: "Autumn campaign launch", tasks: 24 },
  { id: "research", name: "Customer research", tasks: 8 },
  { id: "archive", name: "Archived projects", tasks: 120 },
];
type Project = (typeof projects)[number];

function expectFocusStyle(element: HTMLElement) {
  expect(element.className).toContain("data-[focus-visible]:outline-[var(--focus)]");
  expect(element.className).toContain("data-[focus-visible]:outline-solid");
}

function expectSelectionStyle(element: HTMLElement) {
  expect(element.className).toContain("data-[selected]:bg-selected");
  expect(element.className).toContain("var(--selection-marker)");
  expect(element.className).not.toContain("bg-accent");
  expect(element.className).not.toContain("bg-[var(--accent)]");
  expect(element.className).not.toContain("label");
}

describe("ListBox", () => {
  it("preserves typed item callbacks, item render props, refs, and className state", async () => {
    const listRef = createRef<HTMLDivElement>();
    const itemRef = createRef<HTMLDivElement>();
    const className = vi.fn(({ isSelected }: { isSelected: boolean }) => (isSelected ? "chosen" : "available"));
    await render(
      h(ListBox<Project>, {
        ref: listRef,
        "aria-label": "Projects",
        items: projects,
        selectionMode: "multiple",
        defaultSelectedKeys: ["launch"],
        className: ({ isEmpty }) => (isEmpty ? "empty" : "populated"),
        children: (project) =>
          h(ListBoxItem<Project>, {
            id: project.id,
            value: project,
            ref: project.id === "launch" ? itemRef : undefined,
            textValue: project.name,
            className,
            children: ({ isSelected }) => `${project.name}${isSelected ? " selected" : ""}`,
          }),
      }),
    );
    const list = within(container).getByRole("listbox", { name: "Projects" });
    const option = within(list).getByRole("option", { name: "Autumn campaign launch selected" });
    expect(listRef.current).toBe(list);
    expect(itemRef.current).toBe(option);
    expect(list.className).toContain("populated");
    expect(option.className).toContain("chosen");
    expect(className).toHaveBeenCalledWith(expect.objectContaining({ isSelected: true }));
    expectSelectionStyle(option);
    expectFocusStyle(option);
    expect(list.className).toContain("tabular-nums");
  });

  it("selects with Space, navigates with arrows and typeahead, and skips disabled items", async () => {
    const onSelectionChange = vi.fn();
    await render(
      h(ListBox<Project>, {
        "aria-label": "Projects",
        items: projects,
        selectionMode: "multiple",
        disabledKeys: ["research"],
        onSelectionChange,
        children: (project) => h(ListBoxItem, { id: project.id }, project.name),
      }),
    );
    await interact(() => user.tab());
    const launch = within(container).getByRole("option", { name: "Autumn campaign launch" });
    expect(document.activeElement).toBe(launch);
    expect(Object.hasOwn(launch.dataset, "focusVisible")).toBe(true);
    await interact(() => user.keyboard(" "));
    expect(launch.getAttribute("aria-selected")).toBe("true");
    expect([...(onSelectionChange.mock.lastCall?.[0] ?? [])]).toEqual(["launch"]);
    await interact(() => user.keyboard("{ArrowDown} "));
    const archive = within(container).getByRole("option", { name: "Archived projects" });
    expect(document.activeElement).toBe(archive);
    expect(archive.getAttribute("aria-selected")).toBe("true");
    const disabled = within(container).getByRole("option", { name: "Customer research" });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("aria-selected")).not.toBe("true");
    await interact(() => user.keyboard("aut"));
    expect(document.activeElement).toBe(launch);
  });

  it("styles section headers and separators and forwards their refs", async () => {
    const section = createRef<HTMLElement>();
    const header = createRef<HTMLElement>();
    const separator = createRef<HTMLElement>();
    await render(
      h(
        ListBox,
        { "aria-label": "Projects" },
        h(
          Section,
          { ref: section, className: "project-section" },
          h(Header, { ref: header, className: "project-heading" }, "Current work"),
          h(ListBoxItem, { id: "launch" }, "Autumn campaign launch"),
        ),
        h(Separator, { ref: separator, className: "project-divider" }),
        h(ListBoxItem, { id: "research" }, "Customer research"),
      ),
    );
    expect(section.current?.className).toContain("py-1");
    expect(section.current?.className).toContain("project-section");
    expect(header.current?.textContent).toBe("Current work");
    expect(header.current?.className).toContain("font-heading");
    expect(separator.current?.className).toContain("bg-line");
    expect(separator.current?.className).toContain("project-divider");
  });

  it("preserves empty-state callbacks", async () => {
    await render(
      h(ListBox<Project>, {
        "aria-label": "Projects",
        items: [],
        renderEmptyState: ({ isEmpty }) => h("p", null, isEmpty ? "No projects yet." : "Projects"),
        children: (project) => h(ListBoxItem, null, project.name),
      }),
    );
    expect(within(container).getByRole("listbox").textContent).toBe("No projects yet.");
  });
});

describe("GridList", () => {
  it("preserves row selection, typed render callbacks, refs, and interactive children", async () => {
    const listRef = createRef<HTMLDivElement>();
    const itemRef = createRef<HTMLDivElement>();
    const onOpen = vi.fn();
    await render(
      h(GridList<Project>, {
        ref: listRef,
        "aria-label": "Projects",
        selectionMode: "multiple",
        items: projects.slice(0, 1),
        className: ({ isEmpty }) => (isEmpty ? "empty-grid" : "project-grid"),
        children: (project) =>
          h(GridListItem<Project>, {
            ref: itemRef,
            value: project,
            id: project.id,
            textValue: project.name,
            className: ({ isSelected }) => (isSelected ? "selected-row" : "unselected-row"),
            children: ({ isSelected }) =>
              h(
                "div",
                null,
                `${project.name}${isSelected ? " selected" : ""}`,
                h(Button, { onPress: onOpen }, "Open project"),
              ),
          }),
      }),
    );
    const grid = within(container).getByRole("grid", { name: "Projects" });
    const row = within(grid).getByRole("row");
    expect(listRef.current).toBe(grid);
    expect(itemRef.current).toBe(row);
    await interact(() => user.tab());
    await interact(() => user.keyboard(" "));
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.className).toContain("selected-row");
    expectSelectionStyle(row);
    expectFocusStyle(row);
    await interact(() => user.click(within(row).getByRole("button", { name: "Open project" })));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Table", () => {
  it("sorts from the keyboard, preserves render props, refs and numeric alignment", async () => {
    const tableRef = createRef<HTMLDivElement | HTMLTableElement>();
    const headRef = createRef<HTMLDivElement | HTMLTableSectionElement>();
    const bodyRef = createRef<HTMLDivElement | HTMLTableSectionElement>();
    const columnRef = createRef<HTMLDivElement | HTMLTableCellElement>();
    const rowRef = createRef<HTMLDivElement | HTMLTableRowElement>();
    const cellRef = createRef<HTMLDivElement | HTMLTableCellElement>();
    const onSort = vi.fn();
    function Sortable() {
      const [sort, setSort] = useState<SortDescriptor>({ column: "tasks", direction: "ascending" });
      const items = [...projects].sort((a, b) =>
        sort.direction === "ascending" ? a.tasks - b.tasks : b.tasks - a.tasks,
      );
      return h(
        Table,
        {
          ref: tableRef,
          "aria-label": "Project workload",
          selectionMode: "multiple",
          sortDescriptor: sort,
          onSortChange: (next) => {
            onSort(next);
            setSort(next);
          },
          className: () => "project-table",
        },
        h(
          TableHeader,
          { ref: headRef, className: "project-head" },
          h(Column, { id: "name", isRowHeader: true }, "Project"),
          h(Column, {
            ref: columnRef,
            id: "tasks",
            allowsSorting: true,
            className: () => "text-right",
            children: ({ sortDirection }) => `Tasks (${sortDirection})`,
          }),
        ),
        h(TableBody<Project>, {
          ref: bodyRef,
          items,
          className: () => "project-body",
          children: (project) =>
            h(
              Row,
              {
                id: project.id,
                ref: project.id === "launch" ? rowRef : undefined,
                className: ({ isSelected }) => (isSelected ? "chosen-row" : "plain-row"),
              },
              h(Cell, null, project.name),
              h(Cell, {
                ref: project.id === "launch" ? cellRef : undefined,
                className: () => "text-right",
                children: () => project.tasks,
              }),
            ),
        }),
      );
    }
    await render(h(Sortable));
    const table = within(container).getByRole("grid");
    const header = within(table).getByRole("columnheader", { name: "Tasks (ascending)" });
    expect(tableRef.current).toBe(table);
    expect(headRef.current?.className).toContain("project-head");
    expect(bodyRef.current?.className).toContain("project-body");
    expect(columnRef.current).toBe(header);
    expect(cellRef.current?.className).toContain("text-right");
    expect(cellRef.current?.className).toContain("tabular-nums");
    expect(header.textContent).toContain("↑");
    await interact(() => header.focus());
    await interact(() => user.keyboard("{Enter}"));
    expect(onSort).toHaveBeenCalledWith({ column: "tasks", direction: "descending" });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(header.textContent).toContain("↓");
    expect(within(table).getAllByRole("row")[1]?.textContent).toContain("Archived projects");
    await interact(() => rowRef.current?.focus());
    await interact(() => user.keyboard(" "));
    expect(rowRef.current?.getAttribute("aria-selected")).toBe("true");
    expect(rowRef.current?.className).toContain("chosen-row");
    expectSelectionStyle(rowRef.current!);
    expectFocusStyle(header);
    expectFocusStyle(cellRef.current!);
  });
});

describe("Tree", () => {
  it("expands and collapses with arrow keys and preserves content render props and refs", async () => {
    const treeRef = createRef<HTMLDivElement>();
    const itemRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const onExpandedChange = vi.fn();
    await render(
      h(
        Tree,
        {
          ref: treeRef,
          "aria-label": "Documents",
          selectionMode: "multiple",
          onExpandedChange,
          className: () => "document-tree",
        },
        h(TreeItem, {
          ref: itemRef,
          id: "campaign",
          textValue: "Campaign documents",
          className: ({ isExpanded }) => (isExpanded ? "expanded" : "collapsed"),
          children: [
            h(TreeItemContent, {
              key: "content",
              ref: contentRef,
              className: ({ level }) => `level-${level}`,
              children: ({ isExpanded }) =>
                h(
                  "span",
                  null,
                  h(
                    Button,
                    { slot: "chevron", "aria-label": isExpanded ? "Collapse folder" : "Expand folder" },
                    isExpanded ? "−" : "+",
                  ),
                  isExpanded ? "Campaign documents open" : "Campaign documents",
                ),
            }),
            h(TreeItem, {
              key: "plan",
              id: "plan",
              textValue: "Launch plan",
              children: h(TreeItemContent, { children: "Launch plan" }),
            }),
          ],
        }),
        h(TreeItem, {
          id: "budget",
          textValue: "Budget review",
          children: h(TreeItemContent, { children: "Budget review" }),
        }),
      ),
    );

    const tree = within(container).getByRole("treegrid", { name: "Documents" });
    const folder = within(tree).getByRole("row", { name: /Campaign documents/ });
    expect(treeRef.current).toBe(tree);
    expect(itemRef.current).toBe(folder);
    expect(contentRef.current?.className).toContain("level-1");
    expect(contentRef.current?.textContent).toContain("Campaign documents");
    await interact(() => user.tab());
    await interact(() => user.keyboard("{ArrowRight}"));
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(folder.className).toContain("expanded");
    expect(onExpandedChange).toHaveBeenCalledWith(new Set(["campaign"]));
    expect(contentRef.current?.textContent).toContain("Campaign documents open");
    const plan = within(tree).getByRole("row", { name: "Launch plan" });
    expect(plan.getAttribute("aria-level")).toBe("2");
    await interact(() => user.keyboard("{ArrowDown} "));
    expect(document.activeElement).toBe(plan);
    expect(plan.getAttribute("aria-selected")).toBe("true");
    expectSelectionStyle(plan);
    expectFocusStyle(plan);
    await interact(() => user.keyboard("{ArrowLeft}{ArrowLeft}"));
    expect(folder.getAttribute("aria-expanded")).toBe("false");
    expect(within(tree).queryByRole("row", { name: "Launch plan" })).toBeNull();
  });
});

describe("Tags", () => {
  it("navigates and selects tags, removes by keyboard and remove slot, and renders empty state", async () => {
    const groupRef = createRef<HTMLDivElement>();
    const listRef = createRef<HTMLDivElement>();
    const tagRef = createRef<HTMLDivElement>();
    const onRemove = vi.fn();
    function Tags() {
      const [items, setItems] = useState(projects.slice(0, 2));
      return h(
        TagGroup,
        {
          ref: groupRef,
          "aria-label": "Included projects",
          selectionMode: "multiple",
          className: "project-tags",
          onRemove: (keys) => {
            onRemove(keys);
            setItems((current) => current.filter((project) => !keys.has(project.id)));
          },
        },
        h(TagList<Project>, {
          ref: listRef,
          items,
          className: () => "project-tag-list",
          renderEmptyState: () => "No projects included.",
          children: (project) =>
            h(Tag, {
              id: project.id,
              textValue: project.name,
              ref: project.id === "launch" ? tagRef : undefined,
              className: ({ isSelected }) => (isSelected ? "chosen-tag" : "plain-tag"),
              children: ({ allowsRemoving }) =>
                h(
                  "span",
                  null,
                  project.name,
                  allowsRemoving && h(Button, { slot: "remove", "aria-label": "Remove" }, "×"),
                ),
            }),
        }),
      );
    }
    await render(h(Tags));
    const list = within(container).getByRole("grid", { name: "Included projects" });
    expect(groupRef.current?.className).toContain("project-tags");
    expect(listRef.current).toBe(list);
    expect(tagRef.current?.getAttribute("role")).toBe("row");
    await interact(() => user.tab());
    await interact(() => user.keyboard(" "));
    expect(tagRef.current?.getAttribute("aria-selected")).toBe("true");
    expect(tagRef.current?.className).toContain("chosen-tag");
    expectSelectionStyle(tagRef.current!);
    await interact(() => user.keyboard("{ArrowRight}{Delete}"));
    expect(onRemove).toHaveBeenCalledWith(new Set(["research"]));
    expect(within(list).queryByRole("row", { name: /Customer research/ })).toBeNull();
    await interact(() => user.click(within(list).getByRole("button", { name: /^Remove Autumn campaign launch/ })));
    expect(onRemove).toHaveBeenCalledWith(new Set(["launch"]));
    expect(list.textContent).toContain("No projects included.");
  });
});

describe("Indicators and semantic exports", () => {
  it("styles the selection indicator with a neutral marker and forwards its ref and class callback", async () => {
    const ref = createRef<HTMLDivElement>();
    await render(
      h(SharedElementTransition, {
        children: h(SelectionIndicator, { ref, isSelected: true, className: () => "custom-indicator" }),
      }),
    );
    expect(ref.current?.className).toContain("custom-indicator");
    expect(ref.current?.className).toContain("bg-selection-marker");
    expect(ref.current?.className).toContain("motion-reduce:transition-none");
  });

  it("keeps semantic utilities unchanged and accepts styled drop indicators in drag hooks", async () => {
    const aria = await import("react-aria-components");
    expect(Collection).toBe(aria.Collection);
    expect(useDragAndDrop).toBe(aria.useDragAndDrop);
    const renderIndicator = vi.fn(
      (target: Parameters<NonNullable<Parameters<typeof useDragAndDrop>[0]["renderDropIndicator"]>>[0]) =>
        h(DropIndicator, { target, className: ({ isDropTarget }) => (isDropTarget ? "active-drop" : "inactive-drop") }),
    );
    function DraggableProjects() {
      const { dragAndDropHooks } = useDragAndDrop<Project>({
        getItems: (_keys, items) => items.map((project) => ({ "text/plain": project.name })),
        onReorder: () => {},
        renderDropIndicator: renderIndicator,
      });
      return h(ListBox<Project>, {
        "aria-label": "Reorder projects",
        items: projects,
        dragAndDropHooks,
        children: (project) => h(ListBoxItem, { id: project.id }, project.name),
      });
    }
    await render(h(DraggableProjects));
    expect(within(container).getAllByRole("option")).toHaveLength(3);
    await interact(() => user.tab());
    await interact(() => user.keyboard("{Enter}"));
    expect(renderIndicator).toHaveBeenCalled();
    const indicators = container.querySelectorAll(".inactive-drop");
    expect(indicators.length).toBeGreaterThan(0);
    expect(indicators[0].className).toContain("data-[drop-target]:outline-[var(--focus)]");
    expect(indicators[0].className).toContain("data-[drop-target]:outline-solid");
  });
});
