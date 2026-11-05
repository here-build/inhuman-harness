/**
 * Authored bot recipe on the kernel or project image. Disk is the store;
 * this record is the visible face. `error` set means the file did not admit.
 * Detached, `name` is the identity; on a parent map, the key wins.
 */
import { prompt, type SystemPrompt } from "@inhuman.tools/harness-commons";
import { Model, model, state } from "@inhuman.tools/model";
import type { ReadonlyDeep } from "type-fest";

import { serializingInto } from "../json-record.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import type { RecipeScope } from "../recipe-scope.js";
import type { KernelRoot } from "./KernelRoot.js";
import type { ProjectRoot } from "./ProjectRoot.js";

export type BotSpecParent = KernelRoot | ProjectRoot | null;

export type BotSpecProps = {
  name?: string;
  description?: string;
  recipeScope?: RecipeScope;
  keepAlive?: boolean;
  instructions?: SystemPrompt;
  tools?: string[];
  invokes?: string[];
  reasoningEffort?: ReasoningEffort | null;
  skills?: string[];
  modelPreferences?: string[];
  /** Authored behavior selection JSON. Null = standard host environment. */
  behaviorJson?: string | null;
  /** JSON list of MCP grants. Blank means the bot names no server. */
  mcpJson?: string;
  error?: string | null;
};

@model("harness:bot-spec")
export class BotSpec extends Model<any, BotSpecParent> {
  get id(): string {
    return (this.parentFieldKey as string | null) ?? this.name;
  }

  get stem(): string {
    return this.id;
  }

  @state accessor name: string = "";
  @state accessor description: string = "";
  @state accessor recipeScope: RecipeScope = "session";
  @state accessor keepAlive: boolean = false;
  @state accessor instructions: SystemPrompt = prompt.system``;
  @state.list accessor tools: string[] = [];
  @state.list accessor invokes: string[] = [];
  /** Null = omit (vendor default). `none` disables when the dialect allows. */
  @state accessor reasoningEffort: ReasoningEffort | null = null;
  @state.list accessor skills: string[] = [];
  @state.list accessor modelPreferences: string[] = [];
  /** Authored behavior selection JSON. Null = no custom behavior. Not a closure. */
  @state accessor behaviorJson: string | null = null;
  /** JSON list of `{ server, tools?, account?, session? }`. Blank means none. */
  @state accessor mcpJson: string = "";

  @serializingInto("behaviorJson")
  accessor behavior: ReadonlyDeep<Record<string, unknown>> | null = null;
  /** Null = admitted. A string is why the file did not admit. */
  @state accessor error: string | null = null;

  constructor(opts?: BotSpecProps | symbol) {
    super(opts);
  }
}

function copyList(values: readonly string[]): string[] {
  return [...values];
}

/** Replace authored bots on a root. Leftover names are dropped. */
export function projectBotSpecs(root: KernelRoot | ProjectRoot, specs: readonly BotSpec[]): void {
  root.replaceAuthoredBots(specs);
}

export function writeAuthoredBots(root: KernelRoot | ProjectRoot, specs: readonly BotSpec[]): void {
  const keep = new Set<string>();
  for (const spec of specs) {
    if (spec.name === "") continue;
    keep.add(spec.name);
    const row = (root.bots[spec.name] ??= new BotSpec());
    row.name = spec.name;
    row.description = spec.description;
    row.recipeScope = spec.recipeScope;
    row.keepAlive = spec.keepAlive;
    row.instructions = spec.instructions;
    row.tools = copyList(spec.tools);
    row.invokes = copyList(spec.invokes);
    row.reasoningEffort = spec.reasoningEffort;
    row.skills = copyList(spec.skills);
    row.modelPreferences = copyList(spec.modelPreferences);
    row.behavior = spec.behavior;
    row.mcpJson = spec.mcpJson;
    row.error = spec.error;
  }
  for (const name of Object.keys(root.bots)) {
    if (!keep.has(name)) delete root.bots[name];
  }
}
