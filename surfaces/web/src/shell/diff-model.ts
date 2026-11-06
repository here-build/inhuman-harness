import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";

export type DiffInput = {
  readonly oldText: string;
  readonly newText: string;
  readonly path: string;
  readonly lineStart?: number;
};

export type DiffProjection =
  { readonly status: "empty" | "same" } | { readonly status: "diff"; readonly fileDiff: FileDiffMetadata };

/** Keep whole files for syntax highlighting; Pierre folds unchanged context at render time. */
export function projectDiff({ oldText, newText, path, lineStart }: DiffInput): DiffProjection {
  const old = withTrailingNl(oldText);
  const next = withTrailingNl(newText);
  if (old === next) return { status: old === "" ? "empty" : "same" };
  const name = path || "file";
  const fileDiff = parseDiffFromFile(
    old === "" ? null : { name, contents: old },
    next === "" ? null : { name, contents: next },
    { context: 3 },
  );
  if (lineStart != null && Number.isFinite(lineStart) && lineStart > 1) {
    // Only this span is known. Move displayed file numbers, not indices into
    // the source arrays, and never offer expansion into unavailable content.
    const offset = Math.floor(lineStart) - 1;
    fileDiff.isPartial = true;
    fileDiff.hunks = fileDiff.hunks.map((hunk) => ({
      ...hunk,
      additionStart: hunk.additionStart + offset,
      deletionStart: hunk.deletionStart + offset,
      hunkSpecs: undefined,
    }));
  }
  return { status: "diff", fileDiff };
}

/** Match the TUI: a missing final newline is not a painted edit. */
function withTrailingNl(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}
