import { platform } from "node:os";

// todo this needs to be reworked - this is used as synthetic "run if local" logic;
// it is wrong - it should be explicit non-running-by-default test suite that hard crashes if it's not on mac,
// or terminal needed is missing, or OSA scripting is not available

export function isDarwin(): boolean {
  return platform() === "darwin";
}
