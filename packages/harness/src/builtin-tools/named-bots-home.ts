import { homedir } from "node:os";
import { join } from "node:path";

/** Toolkit named tree. `VITEST` without `INHUMAN_HOME` stays closed so tests do not touch `~/.inhuman`. */
export function namedBotsHome(): string | undefined {
  const override = process.env.INHUMAN_HOME?.trim();
  if (override !== undefined && override !== "") return join(override, "bots");
  if (process.env.VITEST) return undefined;
  return join(homedir(), ".inhuman", "bots");
}
