/**
 * Labeled blocks appended to the standing constitution.
 * File order is `discoverInstructions`.
 */
import { discoverInstructions } from "@inhuman.tools/project-instructions";

/** Base constitution plus a labeled block per discovered file. */
export function withInstructions(base: string, cwd: string): string {
  const sources = discoverInstructions(cwd);
  if (sources.length === 0) return base;
  const blocks = sources.map((source) => `Instructions from ${source.path}:\n${source.text}`);
  return `${base}\n\n${blocks.join("\n\n")}`;
}
