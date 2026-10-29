/**
 * Executable identity for the floor. Path-form argv0 is the named command
 * iff `which` returns the same path; otherwise it stays a path.
 * No process-lifetime cache — PATH/cwd are part of identity.
 */

import { execFileSync } from "node:child_process";

import { resolveKnown, type Which } from "@inhuman.tools/policy-bash-disassembler";

export function whichOnPath(name: string): string | undefined {
  if (name === "" || name.includes("/") || name.includes("\0")) return undefined;
  try {
    const out = execFileSync("which", [name], { encoding: "utf8", timeout: 1000 }).trim();
    return out === "" ? undefined : out.split("\n")[0];
  } catch {
    return undefined;
  }
}

/** Path-form argv0 rewritten to the known name, or the original token. */
export function identityName(raw: string, known: ReadonlySet<string>, which: Which | undefined): string {
  return resolveKnown(raw, known, which) ?? raw;
}

export { type Which } from "@inhuman.tools/policy-bash-disassembler";
