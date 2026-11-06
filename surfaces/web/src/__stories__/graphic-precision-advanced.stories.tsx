import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button as AriaButton, Label, Link, ListBox, ListBoxItem, Text } from "react-aria-components";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  TokenField,
  TokenInput,
  Token,
  TokenFieldValue,
  NavigationTree,
  NavigationTreeItem,
  NavigationTreeItemContent,
  NavigationTreeSection,
  NavigationTreeHeader,
  RouterProvider,
  Virtualizer,
  ListLayout,
} from "../components/ui/advanced.js";
import { Button } from "../components/ui/button.js";

const meta = {
  title: "Graphic Precision/Advanced",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Tokens: Story = {
  render: () => (
    <Page
      historical={false}
      title="Inline tokens"
      lede="Editable prose and named references share one keyboard-accessible field."
    >
      <Section
        title="Draft a request"
        note="Type between references. Use arrows to move and Shift + arrows to select; Backspace removes a selected reference. The reference copy is read only."
      >
        <Schemes>
          <TokenExamples />
        </Schemes>
      </Section>
    </Page>
  ),
};

function TokenExamples() {
  const [value, setValue] = useState(
    () =>
      new TokenFieldValue([
        { type: "text", text: "Ask " },
        { type: "token", text: "Maya Chen", value: { id: "maya" } },
        { type: "text", text: " to review the release plan." },
      ]),
  );
  return (
    <div className="flex flex-col gap-5">
      <TokenField value={value} onChange={setValue}>
        <Label className="text-sm text-ink">Request</Label>
        <TokenInput>{(segment) => <Token>{segment.text}</Token>}</TokenInput>
        <Text slot="description" className="text-xs text-muted">
          Named references remain intact while you edit the surrounding text.
        </Text>
      </TokenField>
      <Button
        variant="secondary"
        onPress={() =>
          setValue(
            value.replaceRangeWithSegments(value.selectedRange.start, value.selectedRange.end, [
              { type: "token", text: "Release team", value: { id: "release-team" } },
            ]),
          )
        }
      >
        Insert release team
      </Button>
      <p role="status" className="text-sm text-muted">
        {value.toString()}
      </p>
      <TokenField
        isReadOnly
        defaultValue={
          new TokenFieldValue([
            { type: "text", text: "Approved by " },
            { type: "token", text: "Release team" },
          ])
        }
      >
        <Label className="text-sm text-ink">Reference copy</Label>
        <TokenInput>{(segment) => <Token>{segment.text}</Token>}</TokenInput>
        <Text slot="description" className="text-xs text-muted">
          You can focus and select this copy, but not edit it.
        </Text>
      </TokenField>
    </div>
  );
}

export const Navigation: Story = {
  render: () => (
    <Page
      historical={false}
      title="Navigation tree"
      lede="Nested destinations retain real links, with a quiet marker on the current page."
    >
      <Section
        title="Workspace pages"
        note="Expand Projects with the disclosure button or arrow keys. Tab to a link and press Enter to change the local destination without leaving this story."
      >
        <Schemes>
          <NavigationExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

const linkClassName =
  "flex-1 py-1 text-ink no-underline outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-[var(--focus)]";
const disclosureClassName =
  "inline-flex size-7 items-center justify-center border border-edge text-muted outline-none data-[hovered]:bg-hover data-[focus-visible]:outline-2 data-[focus-visible]:outline-[var(--focus)]";

function NavigationExample() {
  const [route, setRoute] = useState("/workspace/projects/release");
  return (
    <RouterProvider navigate={(href) => setRoute(href)}>
      <div className="flex flex-col gap-3">
        <NavigationTree aria-label="Workspace pages" selectedRoute={route} defaultExpandedKeys={["projects"]}>
          <NavigationTreeSection>
            <NavigationTreeHeader>Workspace</NavigationTreeHeader>
            <NavigationTreeItem id="overview" href="/workspace" textValue="Overview">
              <NavigationTreeItemContent>
                <span aria-hidden="true" className="w-7" />
                <Link className={linkClassName}>Overview</Link>
              </NavigationTreeItemContent>
            </NavigationTreeItem>
            <NavigationTreeItem id="projects" textValue="Projects">
              <NavigationTreeItemContent>
                {({ isExpanded }) => (
                  <>
                    <AriaButton
                      slot="chevron"
                      aria-label={isExpanded ? "Collapse projects" : "Expand projects"}
                      className={disclosureClassName}
                    >
                      <span aria-hidden="true">{isExpanded ? "−" : "+"}</span>
                    </AriaButton>
                    <span>Projects</span>
                  </>
                )}
              </NavigationTreeItemContent>
              <NavigationTreeItem id="release" href="/workspace/projects/release" textValue="Release plan">
                <NavigationTreeItemContent>
                  <span aria-hidden="true" className="w-7" />
                  <Link className={linkClassName}>Release plan</Link>
                </NavigationTreeItemContent>
              </NavigationTreeItem>
              <NavigationTreeItem id="research" href="/workspace/projects/research" textValue="Research notes">
                <NavigationTreeItemContent>
                  <span aria-hidden="true" className="w-7" />
                  <Link className={linkClassName}>Research notes</Link>
                </NavigationTreeItemContent>
              </NavigationTreeItem>
            </NavigationTreeItem>
          </NavigationTreeSection>
        </NavigationTree>
        <p role="status" className="text-sm text-muted">
          Current page:{" "}
          {route === "/workspace" ? "Overview" : route.endsWith("research") ? "Research notes" : "Release plan"}
        </p>
      </div>
    </RouterProvider>
  );
}

export const VirtualizedList: Story = {
  render: () => (
    <Page
      historical={false}
      title="Virtualized list"
      lede="A bounded list keeps a large collection navigable without mounting every row."
    >
      <Section
        title="Choose a document"
        note="Scroll through 1,000 documents, use typeahead, or press End to reach the final item. Selection updates the summary below."
      >
        <Schemes>
          <VirtualizedListExample />
        </Schemes>
      </Section>
      <Section
        title="Experimental boundaries"
        note="SharedElementTransition, PreviewTrigger, and Sheet are not production wrappers in this family. Their experimental transition and anchor semantics need separate validation."
      >
        <p className="text-sm text-muted">
          The semantic focus, press, internationalization, routing, filtering, and data hooks are available without
          visual aliases. Virtualizer and its layouts use the styles of their child collection.
        </p>
      </Section>
    </Page>
  ),
};

const documents = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, name: `Project brief ${index + 1}` }));

function VirtualizedListExample() {
  const [selected, setSelected] = useState("No document selected");
  return (
    <div className="flex flex-col gap-3">
      <Virtualizer layout={ListLayout} layoutOptions={{ rowHeight: 40 }}>
        <ListBox
          aria-label="Documents"
          items={documents}
          selectionMode="single"
          className="gp-virtualized-listbox h-64 overflow-auto rounded-none border border-edge bg-canvas text-sm text-ink outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-[var(--focus)]"
          onSelectionChange={(keys) => {
            if (keys !== "all") {
              setSelected(keys.size === 0 ? "No document selected" : `Project brief ${[...keys][0]}`);
            }
          }}
        >
          {(item) => (
            <ListBoxItem
              id={item.id}
              textValue={item.name}
              className="gp-virtualized-listbox-item flex h-10 items-center border-s-2 border-transparent px-3 text-sm text-ink outline-none data-[hovered]:bg-hover data-[selected]:border-s-[var(--selection-marker)] data-[selected]:bg-hover data-[focus-visible]:outline-2 data-[focus-visible]:outline-offset-[-2px] data-[focus-visible]:outline-[var(--focus)]"
            >
              {item.name}
            </ListBoxItem>
          )}
        </ListBox>
      </Virtualizer>
      <p role="status" className="text-sm text-muted">
        {selected}
      </p>
    </div>
  );
}
