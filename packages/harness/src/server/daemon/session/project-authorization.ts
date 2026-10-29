/**
 * The project layer of the authorization table: `<repo>/.inhuman/authorization.json`. Anyone with
 * repo access can write it, so it can only tighten (the resolution table enforces that), and it is
 * loaded without a trust check. A file that does not parse is a tightening to "a person decides"
 * (the model layer reads the raw text and marks it invalid), never "ignored". The agent cannot write
 * the file: `.inhuman/authorization.json` is on the dist `write_block` list.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** How often a running session looks at the project file again. */
export const PROJECT_LAYER_POLL_MS = 2_000;

/** Raw text of the file, or "" when there is none. A read error other than "missing" is a tightening. */
export function readProjectAuthorization(projectPath: string): string {
  try {
    const text = readFileSync(join(projectPath, ".inhuman", "authorization.json"), "utf8");
    return text.trim() === "" ? "" : text;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return "";
    // Unreadable (permissions, a directory): same as unparseable.
    return "\0unreadable";
  }
}
