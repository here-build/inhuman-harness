/**
 * Per-instance tool catalog.
 *
 * catalog = registered ∪ expand(connection)
 * Registered entries and recipes are contributions from outside this package.
 * Connection entries come from a host attached as `connectionHost`.
 *
 * wireName — model tools[] projection (regenerate freely).
 * connection source — kernel ConnectionSpec map key + server tool; never re-parse wireName.
 */
import { DisposableClass, disposableGuard, prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { action, computed, observable } from "mobx";
import invariant from "tiny-invariant";

import { type CatalogRecipe, dedupeRecipes, findRecipe, invokeCyclePath } from "./recipes.js";
import { type CatalogEntry, PLAIN_WORKER_HOST, type WorkerToolHost } from "./types.js";

export type CompiledPluginContribution = {
  readonly compiledRecipes: readonly CatalogRecipe[];
};

export class KernelToolCatalog extends DisposableClass {
  constructor(
    private readonly source?: KernelToolCatalog,
    private readonly permits?: (name: string) => boolean,
  ) {
    super();
    if (source != null) {
      this.TOOLS_SYSTEM_ADDENDUM = source.TOOLS_SYSTEM_ADDENDUM;
      this.workerHost = source.workerHost;
      this.recipes = source.recipes;
      this.compiledRecipes = source.compiledRecipes;
      this.surfaceRecipes = source.surfaceRecipes;
      this.botRevisions = source.botRevisions;
    }
  }

  /**
   * Product composition may replace this. Empty until a roster is registered —
   * this package does not name host tools.
   */
  TOOLS_SYSTEM_ADDENDUM: SystemPrompt = prompt.system``;
  /** Set by the host. Views inherit it from their source. */
  workerHost: WorkerToolHost = PLAIN_WORKER_HOST;
  @observable.shallow
  accessor packEntries: CatalogEntry[] = [];
  /** Named-agent recipes authored on KernelRoot.bots / ProjectRoot.bots. */
  @observable.shallow
  accessor recipes: CatalogRecipe[] = [];
  /** Plugin-compiled bot recipes. Not written to KernelRoot.bots. */
  @observable.shallow
  accessor compiledRecipes: CatalogRecipe[] = [];
  /** Installed plugins' `.prompt` bots. An authored or compiled recipe of the same name wins. */
  @observable.shallow
  accessor surfaceRecipes: CatalogRecipe[] = [];
  /**
   * Program revision of each enabled plugin bot, keyed by bot name. A behavior
   * plugin has no compiled install, so this is the revision `isCallPaused`
   * compares a call against. Empty while no behavior has been pinned.
   */
  @observable.ref
  accessor botRevisions: ReadonlyMap<string, string> = new Map();
  /** Project-dir overlay copied onto session views. Kernel catalog field stays empty. */
  @observable.shallow
  accessor projectRecipes: CatalogRecipe[] = [];
  @observable.ref
  accessor connectionHost: { readonly connectionEntries: readonly CatalogEntry[] } | undefined = undefined;
  /** Worker-only private bundled MCP tools (not in foreground catalog). */
  @observable.shallow
  accessor privateWorkerEntries: CatalogEntry[] = [];
  /** Tools declared by this agent's pinned behavior. The behavior is their grant. */
  @observable.shallow
  accessor behaviorEntries: CatalogEntry[] = [];
  /** Per-instance project overlay. Not a process table keyed only by path string. */
  readonly #projectRecipesByPath = new Map<string, readonly CatalogRecipe[]>();

  @computed
  get connectionEntries(): readonly CatalogEntry[] {
    return this.connectionHost?.connectionEntries ?? [];
  }

  @computed
  get #byWire(): Map<string, CatalogEntry> {
    const map = new Map<string, CatalogEntry>();
    if (this.source != null) {
      for (const entry of this.source.catalogEntries()) {
        if (this.permits?.(entry.wireName) !== false) map.set(entry.wireName, entry);
      }
    } else {
      for (const entry of this.packEntries) map.set(entry.wireName, entry);
      for (const entry of this.connectionEntries) map.set(entry.wireName, entry);
      for (const entry of this.privateWorkerEntries) map.set(entry.wireName, entry);
    }
    for (const entry of this.behaviorEntries) {
      if (!map.has(entry.wireName)) map.set(entry.wireName, entry);
    }
    return map;
  }

  recipe(name: string): CatalogRecipe | undefined {
    return (
      findRecipe(this.projectRecipes, name) ??
      findRecipe(this.recipes, name) ??
      findRecipe(this.compiledRecipes, name) ??
      findRecipe(this.surfaceRecipes, name)
    );
  }

  allRecipes(): readonly CatalogRecipe[] {
    return dedupeRecipes([...this.projectRecipes, ...this.recipes, ...this.compiledRecipes, ...this.surfaceRecipes]);
  }

  @action
  @disposableGuard
  replaceCompiledPlugins(state: CompiledPluginContribution): void {
    const occupied = new Set(this.recipes.map((recipe) => recipe.spec.name));
    for (const recipe of state.compiledRecipes) {
      if (recipe.category === "internal") continue;
      invariant(
        !occupied.has(recipe.spec.name),
        `replaceCompiledPlugins: compiled bot "${recipe.spec.name}" collides with an authored recipe`,
      );
    }
    const merged = [...this.recipes, ...state.compiledRecipes];
    const cycle = invokeCyclePath(merged);
    invariant(cycle == null, `replaceCompiledPlugins: invoke cycle ${cycle?.join(" → ")}`);
    this.compiledRecipes = [...state.compiledRecipes];
  }

  /** Returns the bots skipped because another recipe already owns the name. */
  @action
  @disposableGuard
  replaceSurfaceRecipes(recipes: readonly CatalogRecipe[]): string[] {
    const taken = new Set([...this.recipes, ...this.compiledRecipes].map((recipe) => recipe.spec.name));
    this.surfaceRecipes = recipes.filter((recipe) => !taken.has(recipe.spec.name));
    return recipes.filter((recipe) => taken.has(recipe.spec.name)).map((recipe) => recipe.spec.name);
  }

  @action
  @disposableGuard
  replaceRecipes(recipes: readonly CatalogRecipe[]): void {
    const seen = new Set<string>();
    const names = new Set([
      ...this.compiledRecipes.map((recipe) => recipe.spec.name),
      ...recipes.map((recipe) => recipe.spec.name),
    ]);
    for (const recipe of recipes) {
      const name = recipe.spec.name;
      invariant(name.trim() !== "", "replaceRecipes: recipe name required");
      invariant(!name.includes("__"), `replaceRecipes: recipe "${name}" cannot contain __`);
      invariant(!seen.has(name), `replaceRecipes: recipe "${name}" collides`);
      seen.add(name);
      const caps = new Set<string>();
      for (const capability of recipe.capabilities) {
        invariant(
          capability.name.trim() !== "" && !capability.name.includes("__"),
          `replaceRecipes: ${name} capability "${capability.name}" is illegal`,
        );
        invariant(!caps.has(capability.name), `replaceRecipes: ${name} capability "${capability.name}" collides`);
        caps.add(capability.name);
      }
      for (const target of recipe.spec.invokes) {
        invariant(names.has(target), `replaceRecipes: ${name} invokes unknown "${target}"`);
      }
    }
    const cycle = invokeCyclePath([
      ...this.compiledRecipes.filter((recipe) => !seen.has(recipe.spec.name)),
      ...recipes,
    ]);
    invariant(cycle == null, `replaceRecipes: invoke cycle ${cycle?.join(" → ")}`);
    this.recipes = [...recipes];
  }

  catalogEntry(wireName: string): CatalogEntry | undefined {
    return this.#byWire.get(wireName);
  }

  catalogEntries(): readonly CatalogEntry[] {
    return [...this.#byWire.values()];
  }

  catalogWireNames(): readonly string[] {
    return [...this.#byWire.keys()];
  }

  @action
  @disposableGuard
  replacePack(entries: readonly CatalogEntry[]): void {
    for (const entry of entries) {
      invariant(entry.source.kind === "pack", `replacePack: entry ${entry.wireName} has kind ${entry.source.kind}`);
    }
    this.packEntries = [...entries];
  }

  @disposableGuard
  bindProjectRecipes(workspacePath: string, recipes: readonly CatalogRecipe[]): void {
    if (workspacePath === "") return;
    this.#projectRecipesByPath.set(workspacePath, recipes);
  }

  unbindProjectRecipes(workspacePath: string): void {
    this.#projectRecipesByPath.delete(workspacePath);
  }

  projectRecipesOf(workspacePath: string | undefined): readonly CatalogRecipe[] {
    if (workspacePath == null || workspacePath === "") return [];
    return this.#projectRecipesByPath.get(workspacePath) ?? [];
  }

  /** Filtered view of this catalog. Recipe fields are shared; overlay fields stay on the caller. */
  @disposableGuard
  view(permits?: (name: string) => boolean): KernelToolCatalog {
    return new KernelToolCatalog(this, permits);
  }

  protected dispose(): void {
    this.#projectRecipesByPath.clear();
    this.packEntries = [];
    this.recipes = [];
    this.compiledRecipes = [];
    this.surfaceRecipes = [];
    this.projectRecipes = [];
    this.privateWorkerEntries = [];
    this.behaviorEntries = [];
    this.connectionHost = undefined;
    this.botRevisions = new Map();
    const roots = rootsByCatalog.get(this);
    if (roots == null) return;
    for (const root of roots) {
      if (catalogsByRoot.get(root) === this) catalogsByRoot.delete(root);
    }
    roots.clear();
    rootsByCatalog.delete(this);
  }
}

export function catalogTriggersReactLoop(catalog: KernelToolCatalog, wire: string): boolean {
  const entry = catalog.catalogEntry(wire);
  if (entry?.triggersReactLoop === false) return false;
  if (entry?.triggersReactLoop === true) return true;
  return entry?.isSideChannel !== true;
}

export function requireCatalog<T extends KernelToolCatalog>(catalog: T | undefined, what: string): T {
  if (catalog === undefined) throw new Error(`${what}: kernel tool catalog is missing`);
  return catalog;
}

const catalogsByRoot = new WeakMap<object, KernelToolCatalog>();
const rootsByCatalog = new WeakMap<KernelToolCatalog, Set<object>>();
const behaviorEntriesByRoot = observable.map<object, readonly CatalogEntry[]>(new Map(), { deep: false });

/** Tools the session's pinned behavior declares. Replaced whenever the pin reattaches. */
export const bindBehaviorEntries = action((root: object, entries: readonly CatalogEntry[]): void => {
  if (entries.length === 0) behaviorEntriesByRoot.delete(root);
  else behaviorEntriesByRoot.set(root, entries);
});

export function behaviorEntriesOf(root: object | undefined | null): readonly CatalogEntry[] {
  return root == null ? [] : (behaviorEntriesByRoot.get(root) ?? []);
}

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
