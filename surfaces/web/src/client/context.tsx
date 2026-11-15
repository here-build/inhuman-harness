import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { bindBlobCache } from "@inhuman.tools/harness-transcript/blob-cache";
import { type TranscriptHost, TranscriptProvider } from "@inhuman.tools/harness-transcript/context";
import { registerLanguageGuesser } from "@inhuman.tools/harness-transcript/tool-receipt";
import { SyntaxHighlightProvider } from "@inhuman.tools/harness-ui";

import type { Dial } from "./dial.js";
import { canEditMessages, editMessage } from "../shell/edit-message.js";
import { wasmSyntaxHighlighter } from "../shell/highlight.js";
import { LinkNotice } from "../shell/link-notice.js";
import { wasmGuessLang } from "../shell/syntax-wasm.js";

registerLanguageGuesser(wasmGuessLang);

const DialContext = createContext<Dial | null>(null);

/** Adapts a reference {@link Dial} controller into a {@link TranscriptHost} for `@inhuman.tools/harness-transcript`. */
export function createDialTranscriptHost(dial: Dial): TranscriptHost {
  return {
    get session() {
      return dial.session;
    },
    get project() {
      return dial.project;
    },
    get kernel() {
      return dial.kernel;
    },
    get link() {
      return dial.link;
    },
    get attaching() {
      return dial.attaching;
    },
    get requestedTarget() {
      return dial.requestedTarget;
    },
    get projects() {
      return dial.projects;
    },
    get sessionRpc() {
      return dial.sessionRpc;
    },
    peek: (sessionId, signal) => dial.peek(sessionId, signal),
    workflow: (sessionId, jobUuid, onFrame, signal) => dial.workflow(sessionId, jobUuid, onFrame, signal),
    canEditMessages: () => canEditMessages(dial),
    editMessage: (turn) => editMessage(dial, turn),
    renderLinkNotice: () => <LinkNotice />,
  };
}

export function DialProvider({ children, dial }: { readonly children: ReactNode; readonly dial: Dial }) {
  // The tape reads blob text through this cache; it asks the daemon on the session that is open now.
  useEffect(
    () =>
      bindBlobCache(async (method, params) => {
        const port = dial.sessionRpc;
        if (port === null) throw new Error("blobs: no session is open");
        return port.request(method, params);
      }),
    [dial],
  );
  const host = useMemo(() => createDialTranscriptHost(dial), [dial]);
  return (
    <DialContext.Provider value={dial}>
      <SyntaxHighlightProvider highlighter={wasmSyntaxHighlighter}>
        <TranscriptProvider host={host}>{children}</TranscriptProvider>
      </SyntaxHighlightProvider>
    </DialContext.Provider>
  );
}

export function useDial(): Dial {
  const dial = useContext(DialContext);
  if (dial == null) throw new Error("DialProvider missing");
  return dial;
}
