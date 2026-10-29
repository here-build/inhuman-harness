/**
 * Vendored pure-parse slice of @pierre/diffs@1.2.12 (Apache-2.0).
 * Origin: https://www.npmjs.com/package/@pierre/diffs
 * Upstream: dist/constants.js (subset used by parsePatchFiles only).
 * See NOTICE and APACHE-2.0-LICENSE.md in this directory.
 */

export const COMMIT_METADATA_SPLIT = /(?=^From [a-f0-9]+ .+$)/m;
export const GIT_DIFF_FILE_BREAK_REGEX = /(?=^diff --git)/gm;
export const FILENAME_HEADER_REGEX = /^(---|\+\+\+)\s+([^\t\r\n]+)/;
export const FILENAME_HEADER_REGEX_GIT = /^(---|\+\+\+)\s+[ab]\/([^\t\r\n]+)/;
export const ALTERNATE_FILE_NAMES_GIT = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+))$/;
export const INDEX_LINE_METADATA = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/i;
