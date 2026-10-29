import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ErrorWithInvariant } from "@inhuman.tools/error-with-invariant";

export class DecideError extends ErrorWithInvariant {
  override readonly name = "DecideError";
}

const programPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../authorize.scm");

let cached: string | undefined;

export function authorizationProgram(): string {
  if (cached !== undefined) return cached;
  cached = readFileSync(programPath, "utf8");
  return cached;
}

/** A set `POLICY_AUTHORIZE` that cannot be read is an error, not the dist script. */
export function authorizationSource(override?: string, env?: NodeJS.ProcessEnv): string {
  const inline = override?.trim();
  if (inline) return inline;
  const file = env?.POLICY_AUTHORIZE?.trim();
  if (file === undefined || file === "") return authorizationProgram();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "ENOENT") throw new DecideError(`authorization program not found: ${file}`);
    throw error;
  }
  const source = text.trim();
  if (source === "") throw new DecideError("authorization program is empty");
  return text;
}
