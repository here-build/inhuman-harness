/**
 * Types for the vendored @pierre/diffs@1.2.12 parse surface (Apache-2.0).
 * Origin types: package dist/types.d.ts — FileContents / hunk metadata only.
 * See NOTICE in this directory.
 */

export interface FileContents {
  name: string;
  contents: string;
  lang?: string;
  header?: string;
  cacheKey?: string;
}

export type ChangeTypes = "change" | "rename-pure" | "rename-changed" | "new" | "deleted";

export interface ContextContent {
  type: "context";
  lines: number;
  additionLineIndex: number;
  deletionLineIndex: number;
}

export interface ChangeContent {
  type: "change";
  deletions: number;
  deletionLineIndex: number;
  additions: number;
  additionLineIndex: number;
}

export interface Hunk {
  collapsedBefore: number;
  additionStart: number;
  additionCount: number;
  additionLines: number;
  additionLineIndex: number;
  deletionStart: number;
  deletionCount: number;
  deletionLines: number;
  deletionLineIndex: number;
  hunkContent: (ContextContent | ChangeContent)[];
  hunkContext?: string;
  hunkSpecs?: string;
  splitLineStart: number;
  splitLineCount: number;
  unifiedLineStart: number;
  unifiedLineCount: number;
  noEOFCRDeletions: boolean;
  noEOFCRAdditions: boolean;
}

export interface FileDiffMetadata {
  name: string;
  prevName?: string;
  lang?: string;
  newObjectId?: string;
  prevObjectId?: string;
  mode?: string;
  prevMode?: string;
  type: ChangeTypes;
  hunks: Hunk[];
  splitLineCount: number;
  unifiedLineCount: number;
  /**
   * LINE BUFFERS. Full-file sides iff `!isPartial`. Compact hunk-touched
   * lines iff `isPartial`. Treating a partial parse as a whole file invents
   * context Pierre never saw.
   */
  isPartial: boolean;
  deletionLines: string[];
  additionLines: string[];
  cacheKey?: string;
}

export interface ParsedPatch {
  patchMetadata?: string;
  files: FileDiffMetadata[];
}
