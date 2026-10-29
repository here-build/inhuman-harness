/**
 * Thin Agent: a snapshotted recipe plus this instance's live pin (`head`)
 * and episode ceiling (`tip`). Default own genesis — a child does not
 * inherit the parent spine or tools unless the spawn demand says so
 * (fail-closed).
 */
import { PlexusModel, syncing } from "@here.build/plexus";
import { prompt, type SystemPrompt, type UserPrompt } from "@inhuman.tools/harness-commons";

import { syncingText } from "../json-record.js";
import type { ReasoningEffort } from "../reasoning-effort.js";
import type { AgentNature, RecipeScope } from "../recipe-scope.js";
import { HARNESS_CONSTITUTION } from "./SessionSystemPrompt.js";
import { SessionTurn } from "./turn/index.js";

export { agentNatureOf, type AgentNature, type RecipeScope } from "../recipe-scope.js";

/** Recipe only. Not cwd, frozen tools, permissionMode, or last-used model. */
@syncing("harness:session:agent-spec")
export class AgentSpec extends PlexusModel {
  @syncing accessor name: string = "";
  @syncing accessor description: string = "";
  /**
   * Keep interpreting without a TUI/web seat. Occupancy park is
   * `!occupied && !resident` — not `keepAlive` (ReACT stretch).
   */
  @syncing accessor resident: boolean = false;
  @syncing accessor instructions: SystemPrompt = HARNESS_CONSTITUTION;
  /** Recipe scope. Empty until first mint (foreground / one-shot). */
  @syncing accessor recipeScope: AgentNature = "";
  /** Stretch this ReACT loop after `agentCallbacks` empties. Not a roster bit. */
  @syncing accessor keepAlive: boolean = false;
  /**
   * False when this session was minted for an ask. Hides `agent__void`.
   * Default true so send-minted and standing workers keep void.
   */
  @syncing accessor voidLegal: boolean = true;
  /** Ask desk: drop write_file / edit_file / write-class MCP. Shell stays. */
  @syncing accessor readonly: boolean = false;
  /**
   * Recipe snapshot. Null = omit on the PEW (vendor default).
   * `none` disables when the dialect allows.
   */
  @syncing accessor reasoningEffort: ReasoningEffort | null = null;
  /**
   * Child spawns (`agent/ask`) between the foreground agent and this one. Written by the
   * daemon when it mints or delivers to the worker; the model cannot reach it.
   */
  @syncing accessor depth: number = 0;
  /** Bot hops (`bot/ask`) behind this agent. A separate count from {@link depth}. */
  @syncing accessor botDepth: number = 0;
  /**
   * Pinned behavior revision: identities, sources, configuration, grants.
   * Empty = standard host environment. Never an executable closure.
   */
  @syncing private accessor behaviorPinJson: string = "";

  /**
   * Pin text. Empty is unstamped.
   * Parsing belongs to the caller: a bad pin must not stick in a computed.
   */
  get behaviorPin(): string {
    return syncingText(this.behaviorPinJson) ?? "";
  }

  set behaviorPin(next: string) {
    if (next === this.behaviorPinJson) return;
    this.behaviorPinJson = next;
  }

  /** First name on an empty spec. Pin is written only when the caller has one (`null` = none). */
  @syncing.action
  adoptNamedRecipe(bot: {
    readonly name: string;
    readonly recipeScope: RecipeScope;
    readonly keepAlive: boolean;
    readonly description: string;
    readonly instructions: SystemPrompt;
    readonly reasoningEffort: ReasoningEffort | null;
    readonly behaviorPinJson: string | null;
  }): void {
    if (this.name !== "") return;
    this.name = bot.name;
    this.recipeScope = bot.recipeScope;
    this.keepAlive = bot.keepAlive;
    if (bot.description.trim() !== "") this.description = bot.description;
    if (bot.instructions.trim() !== "") this.instructions = bot.instructions;
    if (bot.reasoningEffort != null) this.reasoningEffort = bot.reasoningEffort;
    if (this.behaviorPinJson.trim() === "" && bot.behaviorPinJson != null) this.behaviorPinJson = bot.behaviorPinJson;
  }

  constructor(
    props?:
      | {
          readonly name?: string;
          readonly description?: string;
          readonly resident?: boolean;
          readonly instructions?: SystemPrompt;
          readonly scope?: AgentNature;
          readonly keepAlive?: boolean;
          readonly voidLegal?: boolean;
          readonly readonly?: boolean;
          readonly reasoningEffort?: ReasoningEffort | null;
          readonly depth?: number;
          readonly botDepth?: number;
          readonly behaviorPinJson?: string;
        }
      | symbol,
  ) {
    super(props);
  }
}

/**
 * One-shot mint: omitted-spec ask, or a named recipe stamped at the call site.
 * Empty name is comms-only. Named copies recipe name/instructions; keepAlive is
 * always false. Scope stays empty. voidLegal defaults false; one-shot send may
 * override true.
 *
 * `name` is a face, not a catalog lookup. Unknown names must not zero the
 * one-shot floor (`scheme_repl` + side channels + comms). `tools` overlays
 * that floor; a matching recipe still adds `recipe.tools`.
 * `inheritCallerTools` is a .prompt worker: use the caller's catalog, not the
 * comms-only floor. `toolsOnly` makes `tools` the whole overlay: a matching
 * recipe adds nothing (a caller narrowed it).
 */
@syncing("harness:session:ask-agent-spec")
export class AskAgentSpec extends AgentSpec {
  @syncing.list accessor tools: string[] = [];
  @syncing accessor inheritCallerTools: boolean = false;
  @syncing accessor toolsOnly: boolean = false;

  constructor(
    props?:
      | (Exclude<ConstructorParameters<typeof AgentSpec>[0], symbol> & {
          readonly tools?: readonly string[];
          readonly inheritCallerTools?: boolean;
          readonly toolsOnly?: boolean;
          readonly behaviorPinJson?: string;
        })
      | symbol,
  ) {
    super(
      typeof props === "symbol"
        ? props
        : { ...props, scope: "", voidLegal: props?.voidLegal === true, keepAlive: false },
    );
    if (typeof props !== "symbol" && props?.tools != null) this.tools = [...props.tools];
    if (typeof props !== "symbol" && props?.inheritCallerTools === true) this.inheritCallerTools = true;
    if (typeof props !== "symbol" && props?.toolsOnly === true) this.toolsOnly = true;
  }
}

/** Open worker Call the model must settle. Prompt is the inbound turn text. */
export type OpenAgentCallback = {
  readonly requestId: string;
  readonly prompt: UserPrompt;
};

/** Host system line when a worker spoke without closing an open Call. Lists live ids. */
export function callbackRequiredNote(voidLegal: boolean, calls: readonly OpenAgentCallback[]): SystemPrompt {
  const close = voidLegal
    ? "Close each with the agent__respond JSON tool, or agent__void — not as assistant text."
    : "Close each with the agent__respond JSON tool — not as assistant text.";
  const head = calls.length === 1 ? "This call is still open." : "These calls are still open.";
  const lines = calls.map((call) =>
    call.prompt === "" ? `- ${call.requestId}` : `- ${call.requestId} — ${call.prompt}`,
  );
  return prompt.system`${[head, close, ...lines].join("\n")}`;
}

@syncing("harness:session:agent")
export class Agent extends PlexusModel {
  @syncing.child accessor spec: AgentSpec = new AgentSpec();
  /** `SessionRoot.head` writes this field. */
  @syncing.child accessor head: SessionTurn | null = null;

  /**
   * Same-value `head = head` writes the parent edge only inside an action.
   * Connect calls this for images saved while `head` was a reference: the
   * field holds the turn and `hasParent` was never written.
   */
  @syncing.action
  reownHead(): void {
    const head = this.head;
    if (head != null && head.parent == null) this.head = head;
  }
  /**
   * Redo ceiling. Reference, not a child: `head` already owns the live turn,
   * and a second child slot would steal it on rewind. Null on older documents
   * means at-tip (`head`). Torn (`head` not on `tip`'s tail walk) is repaired
   * to `head`.
   */
  @syncing accessor tip: SessionTurn | null = null;
  @syncing accessor parent: Agent | null = null;
  @syncing accessor nickname: string = "";

  constructor(
    props?:
      | {
          readonly spec?: AgentSpec;
          readonly head?: SessionTurn | null;
          readonly tip?: SessionTurn | null;
          readonly parent?: Agent | null;
          readonly nickname?: string;
        }
      | symbol,
  ) {
    super(props);
  }
}
