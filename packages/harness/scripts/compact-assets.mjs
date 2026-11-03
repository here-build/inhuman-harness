import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_COMPACT_PROMPT,
  DEFAULT_COMPACT_REVISION,
  DEFAULT_COMPACT_SOURCE,
} from "@inhuman.tools/turn/resources";

const check = process.argv.includes("--check");
const revision = `sha256:${createHash("sha256").update(DEFAULT_COMPACT_SOURCE).update("\0").update(DEFAULT_COMPACT_PROMPT).digest("hex")}`;
if (revision !== DEFAULT_COMPACT_REVISION) throw new Error("compaction resource revision does not match its content");
for (const [name, content] of [
  ["compact.scm", DEFAULT_COMPACT_SOURCE],
  ["compact.prompt", DEFAULT_COMPACT_PROMPT],
]) {
  const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
  if (check) {
    if ((await readFile(path, "utf8")) !== content) throw new Error(`compaction compatibility asset differs: ${path}`);
  } else {
    await writeFile(path, content);
  }
}
