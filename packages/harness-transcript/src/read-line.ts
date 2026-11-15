import { workspacePath } from "@inhuman.tools/harness-model/session";

export {
  type FileFace,
  fileFace,
  looksBinary,
  type ReadPart,
  readListParts,
  searchLabels,
} from "@inhuman.tools/harness-ui/blocks/read-line";

/**
 * In-project paths stay relative. Anything `workspacePath` leaves absolute
 * (starts with `/` or climbs with `..`) stays absolute.
 */
export function displayPath(projectPath: string, raw: string): string {
  const shown = workspacePath(projectPath, raw);
  if (shown.startsWith("/") || shown.split("/").includes("..")) return shown;
  return shown;
}
