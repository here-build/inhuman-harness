/**
 * Product catalog adapter.
 *
 * The table, recipes, source identity, and instance scope live in
 * `@inhuman.tools/harness-tool-catalog`. This module seeds the host roster,
 * session views, and private MCP lookup. Two kernel catalogs with the same
 * workspace path do not share overlay tables.
 */
import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { AGENT_VOID, AskAgentSpec, mcpToolListHas, mcpToolListStamp, SessionRoot } from "@inhuman.tools/harness-model";
import { action, observable } from "mobx";
import invariant from "tiny-invariant";

import type { McpListedTool } from "@/providers/mcp";
import { botMcpAllows, mcpFaceOf, privateMcpCatalogEntries } from "@/runtime";
import {
  KernelToolCatalog as CatalogTable,
  behaviorEntriesOf,
  catalogOf,
  type CatalogEntry,
  type CatalogRecipe,
  type WorkerToolHost,
} from "@/tool-catalog";
import { workerToolAllowed } from "@/tool-runtime";

import { mergePluginInstallState, type PluginInstallState } from "./plugin-registry.js";
import { SYSTEM_ENTRIES, SYSTEM_PLUGIN_NAMES } from "../system-plugins/index.js";
import { namedAgentsInstall } from "../system-plugins/named-agents/agent-stdlib.js";

const PRODUCT_TOOLS_ADDENDUM: SystemPrompt = prompt.system`
  You have real tools. Call them through the API tool-calling interface — never print fake tool JSON or narrate a function call in message text.
  JSON tools are write_file, edit_file, shell, scheme_repl, scheme_watch, update_metadata, context_need, task__create, task__start, task__drop, task__after, task__validate.
  Plugin tools appear in the live catalog. Everything else is inside scheme_repl — its description is the live catalog.
  Writes, edits, and shell go through policy. A call can come back refused — that is an answer, not a transport error.
  Policy prohibit: do not bypass; ask the user to do it if it is crucial. Classifier dangerous: ask the user to confirm. User refuse: do not repeat that call.
  File paths resolve from the project root, not /.
  context_need requests working context and history to retain for the next stretch — do not wait for a result.
  After the tools you need have answered, reply to the user in prose.
  An open worker call does not close with prose. Close it with the agent__respond JSON tool — not as assistant text.`;

export class KernelToolCatalog extends CatalogTable {
  @observable.ref
  accessor pluginInstall: PluginInstallState = mergePluginInstallState([namedAgentsInstall]);

  constructor(source?: CatalogTable, permits?: (name: string) => boolean) {
    super(source, permits);
    if (!(source instanceof KernelToolCatalog)) this.workerHost = workerToolHostFor(this);
    this.TOOLS_SYSTEM_ADDENDUM = PRODUCT_TOOLS_ADDENDUM;
    if (source instanceof KernelToolCatalog) {
      this.pluginInstall = source.pluginInstall;
    } else if (source == null) {
      this.packEntries = [...SYSTEM_ENTRIES];
      this.compiledRecipes = [...namedAgentsInstall.compiledRecipes];
      this.pluginInstall = mergePluginInstallState([namedAgentsInstall]);
    }
  }

  @action
  override replaceCompiledPlugins(state: PluginInstallState): void {
    super.replaceCompiledPlugins(state);
    this.pluginInstall = state;
  }

  @action
  override replacePack(entries: readonly CatalogEntry[]): void {
    for (const entry of entries) {
      invariant(entry.source.kind === "pack", `replacePack: entry ${entry.wireName} has kind ${entry.source.kind}`);
      invariant(
        !SYSTEM_PLUGIN_NAMES.has(entry.source.pluginName),
        `replacePack: ${entry.wireName} is a host plugin; those are seeded, not replaced`,
      );
    }
    super.replacePack([...SYSTEM_ENTRIES, ...entries]);
  }

  override view(permits?: (name: string) => boolean): KernelToolCatalog {
    return new KernelToolCatalog(this, permits);
  }
}

type PrivateMcpHost = {
  readonly listedToolsByConnection: Readonly<Record<string, readonly McpListedTool[]>>;
};

const privateMcpHostsByCatalog = new WeakMap<CatalogTable, Map<string, PrivateMcpHost>>();

export function bindProjectPrivateMcpHost(catalog: CatalogTable, workspacePath: string, host: PrivateMcpHost): void {
  let byPath = privateMcpHostsByCatalog.get(catalog);
  if (byPath == null) {
    byPath = new Map();
    privateMcpHostsByCatalog.set(catalog, byPath);
  }
  byPath.set(workspacePath, host);
}

export function unbindProjectPrivateMcpHost(catalog: CatalogTable, workspacePath: string): void {
  privateMcpHostsByCatalog.get(catalog)?.delete(workspacePath);
}

function privateMcpHostOf(catalog: CatalogTable, workspacePath: string | undefined): PrivateMcpHost | undefined {
  if (workspacePath == null || workspacePath === "") return undefined;
  return privateMcpHostsByCatalog.get(catalog)?.get(workspacePath);
}

export function bindProjectRecipes(
  catalog: KernelToolCatalog,
  workspacePath: string,
  recipes: readonly CatalogRecipe[],
): void {
  catalog.bindProjectRecipes(workspacePath, recipes);
}

export function unbindProjectRecipes(catalog: KernelToolCatalog, workspacePath: string): void {
  catalog.unbindProjectRecipes(workspacePath);
}

export function projectRecipesOf(
  catalog: KernelToolCatalog,
  workspacePath: string | undefined,
): readonly CatalogRecipe[] {
  return catalog.projectRecipesOf(workspacePath);
}

export function sessionCatalog(root: object | undefined | null): KernelToolCatalog | undefined {
  if (root == null) return undefined;
  const catalog = catalogOf(root);
  if (catalog == null) return undefined;
  const product = catalog instanceof KernelToolCatalog ? catalog : new KernelToolCatalog(catalog);
  const sessionRoot = root instanceof SessionRoot ? root : undefined;
  const spec = sessionRoot?.agent.spec;
  const recipeName = spec?.name ?? "";
  const blocked = sessionRoot != null && mcpToolListStamp(sessionRoot.toolBlocklist) !== "";
  const overlay = product.projectRecipesOf(sessionRoot?.path);
  const behavior = behaviorEntriesOf(root);
  const privateHost = sessionRoot == null ? undefined : privateMcpHostOf(product, sessionRoot.path);

  if (spec instanceof AskAgentSpec && spec.inheritCallerTools) {
    const view = product.view((wire) => {
      if (wire === AGENT_VOID && spec.voidLegal === false) return false;
      return !sessionBlocksWire(root, product, wire);
    });
    view.projectRecipes = [...overlay];
    view.behaviorEntries = [...behavior];
    return view;
  }
  if (spec instanceof AskAgentSpec) {
    const view = product.view((wire) => {
      if (!workerToolAllowed(product, spec.name, wire, sessionRoot)) return false;
      return !sessionBlocksWire(root, product, wire);
    });
    if (spec.name !== "" && privateHost != null && sessionRoot != null) {
      view.privateWorkerEntries = [
        ...privateMcpCatalogEntries(
          product.pluginInstall,
          sessionRoot.path,
          spec.name,
          privateHost.listedToolsByConnection,
        ),
      ];
    }
    view.projectRecipes = [...overlay];
    view.behaviorEntries = [...behavior];
    return view;
  }
  if (recipeName === "" && !blocked && overlay.length === 0 && behavior.length === 0) return product;
  const view = product.view((wire) => {
    if (recipeName !== "" && !workerToolAllowed(product, recipeName, wire, sessionRoot)) return false;
    return !sessionBlocksWire(root, product, wire);
  });
  if (recipeName !== "" && privateHost != null && sessionRoot != null) {
    view.privateWorkerEntries = [
      ...privateMcpCatalogEntries(
        product.pluginInstall,
        sessionRoot.path,
        recipeName,
        privateHost.listedToolsByConnection,
      ),
    ];
  }
  view.projectRecipes = [...overlay];
  view.behaviorEntries = [...behavior];
  return view;
}

function sessionBlocksWire(root: object, catalog: KernelToolCatalog, wire: string): boolean {
  if (!(root instanceof SessionRoot)) return false;
  const entry = catalog.catalogEntry(wire);
  if (entry?.source.kind !== "connection") return false;
  return mcpToolListHas(root.toolBlocklist, entry.source.connectionKey, entry.source.serverToolName);
}

/** Bot-granted MCP and private plugin MCP: the host's half of the worker tool ceiling. */
function workerToolHostFor(kernel: CatalogTable): WorkerToolHost {
  return {
    recipeGrantsWire: (catalog, spec, wire, projectPath) => {
      if (spec.tools.includes(wire)) return true;
      const entry = (catalog as CatalogTable).catalogEntry(wire);
      if (entry?.source.kind !== "connection") return false;
      const face = mcpFaceOf(kernel, entry.source.connectionKey);
      if (face == null) return false;
      return botMcpAllows(spec, face, entry.source.serverToolName, projectPath);
    },
    privateWireAllowed: (recipeName, wire, sessionRoot) => {
      if (!(sessionRoot instanceof SessionRoot)) return false;
      const host = privateMcpHostOf(kernel, sessionRoot.path);
      if (host == null) return false;
      const install = (kernel as KernelToolCatalog).pluginInstall;
      return privateMcpCatalogEntries(install, sessionRoot.path, recipeName, host.listedToolsByConnection).some(
        (row) => row.wireName === wire,
      );
    },
  };
}

export { workerToolAllowed } from "@/tool-runtime";
