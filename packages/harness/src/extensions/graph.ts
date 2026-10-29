/**
 * CONSENT IS REACHABILITY. Install-root `package.json` `dependencies` are the
 * whitelist. `node_modules` is not scanned. A dep is a plugin iff it carries
 * `plugin.json`; libraries are opaque — the walk does not continue through them.
 *
 * Identity is `plugin.json` `name`. npm name is provenance.
 *
 * Two views, one walk, post-order (deps before dependents):
 *   presence — reachable plugins. No enablement.
 *   load     — enabled-pruned. Disable drops the node and anything reachable
 *              only through it. A diamond keeps a shared dep via another
 *              enabled parent. Dependents last ⇒ later-wins on colliding verbs.
 *
 * Package roots stay `node_modules` paths. Do not realpath — path installs
 * are live symlinks.
 */
import { join } from "node:path";

import fs from "fs-extra";

import { existsAsFile, isDirectory } from "./fs.js";
import { packageJsonPeekSchema, pluginJsonNameSchema } from "./schemas/plugin-manifest.js";

type PluginGraphNode = {
  readonly pluginName: string;
  readonly npmName: string;
  readonly root: string;
  readonly version: string;
  readonly pluginDeps: readonly string[];
};

function readDependencyNames(packageDir: string): readonly string[] {
  try {
    const parsed = packageJsonPeekSchema.safeParse(fs.readJsonSync(join(packageDir, "package.json")));
    if (!parsed.success) return [];
    const deps = parsed.data.dependencies;
    if (deps == null) return [];
    return Object.keys(deps);
  } catch {
    return [];
  }
}

function readPluginName(packageDir: string, errors: string[]): string | null {
  const manifestPath = join(packageDir, "plugin.json");
  try {
    const parsed = pluginJsonNameSchema.safeParse(fs.readJsonSync(manifestPath));
    if (!parsed.success) {
      errors.push(`${manifestPath}: plugin.json has no usable name — plugin skipped`);
      return null;
    }
    return parsed.data.name;
  } catch {
    if (!existsAsFile(manifestPath)) return null;
    errors.push(`${manifestPath}: plugin.json is not valid JSON — plugin skipped`);
    return null;
  }
}

export function buildPluginGraph(options: {
  readonly installRoot: string;
  /** Absent name ⇒ enabled. */
  readonly isEnabled?: (pluginName: string) => boolean;
}): {
  readonly presence: readonly PluginGraphNode[];
  readonly load: readonly PluginGraphNode[];
  readonly errors: readonly string[];
} {
  const isEnabled = options.isEnabled ?? (() => true);
  const errors: string[] = [];
  const presence: PluginGraphNode[] = [];
  const settled = new Map<string, PluginGraphNode | undefined>();
  const open = new Set<string>();

  const visit = (npmName: string, fromDir: string, via: string): PluginGraphNode | undefined => {
    if (open.has(npmName)) return undefined;
    if (settled.has(npmName)) return settled.get(npmName);
    open.add(npmName);

    const nested = join(fromDir, "node_modules", npmName);
    const hoisted = join(options.installRoot, "node_modules", npmName);
    const dir = isDirectory(nested) ? nested : isDirectory(hoisted) ? hoisted : null;
    if (dir === null) {
      errors.push(
        `plugin dep "${npmName}" (via ${via}) declared but not installed — run npm install in the harness root`,
      );
      settled.set(npmName, undefined);
      open.delete(npmName);
      return undefined;
    }
    const pluginName = readPluginName(dir, errors);
    if (pluginName === null) {
      settled.set(npmName, undefined);
      open.delete(npmName);
      return undefined;
    }

    let packageName = "";
    let version = "";
    try {
      const parsed = packageJsonPeekSchema.safeParse(fs.readJsonSync(join(dir, "package.json")));
      if (parsed.success) {
        if (typeof parsed.data.name === "string") packageName = parsed.data.name;
        if (typeof parsed.data.version === "string") version = parsed.data.version;
      }
    } catch {}
    const pluginDeps: string[] = [];
    for (const dep of readDependencyNames(dir)) {
      if (visit(dep, dir, `${via} → ${npmName}`) !== undefined) pluginDeps.push(dep);
    }

    const node: PluginGraphNode = {
      pluginName,
      npmName: packageName || npmName,
      root: dir,
      version,
      pluginDeps,
    };
    settled.set(npmName, node);
    open.delete(npmName);
    presence.push(node);
    return node;
  };

  const rootDeps = readDependencyNames(options.installRoot);
  for (const dep of rootDeps) visit(dep, options.installRoot, "package.json");

  const load: PluginGraphNode[] = [];
  const loadVisited = new Set<string>();
  const visitLoad = (npmName: string): void => {
    if (loadVisited.has(npmName)) return;
    loadVisited.add(npmName);
    const node = settled.get(npmName);
    if (node === undefined) return;
    if (!isEnabled(node.pluginName)) return;
    for (const dep of node.pluginDeps) visitLoad(dep);
    load.push(node);
  };
  for (const dep of rootDeps) visitLoad(dep);

  return { presence, load, errors };
}
