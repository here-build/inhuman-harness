import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { isFileDropItem } from "react-aria-components";
import { UNSAFE_PortalProvider } from "react-aria";

import { Page, Schemes, Section } from "./brand-kit.js";
import {
  Breadcrumb,
  Breadcrumbs,
  Disclosure,
  DisclosureGroup,
  DisclosurePanel,
  FieldButton,
  Heading,
  Keyboard,
  Link,
  Separator,
  Text,
  Toolbar,
} from "../components/ui/navigation.js";
import {
  Dialog,
  DropZone,
  FileTrigger,
  Toast,
  ToastContent,
  ToastQueue,
  ToastRegion,
} from "../components/ui/feedback.js";

const meta = {
  title: "Graphic Precision/Navigation and feedback",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Navigation: Story = {
  render: () => (
    <Page
      historical={false}
      title="Navigation"
      lede="Links express destinations; commands stay buttons. Structural text stays in natural case."
    >
      <Section
        title="Hierarchy and commands"
        note="Tab into the toolbar, then use arrow keys. The current breadcrumb is announced as the current page."
      >
        <Schemes>
          <NavigationExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function NavigationExample() {
  const [message, setMessage] = useState("No changes yet");
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs aria-label="Project location">
        <Breadcrumb>
          <Link href="#projects">Projects</Link>
        </Breadcrumb>
        <Breadcrumb>
          <Link href="#autumn">Autumn campaign</Link>
        </Breadcrumb>
        <Breadcrumb>
          <Link>Overview</Link>
        </Breadcrumb>
      </Breadcrumbs>
      <Heading level={2}>Autumn campaign</Heading>
      <Text>Review the project and keep the next action close to the content.</Text>
      <Toolbar aria-label="Project actions">
        <FieldButton onPress={() => setMessage("Changes saved")}>Save</FieldButton>
        <FieldButton onPress={() => setMessage("Preview opened")}>Preview</FieldButton>
        <Separator orientation="vertical" />
        <FieldButton isDisabled>Publish</FieldButton>
      </Toolbar>
      <Text role="status">{message}</Text>
      <Separator />
      <div className="flex flex-wrap items-center gap-3">
        <Link href="https://example.com" target="_blank" rel="noreferrer">
          Read the guide
        </Link>
        <Link href="#unavailable" isDisabled>
          Unavailable
        </Link>
        <Keyboard>⌘K</Keyboard>
      </div>
    </div>
  );
}

export const Disclosures: Story = {
  render: () => (
    <Page historical={false} title="Disclosures" lede="Reveal related detail without leaving the current task.">
      <Section
        title="Related sections"
        note="Tab to a heading button and press Enter or Space. Opening a section closes the previous one; the disabled section cannot expand."
      >
        <Schemes>
          <DisclosureGroup defaultExpandedKeys={["details"]}>
            <Disclosure id="details">
              <Heading>
                <FieldButton slot="trigger">Project details</FieldButton>
              </Heading>
              <DisclosurePanel>Campaign assets are ready for review.</DisclosurePanel>
            </Disclosure>
            <Disclosure id="history">
              <Heading>
                <FieldButton slot="trigger">Revision history</FieldButton>
              </Heading>
              <DisclosurePanel>
                <Link href="#revision">View the latest revision</Link>
              </DisclosurePanel>
            </Disclosure>
            <Disclosure id="restricted" isDisabled>
              <Heading>
                <FieldButton slot="trigger">Restricted settings</FieldButton>
              </Heading>
              <DisclosurePanel>Only project owners can change these settings.</DisclosurePanel>
            </Disclosure>
          </DisclosureGroup>
        </Schemes>
      </Section>
    </Page>
  ),
};

export const FileFeedback: Story = {
  render: () => (
    <Page
      historical={false}
      title="File feedback"
      lede="File selection and dropping share the same visible, announced result."
    >
      <Section
        title="Project attachments"
        note="Choose files with the keyboard or drop files into the region. Filenames remain literal technical values."
      >
        <Schemes>
          <FileExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function FileExample() {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <DropZone
      aria-label="Project attachments"
      getDropOperation={(types) => (types.has("Files") ? "copy" : "cancel")}
      onDrop={async (event) => {
        setFiles(await Promise.all(event.items.filter(isFileDropItem).map((item) => item.getFile())));
      }}
    >
      <Text slot="label">Drop project files here</Text>
      <FileTrigger allowsMultiple onSelect={(selection) => setFiles(Array.from(selection ?? []))}>
        <FieldButton>Choose files</FieldButton>
      </FileTrigger>
      <Text role="status" className={files.length ? "font-mono" : "text-muted"}>
        {files.length ? files.map((file) => file.name).join(", ") : "No files selected"}
      </Text>
    </DropZone>
  );
}

export const Feedback: Story = {
  render: () => (
    <Page
      historical={false}
      title="Feedback"
      lede="Dialogs supply content semantics; native dialog adapters keep modal ownership. Notifications remain in the document flow."
    >
      <Section
        title="Inline dialog semantics"
        note="This is a non-modal content example: no portal, positioner, backdrop or focus trap is installed."
      >
        <Schemes>
          <Dialog className="border border-edge">
            <Heading slot="title">Review complete</Heading>
            <Text>The project is ready for the next step.</Text>
          </Dialog>
        </Schemes>
      </Section>
      <Section
        title="Notifications"
        note="The installed React Aria toast API is experimental. Notifications can be focused and explicitly dismissed, without a timeout."
      >
        <Schemes>
          <ToastExample />
        </Schemes>
      </Section>
    </Page>
  ),
};

function ToastExample() {
  const [queue] = useState(() => new ToastQueue<{ title: string; description: string }>());
  const portalRef = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-4">
      <FieldButton onPress={() => queue.add({ title: "Changes saved", description: "The project is up to date." })}>
        Save project
      </FieldButton>
      <div ref={portalRef} />
      <UNSAFE_PortalProvider getContainer={() => portalRef.current}>
        <ToastRegion queue={queue} aria-label="Project notifications">
          {({ toast }) => (
            <Toast toast={toast}>
              <ToastContent>
                <Text slot="title" elementType="h3" className="text-base">
                  {toast.content.title}
                </Text>
                <Text slot="description">{toast.content.description}</Text>
              </ToastContent>
              <FieldButton slot="close" aria-label="Dismiss notification">
                Dismiss
              </FieldButton>
            </Toast>
          )}
        </ToastRegion>
      </UNSAFE_PortalProvider>
    </div>
  );
}
