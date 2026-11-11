import { action, observable } from "mobx";
import invariant from "tiny-invariant";

import type { KernelToolCatalog } from "./catalog.js";
import type { CatalogEntry } from "./types.js";

const catalogsByRoot = new WeakMap<object, KernelToolCatalog>();
const rootsByCatalog = new WeakMap<KernelToolCatalog, Set<object>>();

/** Bind a session (or test) root to a kernel catalog. */
export function bindSessionCatalog(root: object, catalog: KernelToolCatalog): void {
  invariant(!catalog.disposed, "bindSessionCatalog: catalog is disposed");
  const prior = catalogsByRoot.get(root);
  if (prior != null && prior !== catalog) rootsByCatalog.get(prior)?.delete(root);
  catalogsByRoot.set(root, catalog);
  let roots = rootsByCatalog.get(catalog);
  if (roots == null) {
    roots = new Set();
    rootsByCatalog.set(catalog, roots);
  }
  roots.add(root);
}

export function catalogOf(root: object | undefined | null): KernelToolCatalog | undefined {
  if (root == null) return undefined;
  const catalog = catalogsByRoot.get(root);
  if (catalog == null || catalog.disposed) return undefined;
  return catalog;
}

export function releaseCatalogRoots(catalog: KernelToolCatalog): void {
  const roots = rootsByCatalog.get(catalog);
  if (roots == null) return;
  for (const root of roots) {
    if (catalogsByRoot.get(root) === catalog) catalogsByRoot.delete(root);
  }
  roots.clear();
  rootsByCatalog.delete(catalog);
}

const behaviorEntriesByRoot = observable.map<object, readonly CatalogEntry[]>(new Map(), { deep: false });

/** Tools the session's pinned behavior declares. Replaced whenever the pin reattaches. */
export const bindBehaviorEntries = action((root: object, entries: readonly CatalogEntry[]): void => {
  if (entries.length === 0) behaviorEntriesByRoot.delete(root);
  else behaviorEntriesByRoot.set(root, entries);
});

export function behaviorEntriesOf(root: object | undefined | null): readonly CatalogEntry[] {
  return root == null ? [] : (behaviorEntriesByRoot.get(root) ?? []);
}
