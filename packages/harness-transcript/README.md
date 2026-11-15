# `@inhuman.tools/harness-transcript`

Live session transcript tape, diff viewer, tool receipts, and causal workflow graph components decoupled from host routing and WASM bindings.

## Subpath Exports

- `@inhuman.tools/harness-transcript`: Main `Tape`, `BeatTimeline`, `ToolBodyView`, and `Outcome`.
- `./context`: `TranscriptProvider` and `TranscriptHost` adapter interface (active session, kernel/project roots, RPC transport, `peek`, workflow stream, edit hook, link notice).
- `./diff-view`, `./diff-model`: Unified/split diff projection and `@pierre/diffs` renderer reading the outer `SyntaxHighlightProvider`.
- `./tool-receipt`, `./read-line`, `./blob-cache`, `./tape-read`, `./tape-live`, `./tape-beats`, `./session-reducer`, `./scheme-unwrap`, `./tool-label`, `./row-title`: Framework-agnostic transcript reducers and formatting helpers.
- `./workflow/*`: Causal DAG / ELK layout engines and workflow graph views (`workflow-graph`, `use-workflow-graph`, `use-region-graph`, `region-elk-layout`, `feed`, `causal`).

## Host Wiring

Wrap `Tape` in `TranscriptProvider` (and optionally `FilePreviewProvider` / `SyntaxHighlightProvider` from `@inhuman.tools/harness-ui`):

```tsx
import { Tape } from "@inhuman.tools/harness-transcript";
import { TranscriptProvider, type TranscriptHost } from "@inhuman.tools/harness-transcript/context";
import { registerLanguageGuesser } from "@inhuman.tools/harness-transcript/tool-receipt";
import { FilePreviewProvider, SyntaxHighlightProvider } from "@inhuman.tools/harness-ui";

registerLanguageGuesser(customGuessLang);

export function HostTranscript({ host }: { readonly host: TranscriptHost }) {
  return (
    <SyntaxHighlightProvider highlighter={customHighlighter}>
      <FilePreviewProvider resetKey={host.session?.root.sessionId ?? "empty"}>
        <TranscriptProvider host={host}>
          <Tape />
        </TranscriptProvider>
      </FilePreviewProvider>
    </SyntaxHighlightProvider>
  );
}
```

MIT
