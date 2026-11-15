import type { DiffInput } from "@inhuman.tools/harness-transcript/diff-model";
import { DiffView as TranscriptDiffView } from "@inhuman.tools/harness-transcript/diff-view";
import { SyntaxHighlightProvider, useSyntaxHighlighter } from "@inhuman.tools/harness-ui";

import { wasmSyntaxHighlighter } from "./highlight.js";

/** Web-app DiffView adapter pre-wired with the WASM syntax highlighter when no outer provider supplies one. */
export function DiffView(props: DiffInput) {
  const outer = useSyntaxHighlighter();
  const node = <TranscriptDiffView {...props} />;
  if (outer.highlightDiff != null) return node;
  return <SyntaxHighlightProvider highlighter={wasmSyntaxHighlighter}>{node}</SyntaxHighlightProvider>;
}
