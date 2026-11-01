import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Label } from "react-aria-components";
import { expect, userEvent, within } from "storybook/test";

import { Page, Schemes, Section as StorySection } from "./brand-kit.js";
import { buttonVariants } from "../components/ui/button.js";
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
  type Selection,
  type SortDescriptor,
} from "../components/ui/collections.js";

const meta = {
  title: "Graphic Precision/Collections",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const projects = [
  { id: "autumn", name: "Autumn campaign launch", tasks: 24 },
  { id: "research", name: "Customer research", tasks: 8 },
  { id: "archive", name: "Archived projects", tasks: 120 },
];
const quietButton = buttonVariants({ variant: "ghost" });

export const ListSelection: Story = {
  render: () => (
    <Page
      historical={false}
      title="List selection"
      lede="Object names retain natural case. A muted surface and neutral edge mark selection; the focus outline follows keyboard navigation."
    >
      <StorySection
        title="Projects"
        note="Tab into the list. Use Up and Down to navigate, Space to select, and type a project name to find it. Archived projects are unavailable."
      >
        <Schemes>
          <ProjectList />
        </Schemes>
      </StorySection>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const list = within(canvasElement).getAllByRole("listbox", { name: "Projects" })[0]!;
    const option = within(list).getByRole("option", { name: "Autumn campaign launch" });
    option.focus();
    await userEvent.keyboard(" ");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown} ");
    await expect(within(list).getByRole("option", { name: "Customer research" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  },
};

function ProjectList() {
  const [selected, setSelected] = useState<Selection>(new Set());
  return (
    <div className="space-y-3">
      <ListBox
        aria-label="Projects"
        selectionMode="multiple"
        selectedKeys={selected}
        onSelectionChange={setSelected}
        disabledKeys={["archive"]}
      >
        <Section>
          <Header>Current work</Header>
          <ListBoxItem id="autumn">Autumn campaign launch</ListBoxItem>
          <ListBoxItem
            id="research"
            textValue="Customer research"
            className={({ isSelected }) => (isSelected ? "font-strong" : "")}
          >
            {({ isSelected }) => <span>Customer research{isSelected && <span aria-hidden="true"> ✓</span>}</span>}
          </ListBoxItem>
        </Section>
        <Separator />
        <Section>
          <Header>Previous work</Header>
          <ListBoxItem id="archive">Archived projects</ListBoxItem>
        </Section>
      </ListBox>
      <p role="status" className="text-sm text-muted">
        {selected === "all" ? projects.length : selected.size} projects selected
      </p>
      <ListBox
        aria-label="Search results"
        items={[]}
        renderEmptyState={() => <p className="p-3 text-muted">No projects match your search.</p>}
      >
        {(project: (typeof projects)[number]) => <ListBoxItem>{project.name}</ListBoxItem>}
      </ListBox>
    </div>
  );
}

export const InteractiveRows: Story = {
  render: () => (
    <Page
      historical={false}
      title="Interactive rows"
      lede="Grid lists keep row selection separate from commands within each row."
    >
      <StorySection
        title="Project actions"
        note="Use Up and Down to navigate rows and Space to select. Tab reaches the Open command."
      >
        <Schemes>
          <ProjectGrid />
        </Schemes>
      </StorySection>
    </Page>
  ),
};

function ProjectGrid() {
  const [status, setStatus] = useState("No project opened");
  return (
    <div className="space-y-3">
      <GridList aria-label="Project actions" items={projects} selectionMode="multiple">
        {(project) => (
          <GridListItem textValue={project.name}>
            {({ isSelected }) => (
              <>
                <span aria-hidden="true" className="w-4">
                  {isSelected ? "✓" : ""}
                </span>
                <span className="flex-1">{project.name}</span>
                <Button
                  className={quietButton}
                  aria-label={`Open ${project.name}`}
                  onPress={() => setStatus(`${project.name} opened`)}
                >
                  Open
                </Button>
              </>
            )}
          </GridListItem>
        )}
      </GridList>
      <p role="status" className="text-sm text-muted">
        {status}
      </p>
    </div>
  );
}

export const SortableTable: Story = {
  render: () => (
    <Page
      historical={false}
      title="Sortable table"
      lede="Names align left; amounts align right with tabular figures. Sort arrows supplement accessible sort direction."
    >
      <StorySection
        title="Project workload"
        note="Tab to a header and press Enter to sort. Use arrow keys to navigate cells and Space to select a row."
      >
        <Schemes>
          <ProjectTable />
        </Schemes>
      </StorySection>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const table = within(canvasElement).getAllByRole("grid", { name: "Project workload" })[0]!;
    const header = within(table).getByRole("columnheader", { name: "Tasks" });
    header.focus();
    await userEvent.keyboard("{Enter}");
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await userEvent.keyboard("{Enter}");
    await expect(header).toHaveAttribute("aria-sort", "descending");
  },
};

function ProjectTable() {
  const [sort, setSort] = useState<SortDescriptor>({ column: "name", direction: "ascending" });
  const sorted = [...projects].sort((a, b) => {
    const comparison = sort.column === "tasks" ? a.tasks - b.tasks : a.name.localeCompare(b.name);
    return sort.direction === "descending" ? -comparison : comparison;
  });
  return (
    <Table aria-label="Project workload" selectionMode="multiple" sortDescriptor={sort} onSortChange={setSort}>
      <TableHeader>
        <Column id="name" isRowHeader allowsSorting>
          Project
        </Column>
        <Column id="tasks" allowsSorting className="text-right">
          Tasks
        </Column>
      </TableHeader>
      <TableBody items={sorted}>
        {(project) => (
          <Row>
            <Cell>{project.name}</Cell>
            <Cell className="text-right">{project.tasks}</Cell>
          </Row>
        )}
      </TableBody>
    </Table>
  );
}

export const ExpandableTree: Story = {
  render: () => (
    <Page
      historical={false}
      title="Expandable tree"
      lede="Hierarchy uses indentation and an explicit expansion command, without changing the treatment of object names."
    >
      <StorySection
        title="Project documents"
        note="Use Right to expand a folder and Left to collapse it. Up and Down navigate; Space selects a document."
      >
        <Schemes>
          <DocumentTree />
        </Schemes>
      </StorySection>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const tree = within(canvasElement).getAllByRole("treegrid", { name: "Project documents" })[0]!;
    const folder = within(tree).getByRole("row", { name: /Campaign documents/ });
    folder.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    await expect(within(tree).getByRole("row", { name: "Launch plan" })).toBeVisible();
    await userEvent.keyboard("{ArrowLeft}");
    await expect(folder).toHaveAttribute("aria-expanded", "false");
  },
};

function DocumentTree() {
  return (
    <Tree aria-label="Project documents" selectionMode="multiple">
      <TreeItem id="campaign" textValue="Campaign documents">
        <TreeItemContent>
          {({ isExpanded }) => (
            <>
              <Button
                slot="chevron"
                className={quietButton}
                aria-label={isExpanded ? "Collapse Campaign documents" : "Expand Campaign documents"}
              >
                <span aria-hidden="true">{isExpanded ? "−" : "+"}</span>
              </Button>
              Campaign documents
            </>
          )}
        </TreeItemContent>
        <TreeItem id="plan" textValue="Launch plan">
          <TreeItemContent>Launch plan</TreeItemContent>
        </TreeItem>
        <TreeItem id="notes" textValue="Research notes">
          <TreeItemContent>Research notes</TreeItemContent>
        </TreeItem>
      </TreeItem>
      <TreeItem id="budget" textValue="Budget review">
        <TreeItemContent>Budget review</TreeItemContent>
      </TreeItem>
    </Tree>
  );
}

export const RemovableTags: Story = {
  render: () => (
    <Page
      historical={false}
      title="Removable tags"
      lede="Tags name real objects and preserve a quiet, rectangular shape. Removal is available through an explicit command and the keyboard."
    >
      <StorySection
        title="Included projects"
        note="Use Left and Right to navigate, Space to select, and Backspace or Delete to remove. Each remove button has a specific accessible name."
      >
        <Schemes>
          <ProjectTags />
        </Schemes>
      </StorySection>
    </Page>
  ),
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getAllByRole("grid", { name: "Included projects" })[0]!;
    const row = within(group).getByRole("row", { name: /Customer research/ });
    row.focus();
    await userEvent.keyboard("{Delete}");
    await expect(within(group).queryByRole("row", { name: /Customer research/ })).not.toBeInTheDocument();
  },
};

function ProjectTags() {
  const [items, setItems] = useState(projects.slice(0, 2));
  return (
    <TagGroup
      selectionMode="multiple"
      onRemove={(keys) => setItems((current) => current.filter((item) => !keys.has(item.id)))}
    >
      <Label className="text-sm">Included projects</Label>
      <TagList items={items} renderEmptyState={() => <p className="text-muted">No projects included.</p>}>
        {(project) => (
          <Tag id={project.id} textValue={project.name}>
            {project.name}
            <Button slot="remove" className={quietButton} aria-label="Remove">
              <span aria-hidden="true">×</span>
            </Button>
          </Tag>
        )}
      </TagList>
    </TagGroup>
  );
}
