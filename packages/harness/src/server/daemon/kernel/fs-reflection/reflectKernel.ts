import { join } from "node:path";

import { fail } from "@inhuman.tools/harness-diagnostics";
import {
  CommandSpec,
  DEFAULT_APPROVAL_ASK_THROTTLE_MS,
  DEFAULT_AUTO_MODE_JUDGE,
  parsePermissionMode,
  DEFAULT_COMPACT_STRATEGY,
  DEFAULT_COMPACT_TRIGGERS,
  DEFAULT_COMPACT_KEEP_TURNS,
  DEFAULT_CONTEXT_GLOW_REMAINING,
  DEFAULT_LENGTH_CONTINUATIONS,
  DEFAULT_SPECULATIVE_POLICY_PROCESSING_TOOLS,
  DEFAULT_STATUSLINE,
  DEFAULT_STATUSLINE_REFRESH,
  hydrateKernelRoot,
  InstalledPlugin,
  KernelRoot,
  parseCompactTrigger,
  parseLoopLimit,
  parseGrantRows,
  parseShellTailBytes,
  parseSuperKey,
} from "@inhuman.tools/harness-model";
import { parseTextOnlyContinue, type KvProposal } from "@inhuman.tools/harness-model/shared";
import { ConnectionSpec, DriverSpec } from "@inhuman.tools/plexus-expectations";
import fs from "fs-extra";

import { parseRetentionLayer } from "@inhuman.tools/turn/context";

import { applyRegistryToDrivers, openDriverRegistry, type DriverRegistry } from "@/connections";
import { readPluginInventory } from "@/extensions";
import {
  projectNousGatewayConnection,
  sourceNousConnectionId,
  NOUS_GATEWAY_CONNECTION_ID,
  NOUS_GATEWAY_DRIVER_NAME,
} from "@/providers/nous";

import { PRODUCT_PROVIDERS } from "../../../composition.js";
import { defaultCommands, defaultCompactSource } from "../../../defaults/index.js";
import { projectKeylessConnection } from "../../../drivers/web-search/pick.js";
import { KEYLESS_CONNECTION_ID, KEYLESS_DRIVER_NAME } from "../../../drivers/web-search/types.js";
import { parseConfigJson, parseKvBag, type ConfigJson } from "../../../schemas/well-known.js";

/** 0 (or a bad value) puts the whole eat in the prefix; clamp to the default floor. */
function clampKeepTurns(value: number | undefined | null): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : DEFAULT_COMPACT_KEEP_TURNS;
}

/** `grants.json`: stored grants of project, bot and global scope. A file that does not parse grants nothing. */
function readGrantsJson(path: string): string {
  try {
    const raw: unknown = fs.readJsonSync(join(path, "grants.json"));
    const rows = parseGrantRows(JSON.stringify(Array.isArray(raw) ? raw : ((raw as { rows?: unknown })?.rows ?? [])));
    return rows.length === 0 ? "" : JSON.stringify(rows);
  } catch {
    return "";
  }
}

export function reflectKernel(
  path: string,
  into: KernelRoot,
  registry: DriverRegistry = openDriverRegistry(PRODUCT_PROVIDERS),
): KernelRoot {
  hydrateKernelRoot(into);
  const disabled = new Set<string>();
  let file: ConfigJson | undefined;
  try {
    const raw: unknown = fs.readJsonSync(join(path, "config.json"));
    file = parseConfigJson(raw);
  } catch (error) {
    file = undefined;
    // A config.json that exists but does not parse must not leave the previous grants live:
    // fail closed (no standing auto grants) and say so. A missing file is just "no grants".
    if (fs.pathExistsSync(join(path, "config.json"))) fail("config.json", error);
  }
  // The user layer of the authorization table. No file, or no block, is the dist defaults.
  into.authorizationJson = file?.authorization == null ? "" : JSON.stringify(file.authorization);
  into.grantsJson = readGrantsJson(path);
  if (file !== undefined) {
    for (const [name, policy] of Object.entries(file.plugins)) {
      if (policy.enabled === false) disabled.add(name);
    }
    Object.assign(into.compactTriggers, {
      hard: file.compactTriggers?.hard ?? DEFAULT_COMPACT_TRIGGERS.hard,
      soft: file.compactTriggers?.soft ?? DEFAULT_COMPACT_TRIGGERS.soft,
    });
    into.compactKeepTurns = clampKeepTurns(file.compactKeepTurns);
    into.contextRetentionJson =
      file.contextRetention === undefined ? "" : JSON.stringify(parseRetentionLayer(file.contextRetention));
    Object.assign(into, {
      contextGlowRemaining:
        file.contextGlowRemaining != null && parseCompactTrigger(file.contextGlowRemaining) != null
          ? file.contextGlowRemaining
          : DEFAULT_CONTEXT_GLOW_REMAINING,
      compactStrategy: file.compact?.trim() || DEFAULT_COMPACT_STRATEGY,
      autoModeClassifier: file.autoModeClassifier?.trim() || DEFAULT_AUTO_MODE_JUDGE,
      speculativePolicyProcessingTools:
        file.speculativePolicyProcessingTools ?? DEFAULT_SPECULATIVE_POLICY_PROCESSING_TOOLS,
      approvalAskThrottleMs: file.approvalAskThrottleMs ?? DEFAULT_APPROVAL_ASK_THROTTLE_MS,
      superKey: parseSuperKey(file.superKey),
      hideFloorTools: file.hideFloorTools === true,
      defaultPermissionMode: parsePermissionMode(file.defaultPermissionMode) ?? "manual",
      shellTailBytes: parseShellTailBytes(file.shellTailBytes),
      maxRounds: parseLoopLimit(file.maxRounds),
      maxDepth: parseLoopLimit(file.maxDepth),
      maxBotRounds: parseLoopLimit(file.maxBotRounds),
      maxBotDepth: parseLoopLimit(file.maxBotDepth),
      lengthContinuations: parseLoopLimit(file.lengthContinuations, DEFAULT_LENGTH_CONTINUATIONS),
      retryMaxMs: parseLoopLimit(file.retryMaxMs),
      retryMaxAttempts: parseLoopLimit(file.retryMaxAttempts),
      statusline: file.statusline === undefined ? DEFAULT_STATUSLINE : file.statusline.trim(),
      statuslineRefresh: file.statuslineRefresh?.trim() || DEFAULT_STATUSLINE_REFRESH,
    });
    into.reActLoopIntentDetectedTrigger.applyFlags(parseTextOnlyContinue(file.reActLoopIntentDetectedTrigger));
  }
  const inventory = readPluginInventory(path, disabled);

  const keepDrivers = new Set<string>();
  applyRegistryToDrivers(registry, into.drivers);
  for (const driver of registry.list()) keepDrivers.add(driver.name);
  for (const rec of inventory.drivers) {
    keepDrivers.add(rec.name);
    into.drivers[rec.name] ??= new DriverSpec();
    Object.assign(into.drivers[rec.name], {
      name: rec.name,
      description: rec.description,
      importPath: rec.importPath,
      abilityClaim: [...rec.abilityClaim],
      multiplicity: rec.multiplicity,
    });
  }
  for (const name of Object.keys(into.drivers)) {
    if (!keepDrivers.has(name)) delete into.drivers[name];
  }

  const keepConnections = new Set<string>();
  if (into.drivers[KEYLESS_DRIVER_NAME] !== undefined) keepConnections.add(KEYLESS_CONNECTION_ID);
  if (into.drivers[NOUS_GATEWAY_DRIVER_NAME] !== undefined) keepConnections.add(NOUS_GATEWAY_CONNECTION_ID);
  for (const [id, slice] of Object.entries(file?.connections ?? {})) {
    const driver = into.drivers[slice.driver];
    if (driver === undefined) continue;
    keepConnections.add(id);
    into.connections[id] ??= new ConnectionSpec({ driver });
    Object.assign(into.connections[id], {
      driver,
      name: slice.name,
      annotation: slice.annotation,
      configuration: slice.settings,
    });
  }
  if (into.drivers[NOUS_GATEWAY_DRIVER_NAME] === undefined || sourceNousConnectionId(into) === null) {
    keepConnections.delete(NOUS_GATEWAY_CONNECTION_ID);
  }
  for (const id of Object.keys(into.connections)) {
    if (!keepConnections.has(id) && !id.startsWith("__prv_")) delete into.connections[id];
  }

  const keepPlugins = new Set<string>();
  for (const rec of inventory.plugins) {
    keepPlugins.add(rec.pluginName);
    into.plugins[rec.pluginName] ??= new InstalledPlugin();
    Object.assign(into.plugins[rec.pluginName], {
      pluginName: rec.pluginName,
      sourceNpm: rec.sourceNpm,
      sourceVersion: rec.sourceVersion,
      rootPath: rec.rootPath,
      enabled: rec.enabled,
      foreground: file?.plugins[rec.pluginName]?.foreground !== false,
      modules: [...rec.modules],
    });
  }
  for (const name of Object.keys(into.plugins)) {
    if (!keepPlugins.has(name)) delete into.plugins[name];
  }

  const keepCommands = new Set<string>();
  for (const rec of [...defaultCommands(), ...inventory.commands]) {
    if (rec.verb === "compact") continue;
    keepCommands.add(rec.verb);
    into.commands[rec.verb] ??= new CommandSpec();
    Object.assign(into.commands[rec.verb], {
      verb: rec.verb,
      description: rec.description,
      aliases: [],
      source: rec.source,
      body: rec.body,
    });
  }
  const source = join(path, "compact.scm");
  let body: string;
  try {
    body = fs.readFileSync(source, "utf8");
  } catch {
    body = defaultCompactSource();
  }
  into.commands.compact ??= new CommandSpec();
  Object.assign(into.commands.compact, {
    verb: "compact",
    description: "Compact conversation context",
    aliases: [],
    source,
    body,
  });
  keepCommands.add("compact");
  for (const verb of Object.keys(into.commands)) {
    if (!keepCommands.has(verb)) delete into.commands[verb];
  }

  let bag: Record<string, string> = {};
  try {
    bag = parseKvBag(fs.readJsonSync(join(path, "kv.json")));
  } catch {}
  const series: KvProposal[] = [];
  for (const key of Object.keys(into.kvs)) {
    if (!(key in bag)) series.push({ form: "kv-clear", key });
  }
  for (const [key, value] of Object.entries(bag)) {
    if (into.kvs[key] !== value) series.push({ form: "kv-set", key, value });
  }
  if (series.length > 0) into.applyKvs(series);

  projectKeylessConnection(into);
  projectNousGatewayConnection(into);

  return into;
}
