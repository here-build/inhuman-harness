import { homedir } from "node:os";
import { join } from "node:path";

/** Home API. Tests isolate under the kernel root (`VITEST`) or `INHUMAN_HOME`. */
export function defaultBotsHome(kernelRoot: string): string {
  const override = process.env.INHUMAN_HOME?.trim();
  if (override !== undefined && override !== "") return join(override, "bots");
  if (process.env.VITEST) return join(kernelRoot, "bots-home");
  return join(homedir(), ".inhuman", "bots");
}

export function projectBotsDir(projectPath: string): string {
  return join(projectPath, ".inhuman", "bots");
}
