import { createContext, useContext, type ReactNode } from "react";
import type { RegionGraph } from "@here.build/arrival-provenance";
import type { KernelRoot, SessionDocument, SessionRoot, SessionTurn, ToolCallJob } from "@inhuman.tools/harness-model";

import type { ToolBody, ToolOutcome } from "./tool-receipt.js";

/** Project directory summary read by workspace home and navigation fallbacks. */
export interface TranscriptProjectRoot {
  readonly path: string;
  readonly sessions: Readonly<Record<string, string>>;
}

/** Host-provided presentation override for a single tool invocation row. */
export interface ToolCallPresentation {
  readonly title?: ReactNode;
  readonly subtitle?: ReactNode;
  readonly body?: ToolBody;
}

/** Normalized metadata for formatting a tool call cell via {@link TranscriptHost.formatToolCall}. */
export interface ToolCallDescriptor {
  readonly name: string;
  readonly args: unknown;
  readonly completed: boolean;
  readonly outcome: ToolOutcome;
  readonly outcomeSnap: ToolCallJob["outcomeSnap"];
  readonly genericBody: boolean;
}

/** Reactive host adapter connecting the transcript tape to a runtime/client transport. */
export interface TranscriptHost {
  readonly session: { readonly root: SessionRoot } | null;
  readonly project: { readonly root: TranscriptProjectRoot } | null;
  readonly kernel: { readonly root: KernelRoot } | null;
  readonly link: unknown;
  readonly attaching: boolean;
  readonly requestedTarget: { readonly kind: string; readonly path?: string; readonly sessionId?: string };
  readonly projects: ReadonlyMap<string, { readonly root: TranscriptProjectRoot }>;
  readonly sessionRpc: { request(method: string, params: unknown): Promise<unknown> } | null;
  peek(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<{ doc: SessionDocument; release(): void; controls?: ReactNode }>;
  workflow?(
    sessionId: string,
    jobUuid: string,
    onFrame: (graph: RegionGraph | null, done: boolean) => void,
    signal: AbortSignal,
  ): void;
  canEditMessages?(): boolean;
  editMessage?(turn: SessionTurn): Promise<void>;
  renderLinkNotice?(): ReactNode;
  formatToolCall?(call: ToolCallDescriptor): ToolCallPresentation | null | undefined;
  renderAnnotation?(kind: "progress" | "thoughts", content: ReactNode): ReactNode;
}

const disconnectedHost: TranscriptHost = {
  session: null,
  project: null,
  kernel: null,
  link: null,
  attaching: false,
  requestedTarget: { kind: "kernel" },
  projects: new Map(),
  sessionRpc: null,
  peek: async () => {
    throw new Error("TranscriptHost peek unavailable");
  },
};

const TranscriptHostContext = createContext<TranscriptHost>(disconnectedHost);

export interface TranscriptProviderProps {
  /** Host runtime adapter providing active session, kernel directory, RPC, and modal peek access. */
  readonly host: TranscriptHost;
  readonly children?: ReactNode;
}

/** Seats a runtime {@link TranscriptHost} for descendant transcript and workflow components. */
export function TranscriptProvider({ host, children }: TranscriptProviderProps) {
  return <TranscriptHostContext.Provider value={host}>{children}</TranscriptHostContext.Provider>;
}

/** Reads the seated {@link TranscriptHost} from {@link TranscriptProvider}. */
export function useTranscriptHost(): TranscriptHost {
  return useContext(TranscriptHostContext);
}
