/**
 * The kernel folder is itself an npm project: `inhuman install` runs `npm install --save` in it. npm rejects
 * `workspace:` specs, so the seeded dependency ranges must be real semver ranges.
 */
import { mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const FALLBACK_RANGE = "^0.1.0";

/** Packages every kernel starts with, by name. The range comes from the copy this daemon resolves. */
export const KERNEL_SEED_PACKAGES = [
  "@inhuman.tools/plugin-tasks",
  "@inhuman.tools/plugin-fusion",
  "@inhuman.tools/plugin-goal",
  "@inhuman.tools/plugin-offload-tingle",
] as const;

export function isSeedPackage(name: string): name is (typeof KERNEL_SEED_PACKAGES)[number] {
  return (KERNEL_SEED_PACKAGES as readonly string[]).includes(name);
}

/** Package root on disk for a bundled seed package, or null if not a seed package or not resolvable. */
export function resolveSeedPackageRoot(
  name: string,
  require: NodeJS.Require = createRequire(import.meta.url),
): string | null {
  if (!isSeedPackage(name)) return null;
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/** Ensure `<kernelRoot>/node_modules/<npmName>` links to `packageRoot`. */
export function linkSeedPackage(kernelRoot: string, npmName: string, packageRoot: string): void {
  const dest = join(kernelRoot, "node_modules", npmName);
  mkdirSync(dirname(dest), { recursive: true });
  // existsSync follows links. A dangling symlink looks absent, and symlinkSync then throws EEXIST.
  try {
    if (readlinkSync(dest) === packageRoot) return;
    unlinkSync(dest);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EINVAL") return;
    if (code !== "ENOENT") throw error;
  }
  symlinkSync(packageRoot, dest);
}

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
