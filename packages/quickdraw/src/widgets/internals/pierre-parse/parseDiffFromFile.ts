/**
 * Vendored from @pierre/diffs@1.2.12 dist/utils/parseDiffFromFile.js (Apache-2.0).
 * Origin: package @pierre/diffs — pure two-file diff → FileDiffMetadata.
 * See NOTICE and APACHE-2.0-LICENSE.md in this directory.
 *
 * Modifications: TypeScript typing; uses npm `diff` createTwoFilesPatch (same
 * as upstream). No intentional algorithm changes.
 */
import * as Diff from "diff";
import invariant from "tiny-invariant";

import { processFile } from "./parsePatchFiles.js";
import type { FileContents, FileDiffMetadata } from "./types.js";

/** Subset of jsdiff createTwoFilesPatch options we pass through. */
export type ParseDiffOptions = {
  context?: number;
  /** jsdiff accepts additional flags; we forward the object as-is. */
  [key: string]: unknown;
};

// diff@7 ships createTwoFilesPatch at runtime; its public .d.ts is incomplete.
const createTwoFilesPatch = (
  Diff as unknown as {
    createTwoFilesPatch: (
      oldFileName: string,
      newFileName: string,
      oldStr: string,
      newStr: string,
      oldHeader?: string,
      newHeader?: string,
      options?: ParseDiffOptions,
    ) => string;
  }
).createTwoFilesPatch;

/**
 * Parses a diff from two file contents objects.
 *
 * If both `oldFile` and `newFile` have a `cacheKey`, the resulting diff will
 * automatically get a combined cache key in the format `oldKey:newKey`.
 */
export function parseDiffFromFile(
  oldFile: FileContents,
  newFile: FileContents,
  options?: ParseDiffOptions,
  throwOnError = false,
): FileDiffMetadata {
  const patch = createTwoFilesPatch(
    oldFile.name,
    newFile.name,
    oldFile.contents,
    newFile.contents,
    oldFile.header,
    newFile.header,
    options,
  );

  const fileData = processFile(patch, {
    cacheKey: (() => {
      if (oldFile.cacheKey != null && newFile.cacheKey != null) {
        return `${oldFile.cacheKey}:${newFile.cacheKey}`;
      }
      return undefined;
    })(),
    oldFile,
    newFile,
    throwOnError,
  });
  invariant(
    fileData != null,
    "parseDiffFrom: FileInvalid diff -- probably need to fix something -- if the files are the same maybe?",
  );
  if (newFile.lang != null) {
    fileData.lang = newFile.lang;
  }
  return fileData;
}
