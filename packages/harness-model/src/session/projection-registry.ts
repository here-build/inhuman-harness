/**
 * Kernel-owned projection formulas. Bound per session root — not a process Map.
 * `install` is the only writer: clear + reseed so a disabled pack drops out of the projection.
 */
import { docPlexus } from "@here.build/plexus/internals";
import { action, observable } from "mobx";

import type { HostPluginProjection } from "./trajectory-projection.js";

type PluginWithProjection = { readonly projection?: HostPluginProjection<any, any> };

export type ProjectionInstall = {
  readonly pluginName: string;
  readonly projection?: HostPluginProjection<any, any>;
  readonly plugin?: PluginWithProjection;
};

export type ProjectionRoster = Iterable<ProjectionInstall> | Readonly<Record<string, PluginWithProjection>>;

function* projectionRows(plugins: ProjectionRoster): Iterable<ProjectionInstall> {
  if (Array.isArray(plugins) || typeof (plugins as Iterable<ProjectionInstall>)[Symbol.iterator] === "function") {
    yield* plugins as Iterable<ProjectionInstall>;
    return;
  }
  for (const [pluginName, plugin] of Object.entries(plugins as Readonly<Record<string, PluginWithProjection>>)) {
    yield { pluginName, plugin };
  }
}

export class PluginProjectionRegistry {
  readonly #map = observable.map<string, HostPluginProjection<any, any>>(new Map(), { deep: false });

  @action
  install(plugins: ProjectionRoster): void {
    this.#map.clear();
    for (const row of projectionRows(plugins)) {
      const id = row.pluginName.trim();
      const projection = row.plugin?.projection ?? row.projection;
      if (id === "" || projection == null) continue;
      this.#map.set(id, projection);
    }
  }

  get(id: string): HostPluginProjection<any, any> | undefined {
    return this.#map.get(id);
  }

  entries(): IterableIterator<[string, HostPluginProjection<any, any>]> {
    return this.#map.entries();
  }
}

export const EMPTY_PROJECTION_REGISTRY = new PluginProjectionRegistry();

const registriesByRoot = new WeakMap<object, PluginProjectionRegistry>();

/** Bind a session (or test) root to a kernel projection registry. */
export function bindSessionProjections(root: object, registry: PluginProjectionRegistry): void {
  registriesByRoot.set(root, registry);
}

function rootOf(node: object | null | undefined): object | undefined {
  if (node == null) return undefined;
  if (registriesByRoot.has(node)) return node;
  const doc = (node as { readonly __doc__?: unknown }).__doc__;
  if (doc != null) {
    const homed = docPlexus.get(doc as never)?.root;
    if (homed != null) return homed;
  }
  type Parented = { readonly parent?: unknown };
  let cell: Parented | null = node as Parented;
  const seen = new Set<object>();
  while (cell != null && !seen.has(cell)) {
    seen.add(cell);
    if (registriesByRoot.has(cell)) return cell;
    const parent: unknown = cell.parent;
    cell = parent != null && typeof parent === "object" ? (parent as Parented) : null;
  }
  return undefined;
}

/** Empty registry when the node is unbound — tests must bind a projection. */
export function projectionsOf(node: object | null | undefined): PluginProjectionRegistry {
  const root = rootOf(node);
  if (root == null) return EMPTY_PROJECTION_REGISTRY;
  return registriesByRoot.get(root) ?? EMPTY_PROJECTION_REGISTRY;
}
