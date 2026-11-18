import { glyph, useVoice } from "@inhuman.tools/harness-ui";
import { IconLoader2 } from "@tabler/icons-react";

import type { ToolOutcome } from "./tool-receipt.js";

/** Tool and workflow leaf lifecycle badge (`live`, `failed`, or nothing when `ok`). */
export function Outcome({ outcome }: { readonly outcome: ToolOutcome }) {
  const voice = useVoice();
  if (outcome === "ok") return null;
  if (outcome === "live") {
    return (
      <span className="tool-outcome" data-outcome="live" role="status">
        <IconLoader2 className="tool-spinner" {...glyph} aria-label={voice.transcript.outcomeLiveLabel} />
      </span>
    );
  }
  return (
    <span className="tool-outcome label" data-outcome="failed">
      {voice.transcript.outcomeFailedLabel}
    </span>
  );
}
