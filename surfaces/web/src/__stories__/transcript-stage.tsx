import { useState } from "react";
import { Tape } from "@inhuman.tools/harness-transcript";

import type { Staged } from "./story-app.js";
import { DialProvider } from "../client/context.js";
import { FilePreviewPane, FilePreviewProvider } from "../shell/file-sidebar.js";
import { readTarget } from "../shell/path.js";

/**
 * The transcript on its own. The story's dial is seated the way the router would seat it,
 * and the page stops at the tape: no composer, no model picker.
 */
export function TranscriptStage({ stage }: { readonly stage: () => Staged }) {
  const [world] = useState(() => {
    const next = stage();
    void next.dial.follow(readTarget(next.at));
    return next;
  });
  const root = world.dial.session?.root;
  return (
    <DialProvider dial={world.dial.asDial}>
      <FilePreviewProvider resetKey={root?.sessionId ?? null}>
        <div className="frame">
          <main className="tape" aria-label="Conversation">
            <Tape />
          </main>
          <FilePreviewPane projectPath={root?.path ?? ""} />
        </div>
      </FilePreviewProvider>
    </DialProvider>
  );
}
