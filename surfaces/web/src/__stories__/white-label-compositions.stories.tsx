import { useRef, useState, type CSSProperties } from "react";
import {
  Button,
  CodeBlock,
  ComposerBlock,
  ConversationStage,
  DensityScope,
  InspectorDrawer,
  MarkdownBlock,
  PermissionModeControl,
  ProjectTabsBlock,
  ReasoningEffortControl,
  SessionRailBlock,
  SessionSidebar,
  Setting,
  SettingsGroupBlock,
  SettingsModal,
  Switch,
  TerminalBlock,
  TextField,
  VoiceProvider,
  WorkspaceBar,
  WorkspaceShell,
  defineVoiceCatalog,
  enVoiceCatalog,
  useVoice,
  type PermissionModeValue,
  type ProjectTabItem,
  type SessionRailItem,
  type SettingsNavItem,
} from "@inhuman.tools/harness-ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconFolderCode, IconLayoutGrid, IconRobot, IconSettings } from "@tabler/icons-react";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "White-Label Design System/Lego Compositions",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface DemoSession {
  readonly key: string;
  readonly label: string;
  readonly age: string;
  readonly light: SessionRailItem["light"];
  readonly intro: string;
  readonly command: string;
  readonly output: string;
}

const REFERENCE_SESSIONS: readonly DemoSession[] = [
  {
    key: "s-latency",
    label: "Audit checkout latency",
    age: "2m",
    light: "waiting-for-you",
    intro: "Isolated **@inhuman.tools/harness-ui** Lego blocks without any `harness-peer` or MobX wiring.",
    command: "pnpm --filter @inhuman.tools/harness-ui test",
    output: "Test Files  12 passed (12)\n     Tests  137 passed (137)",
  },
  {
    key: "s-release",
    label: "Prepare white-label release",
    age: "14m",
    light: "idle",
    intro: "Switched to **Prepare white-label release** workstream via pure `SessionRailBlock` callback state.",
    command: "pnpm release:check",
    output: "All workspace boundary and package export checks passed.",
  },
];

const CUSTOM_SESSIONS: readonly DemoSession[] = [
  {
    key: "w-triage",
    label: "Quarterly billing review",
    age: "4m",
    light: "running",
    intro: 'Mounted with `layout="header-top"`, compact density, serif display type, and a nested `VoiceProvider`.',
    command: "acme verify --theme indigo-editorial",
    output: "tokens verified: --accent, --canvas, --wash, --radius-md, --font-heading",
  },
  {
    key: "w-audit",
    label: "Sprint triage",
    age: "19m",
    light: "idle",
    intro: "Switched to **Sprint triage** in custom client brand mode with zero internal component forks.",
    command: "acme audit --voice custom-client",
    output: "Voice catalog propagated to composer, rail, workspace bar, and settings modal.",
  },
];

const INSPECTED_SNIPPET = `:root {
  --accent: oklch(0.52 0.21 264);
  --radius-md: 14px;
  --font-heading: "Georgia", serif;
}`;

const customClientVoice = defineVoiceCatalog(
  {
    common: {
      close: "Dismiss",
    },
    workspace: {
      sessionsLabel: "Workstreams",
      projectsLabel: "Client Workspaces",
      settingsLabel: "Client Preferences",
    },
    composer: {
      promptLabel: "Workstream instruction",
      promptPlaceholder: "Ask Acme Assistant…",
      sendLabel: "Dispatch",
    },
    settings: {
      title: "Client Preferences",
    },
  },
  enVoiceCatalog,
);

const customBrandTokens: CSSProperties = {
  "--canvas": "light-dark(oklch(0.985 0.008 250), oklch(0.16 0.015 255))",
  "--wash": "light-dark(oklch(0.955 0.012 250), oklch(0.20 0.018 255))",
  "--raised": "light-dark(oklch(0.995 0.004 250), oklch(0.23 0.02 255))",
  "--ink": "light-dark(oklch(0.2 0.02 255), oklch(0.95 0.01 250))",
  "--muted": "light-dark(oklch(0.45 0.02 255), oklch(0.72 0.015 250))",
  "--line": "light-dark(oklch(0.87 0.018 250), oklch(0.32 0.022 255))",
  "--edge": "light-dark(oklch(0.76 0.025 250), oklch(0.42 0.028 255))",
  "--hover": "light-dark(oklch(0.93 0.02 250), oklch(0.27 0.024 255))",
  "--selected": "light-dark(oklch(0.91 0.04 260), oklch(0.29 0.05 260))",
  "--selection-marker": "light-dark(oklch(0.5 0.2 262), oklch(0.72 0.16 260))",
  "--accent": "light-dark(oklch(0.5 0.2 262), oklch(0.68 0.18 260))",
  "--accent-ink": "oklch(0.99 0 0)",
  "--focus": "light-dark(oklch(0.5 0.2 262), oklch(0.72 0.16 260))",
  "--radius-xs": "6px",
  "--radius-sm": "10px",
  "--radius-md": "14px",
  "--radius-lg": "18px",
  "--font-heading": '"Georgia", "Times New Roman", serif',
  "--font-sans": '"Nunito Sans", ui-sans-serif, system-ui, sans-serif',
} as CSSProperties;

function WhiteLabelWorkspaceDemo({
  brandName,
  layout,
  sessions,
  shellStyle,
  compact = false,
}: {
  readonly brandName: string;
  readonly layout: "rail-left" | "header-top";
  readonly sessions: readonly DemoSession[];
  readonly shellStyle?: CSSProperties;
  readonly compact?: boolean;
}) {
  const voice = useVoice();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState("core-ui");
  const [activeSessionKey, setActiveSessionKey] = useState(sessions[0]!.key);
  const [messagesBySession, setMessagesBySession] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [draft, setDraft] = useState("");
  const [effort, setEffort] = useState("medium");
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>("auto");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [streamMarkdown, setStreamMarkdown] = useState(true);
  const [workspaceAlias, setWorkspaceAlias] = useState(brandName);

  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((s) => s.key === activeSessionKey) ?? sessions[0]!;
  const extraMessages = messagesBySession[activeSession.key] ?? [];

  const sendMessage = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    setMessagesBySession((prev) => ({
      ...prev,
      [activeSession.key]: [...(prev[activeSession.key] ?? []), trimmed],
    }));
    setDraft("");
  };

  const projectTabs: readonly ProjectTabItem[] = [
    {
      key: "overview",
      kind: "overview",
      active: activeTab === "overview",
      icon: <IconLayoutGrid size={14} stroke={1.75} aria-hidden />,
      label: "All workspaces",
      onSelect: () => setActiveTab("overview"),
    },
    {
      key: "core-ui",
      kind: "project",
      active: activeTab === "core-ui",
      icon: <IconFolderCode size={14} stroke={1.75} aria-hidden />,
      label: "design-tokens",
      onSelect: () => setActiveTab("core-ui"),
    },
    {
      key: "bots",
      kind: "bots",
      active: activeTab === "bots",
      icon: <IconRobot size={14} stroke={1.75} aria-hidden />,
      label: "Automations",
      onSelect: () => setActiveTab("bots"),
    },
  ];

  const railItems: readonly SessionRailItem[] = sessions.map((item) => ({
    key: item.key,
    href: `#${item.key}`,
    label: item.label,
    age: item.age,
    light: item.light,
    selected: item.key === activeSession.key,
  }));

  const settingsItems: readonly SettingsNavItem[] = [
    { id: "general", label: "Workspace" },
    { id: "theme", label: "Theme & Voice" },
  ];

  const shell = (
    <WorkspaceShell
      layout={layout}
      style={shellStyle}
      sidebar={
        <SessionSidebar open={sidebarOpen} brand={workspaceAlias}>
          <SessionRailBlock
            mode="project"
            heading={activeTab === "core-ui" ? "design-tokens" : activeTab}
            items={railItems}
            onMint={() => setActiveSessionKey(sessions[0]!.key)}
            onNavigate={(href) => setActiveSessionKey(href.slice(1))}
          />
        </SessionSidebar>
      }
      stage={
        <ConversationStage
          composer={
            <ComposerBlock
              notice={`Mode: ${permissionMode} · Effort: ${effort}`}
              fieldRef={fieldRef}
              pillRef={pillRef}
              dropEnabled={false}
              onDropFiles={() => undefined}
              pictures={[]}
              picturesDisabled
              onRemovePicture={() => undefined}
              onPickPictures={() => undefined}
              slashMenu={null}
              draft={draft}
              onDraftChange={(value) => setDraft(value)}
              onDraftKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendMessage();
                }
              }}
              onDraftPaste={() => undefined}
              showSend
              canSend={draft.trim() !== ""}
              onSend={sendMessage}
              lane={
                <ReasoningEffortControl
                  triggerWord={effort}
                  selectedKey={effort}
                  options={[
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High", dropsCache: true },
                  ]}
                  onSelect={setEffort}
                />
              }
              footer={<PermissionModeControl mode={permissionMode} onModeChange={setPermissionMode} />}
            />
          }
        >
          <div className="mx-auto flex w-full max-w-[52rem] flex-col gap-5 px-6 py-8">
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
              <div>
                <p className="text-xs text-muted">{voice.workspace.sessionsLabel}</p>
                <h2 className="font-heading text-xl font-strong">{activeSession.label}</h2>
              </div>
              <Button variant="secondary" onClick={() => setInspectorOpen(true)}>
                Open inspector
              </Button>
            </header>
            <MarkdownBlock text={activeSession.intro} />
            <TerminalBlock command={activeSession.command} output={activeSession.output} outcome="ok" />
            {extraMessages.map((msg, index) => (
              <div key={`${activeSession.key}-${index}`} className="rounded-sm border border-line bg-wash px-4 py-3">
                <p className="text-xs font-strong text-muted">Operator prompt</p>
                <p className="mt-1 text-base text-ink">{msg}</p>
              </div>
            ))}
          </div>
        </ConversationStage>
      }
      inspector={
        inspectorOpen ? (
          <InspectorDrawer
            title="src/tokens.css"
            ariaLabel="Inspector"
            closeAriaLabel="Close inspector"
            onClose={() => setInspectorOpen(false)}
          >
            <CodeBlock lang="css" text={INSPECTED_SNIPPET} />
          </InspectorDrawer>
        ) : null
      }
      workspaceBar={
        <WorkspaceBar
          mobileNavToggle={{ open: sidebarOpen, onToggle: () => setSidebarOpen((open) => !open) }}
          leadingAction={
            <button
              type="button"
              className="project-corner touch-target"
              aria-label={voice.workspace.settingsLabel}
              onClick={() => setSettingsOpen(true)}
            >
              <IconSettings size={14} stroke={1.75} aria-hidden />
              <span>{voice.workspace.settingsLabel}</span>
            </button>
          }
        >
          <ProjectTabsBlock activeKey={activeTab} tabs={projectTabs} />
        </WorkspaceBar>
      }
      overlay={
        settingsOpen ? (
          <SettingsModal
            items={settingsItems}
            activeId={settingsTab}
            navAriaLabel={voice.settings.title}
            onSelect={setSettingsTab}
            onDismiss={() => setSettingsOpen(false)}
          >
            {settingsTab === "general" ? (
              <SettingsGroupBlock title="Identity" intro="Pure presentation controls bound to local story state.">
                <Setting label="Workspace title" hint="Displayed in the session rail brand slot.">
                  <TextField label="Workspace title" value={workspaceAlias} onChange={setWorkspaceAlias} />
                </Setting>
              </SettingsGroupBlock>
            ) : (
              <SettingsGroupBlock title="Typography & Behavior" intro="White-label tokens propagate down all scopes.">
                <Switch isSelected={streamMarkdown} onChange={setStreamMarkdown}>
                  Repair streamed Markdown fences
                </Switch>
              </SettingsGroupBlock>
            )}
          </SettingsModal>
        ) : null
      }
    />
  );

  return compact ? <DensityScope density="compact">{shell}</DensityScope> : shell;
}

/**
 * Default Graphic Precision Lego layout (`layout="rail-left"`): sidebar, stage, toggleable inspector drawer,
 * bottom workspace bar, and settings modal rendered solely from `@inhuman.tools/harness-ui`.
 */
export const ReferenceOperatorLego: Story = {
  render: () => (
    <WhiteLabelWorkspaceDemo brandName="Harness Operator" layout="rail-left" sessions={REFERENCE_SESSIONS} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("heading", { name: "Audit checkout latency" })).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: /Prepare white-label release/ }));
    await expect(canvas.getByRole("heading", { name: "Prepare white-label release" })).toBeVisible();

    const prompt = canvas.getByLabelText("Message");
    await userEvent.type(prompt, "Verify Safari 18.7 layout tokens");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(canvas.getByText("Verify Safari 18.7 layout tokens")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Open inspector" }));
    const inspector = canvas.getByRole("complementary", { name: "Inspector" });
    await expect(within(inspector).getByText("src/tokens.css")).toBeVisible();
    await userEvent.click(within(inspector).getByRole("button", { name: "Close inspector" }));
    await expect(canvas.queryByRole("complementary", { name: "Inspector" })).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Settings" }));
    const dialog = canvas.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Theme & Voice" }));
    await expect(within(dialog).getByText("Repair streamed Markdown fences")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};

/**
 * Reconfigured white-label brand (`layout="header-top"`, compact density, custom CSS custom properties,
 * and nested `<VoiceProvider>`).
 */
export const CustomClientBrandLego: Story = {
  render: () => (
    <VoiceProvider catalog={customClientVoice}>
      <WhiteLabelWorkspaceDemo
        brandName="Acme Studio"
        layout="header-top"
        compact
        sessions={CUSTOM_SESSIONS}
        shellStyle={customBrandTokens}
      />
    </VoiceProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("heading", { name: "Quarterly billing review" })).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: /Sprint triage/ }));
    await expect(canvas.getByRole("heading", { name: "Sprint triage" })).toBeVisible();

    const prompt = canvas.getByLabelText("Workstream instruction");
    await userEvent.type(prompt, "Ship custom Acme theme");
    await userEvent.click(canvas.getByRole("button", { name: "Dispatch" }));
    await expect(canvas.getByText("Ship custom Acme theme")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Open inspector" }));
    const inspector = canvas.getByRole("complementary", { name: "Inspector" });
    await expect(within(inspector).getByText("src/tokens.css")).toBeVisible();
    await userEvent.click(within(inspector).getByRole("button", { name: "Close inspector" }));

    await userEvent.click(canvas.getByRole("button", { name: "Client Preferences" }));
    const dialog = canvas.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Theme & Voice" }));
    await expect(within(dialog).getByText("Repair streamed Markdown fences")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    await expect(canvas.queryByRole("dialog")).toBeNull();
  },
};
