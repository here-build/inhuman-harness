import { createContext, useContext, useMemo, type ReactNode } from "react";

/** White-label voice and accessible copy strings used across UI primitives, blocks, and compositions. */
export interface VoiceCatalog {
  readonly common: {
    readonly close: string;
    readonly cancel: string;
    readonly clear: string;
    readonly moreOptions: string;
    readonly empty: string;
    readonly loading: string;
    readonly save: string;
    readonly retry: string;
    readonly tryAgain: string;
    readonly dismiss: string;
    readonly remove: string;
    readonly copy: string;
    readonly copied: string;
    readonly apply: string;
    readonly done: string;
    readonly back: string;
    readonly next: string;
  };
  readonly dialog: {
    readonly closeLabel: string;
  };
  readonly select: {
    readonly emptyText: string;
    readonly optionsLabel: string;
    readonly showSuggestions: string;
    readonly noMatches: string;
  };
  readonly date: {
    readonly calendarLabel: string;
    readonly previousMonth: string;
    readonly nextMonth: string;
    readonly today: string;
  };
  readonly navigation: {
    readonly breadcrumbLabel: string;
    readonly paginationLabel: string;
    readonly previousPage: string;
    readonly nextPage: string;
    readonly tabsLabel: string;
  };
  readonly transcript: {
    readonly failureDetailLabel: string;
    readonly failureHeading: string;
    readonly previewLabel: string;
    readonly copyCodeLabel: string;
    readonly copiedCodeLabel: string;
    readonly collapseLabel: string;
    readonly expandLabel: string;
    readonly binaryFileNotice: string;
    readonly previewTruncatedNotice: string;
    readonly previewUnavailable: string;
    readonly openingLabel: string;
    readonly noDiffChanges: string;
    readonly rawOutputLabel: string;
    readonly terminalLabel: string;
    readonly statusConnecting: string;
    readonly statusThinking: string;
    readonly statusWorking: string;
    readonly statusIdle: string;
    readonly statusStopped: string;
    readonly statusFailed: string;
    readonly reasoningLabel: string;
    readonly emptyResultNotice: string;
    readonly cellErrorNotice: string;
    readonly pictureLoadErrorNotice: string;
    readonly outcomeLiveLabel: string;
    readonly outcomeFailedLabel: string;
    readonly delegatedBriefLabel: string;
    readonly copyBriefLabel: string;
    readonly briefCopiedNotice: string;
    readonly briefCopyErrorNotice: string;
    readonly agentOpeningNotice: string;
    readonly agentOpenFailedNotice: string;
    readonly agentEmptyNotice: string;
    readonly agentResultHeading: string;
    readonly agentReasonHeading: string;
    readonly agentWorkingStatus: string;
    readonly agentCancelledStatus: string;
    readonly agentFailedStatus: string;
    readonly agentCompletedStatus: string;
    readonly agentAskingApprovalStatus: string;
    readonly agentAskingQuestionStatus: string;
  };
  readonly composer: {
    readonly promptLabel: string;
    readonly promptPlaceholder: string;
    readonly sendLabel: string;
    readonly stopLabel: string;
    readonly attachImageLabel: string;
    readonly removeAttachmentLabel: string;
    readonly dropHint: string;
    readonly attachmentsLabel: string;
    readonly modelLabel: string;
    readonly effortLabel: string;
    readonly permissionModeLabel: string;
    readonly slashCommandsLabel: string;
    readonly noSlashMatches: string;
    readonly acknowledgementHeading: string;
    readonly permissionsHeading: string;
    readonly allowLabel: string;
    readonly allowAlwaysLabel: string;
    readonly denyLabel: string;
  };
  readonly workspace: {
    readonly sessionsLabel: string;
    readonly newSessionLabel: string;
    readonly projectsLabel: string;
    readonly addProjectLabel: string;
    readonly settingsLabel: string;
    readonly filesLabel: string;
    readonly closeSidebarLabel: string;
    readonly openSidebarLabel: string;
    readonly welcomeHeading: string;
    readonly welcomeHint: string;
    readonly connectTitle: string;
    readonly connectCodeHint: string;
    readonly connectingLabel: string;
    readonly connectedLabel: string;
    readonly offlineNotice: string;
    readonly reconnectAction: string;
  };
  readonly settings: {
    readonly title: string;
    readonly navigationLabel: string;
    readonly connectionsSection: string;
    readonly mcpSection: string;
    readonly pluginsSection: string;
    readonly skillsSection: string;
    readonly botsSection: string;
    readonly runtimeSection: string;
    readonly emptySection: string;
    readonly addLabel: string;
    readonly deleteLabel: string;
    readonly enabledLabel: string;
    readonly disabledLabel: string;
  };
}

/** Partial override shape accepted by {@link defineVoiceCatalog} and {@link VoiceProvider}. */
export type VoiceCatalogOverrides = {
  readonly [K in keyof VoiceCatalog]?: Partial<VoiceCatalog[K]>;
};

/** Default English operator-grade copy catalog following the Graphic Precision text brandbook. */
export const enVoiceCatalog: VoiceCatalog = {
  common: {
    close: "Close",
    cancel: "Cancel",
    clear: "Clear",
    moreOptions: "More options",
    empty: "Empty",
    loading: "Loading",
    save: "Save",
    retry: "Retry",
    tryAgain: "Try again",
    dismiss: "Dismiss",
    remove: "Remove",
    copy: "Copy",
    copied: "Copied",
    apply: "Apply",
    done: "Done",
    back: "Back",
    next: "Next",
  },
  dialog: {
    closeLabel: "Close dialog",
  },
  select: {
    emptyText: "No options",
    optionsLabel: "Options",
    showSuggestions: "Show suggestions",
    noMatches: "No matches",
  },
  date: {
    calendarLabel: "Calendar",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    today: "Today",
  },
  navigation: {
    breadcrumbLabel: "Breadcrumb",
    paginationLabel: "Pagination",
    previousPage: "Previous page",
    nextPage: "Next page",
    tabsLabel: "Tabs",
  },
  transcript: {
    failureDetailLabel: "Failure details",
    failureHeading: "Failure",
    previewLabel: "Preview",
    copyCodeLabel: "Copy code",
    copiedCodeLabel: "Copied",
    collapseLabel: "Hide details",
    expandLabel: "Show details",
    binaryFileNotice: "Binary file",
    previewTruncatedNotice: "Preview truncated",
    previewUnavailable: "Preview unavailable",
    openingLabel: "Opening…",
    noDiffChanges: "No text diff available",
    rawOutputLabel: "Raw output",
    terminalLabel: "Terminal output",
    statusConnecting: "Connecting",
    statusThinking: "Thinking",
    statusWorking: "Working",
    statusIdle: "Idle",
    statusStopped: "Stopped",
    statusFailed: "Failed",
    reasoningLabel: "Reasoning",
    emptyResultNotice: "No result yet.",
    cellErrorNotice: "This part of the conversation could not be shown.",
    pictureLoadErrorNotice: "The picture could not be loaded.",
    outcomeLiveLabel: "in progress",
    outcomeFailedLabel: "failed",
    delegatedBriefLabel: "Delegated brief",
    copyBriefLabel: "Copy brief",
    briefCopiedNotice: "Brief copied.",
    briefCopyErrorNotice: "Could not copy. Select the brief text to copy it.",
    agentOpeningNotice: "Opening the agent's session…",
    agentOpenFailedNotice: "This agent's session could not be opened.",
    agentEmptyNotice: "Nothing yet.",
    agentResultHeading: "Result",
    agentReasonHeading: "Reason",
    agentWorkingStatus: "Working",
    agentCancelledStatus: "Cancelled",
    agentFailedStatus: "Failed",
    agentCompletedStatus: "Completed",
    agentAskingApprovalStatus: "awaiting approval",
    agentAskingQuestionStatus: "has a question",
  },
  composer: {
    promptLabel: "Message",
    promptPlaceholder: "Ask anything, paste images, or type / for skills",
    sendLabel: "Send",
    stopLabel: "Stop",
    attachImageLabel: "Add image",
    removeAttachmentLabel: "Remove attachment",
    dropHint: "Drop here",
    attachmentsLabel: "Pictures",
    modelLabel: "Model",
    effortLabel: "Reasoning effort",
    permissionModeLabel: "Permission mode",
    slashCommandsLabel: "Skills",
    noSlashMatches: "No matching skills",
    acknowledgementHeading: "Acknowledgement",
    permissionsHeading: "Permissions",
    allowLabel: "Allow",
    allowAlwaysLabel: "Always allow",
    denyLabel: "Deny",
  },
  workspace: {
    sessionsLabel: "Sessions",
    newSessionLabel: "New session",
    projectsLabel: "Projects",
    addProjectLabel: "Open project",
    settingsLabel: "Settings",
    filesLabel: "Files",
    closeSidebarLabel: "Close sidebar",
    openSidebarLabel: "Open sidebar",
    welcomeHeading: "Start a session",
    welcomeHint: "Choose a workspace or connect a runtime to begin.",
    connectTitle: "Connect provider",
    connectCodeHint: "Enter the pairing code to authorize this device.",
    connectingLabel: "Connecting…",
    connectedLabel: "Connected",
    offlineNotice: "Runtime disconnected",
    reconnectAction: "Reconnect",
  },
  settings: {
    title: "Settings",
    navigationLabel: "Settings sections",
    connectionsSection: "Connections",
    mcpSection: "MCP servers",
    pluginsSection: "Plugins",
    skillsSection: "Skills",
    botsSection: "Bots",
    runtimeSection: "Runtime",
    emptySection: "Nothing configured yet.",
    addLabel: "Add",
    deleteLabel: "Delete",
    enabledLabel: "Enabled",
    disabledLabel: "Disabled",
  },
};

/** Merges partial white-label or localized copy overrides onto a base {@link VoiceCatalog}. */
export function defineVoiceCatalog(
  overrides: VoiceCatalogOverrides,
  base: VoiceCatalog = enVoiceCatalog,
): VoiceCatalog {
  return {
    common: { ...base.common, ...overrides.common },
    dialog: { ...base.dialog, ...overrides.dialog },
    select: { ...base.select, ...overrides.select },
    date: { ...base.date, ...overrides.date },
    navigation: { ...base.navigation, ...overrides.navigation },
    transcript: { ...base.transcript, ...overrides.transcript },
    composer: { ...base.composer, ...overrides.composer },
    workspace: { ...base.workspace, ...overrides.workspace },
    settings: { ...base.settings, ...overrides.settings },
  };
}

const VoiceContext = createContext<VoiceCatalog>(enVoiceCatalog);

export interface VoiceProviderProps {
  /** Full catalog or partial overrides merged onto the parent provider's catalog. */
  readonly catalog: VoiceCatalog | VoiceCatalogOverrides;
  readonly children?: ReactNode;
}

/** Supplies white-label or localized UI strings to descendant primitives and blocks. */
export function VoiceProvider({ catalog, children }: VoiceProviderProps) {
  const parentCatalog = useContext(VoiceContext);
  const merged = useMemo(() => defineVoiceCatalog(catalog, parentCatalog), [catalog, parentCatalog]);
  return <VoiceContext.Provider value={merged}>{children}</VoiceContext.Provider>;
}

/** Reads the active {@link VoiceCatalog} from the nearest {@link VoiceProvider}. */
export function useVoice(): VoiceCatalog {
  return useContext(VoiceContext);
}
