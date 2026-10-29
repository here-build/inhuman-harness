/**
 * The kernel folder is itself an npm project: `harness install` runs `npm install --save` in it. npm rejects
 * `workspace:` specs, so the seeded dependency ranges must be real semver ranges.
 */
import { createRequire } from "node:module";

const FALLBACK_RANGE = "^0.1.0";

/** Packages every kernel starts with, by name. The range comes from the copy this daemon resolves. */
export const KERNEL_SEED_PACKAGES = ["@inhuman.tools/plugin-tasks"] as const;

/** `^<version>` of the resolved package, or the fixed fallback when it cannot be resolved. */
export function seedRange(name: string, require: NodeJS.Require = createRequire(import.meta.url)): string {
  try {
    const manifest = require(`${name}/package.json`) as { version?: unknown };
    if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version)) {
      return `^${manifest.version}`;
    }
  } catch {
    /* not resolvable: fall back */
  }
  return FALLBACK_RANGE;
}

/** Add missing seed packages and rewrite any `workspace:` spec to a real range. Returns whether anything changed. */
export function healKernelDependencies(
  deps: Record<string, string>,
  resolveRange: (name: string) => string = (name) => seedRange(name),
): boolean {
  let changed = false;
  for (const name of KERNEL_SEED_PACKAGES) {
    const recorded = deps[name];
    if (recorded != null && !recorded.startsWith("workspace:")) continue;
    deps[name] = resolveRange(name);
    changed = true;
  }
  for (const [name, range] of Object.entries(deps)) {
    if (!range.startsWith("workspace:")) continue;
    deps[name] = resolveRange(name);
    changed = true;
  }
  return changed;
}
