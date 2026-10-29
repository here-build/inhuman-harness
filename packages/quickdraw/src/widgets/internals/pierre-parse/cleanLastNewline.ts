/**
 * Vendored from @pierre/diffs@1.2.12 dist/utils/cleanLastNewline.js (Apache-2.0).
 * See NOTICE in this directory.
 */
export function cleanLastNewline(contents: string): string {
  return contents.replace(/\n$|\r\n$/, "");
}
