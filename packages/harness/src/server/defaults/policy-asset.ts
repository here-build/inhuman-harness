import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";

const TURN_PACKAGE = "@inhuman.tools/turn";

/** `name` is a file under `@inhuman.tools/turn/policy`, which this daemon does not ship. */
export function shippedPolicyFile(name: string): string {
  const manifest = findPackageJSON(TURN_PACKAGE, import.meta.url);
  if (manifest === undefined) throw new Error(`${TURN_PACKAGE} is not installed`);
  return join(dirname(manifest), "policy", name);
}
