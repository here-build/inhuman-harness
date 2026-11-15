import { createContext, useContext, type ReactNode } from "react";
import type { RegionGraph } from "@here.build/arrival-provenance";
import type { KernelRoot, SessionDocument, SessionRoot, SessionTurn } from "@inhuman.tools/harness-model";

/** Project directory summary read by workspace home and navigation fallbacks. */
export interface TranscriptProjectRoot {
  readonly path: string;
  readonly sessions: Readonly<Record<string, string>>;
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
  peek(sessionId: string, signal: AbortSignal): Promise<{ doc: SessionDocument; release(): void }>;
  workflow?(
    sessionId: string,
    jobUuid: string,
    onFrame: (graph: RegionGraph | null, done: boolean) => void,
    signal: AbortSignal,
  ): void;
  canEditMessages?(): boolean;
  editMessage?(turn: SessionTurn): Promise<void>;
  renderLinkNotice?(): ReactNode;
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
