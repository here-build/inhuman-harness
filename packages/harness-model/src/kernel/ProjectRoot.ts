import { Model, model as modelDecorator, state } from "@inhuman.tools/model";

import { BotSpec, writeAuthoredBots } from "./BotSpec.js";
import type { CommandSpec } from "./CommandSpec.js";
import type { ActionSpec } from "../shared/ActionSpec.js";
import { applyKv } from "../shared/KeyValueStorage.js";
import type { PermissionMode } from "../shared/permission-mode.js";
import type { KvProposal } from "../shared/residual.js";

@modelDecorator("harness:project:root")
export class ProjectRoot extends Model<any, null> {
  @state.record accessor kvs: Record<string, string> = {};

  @state.action
  applyKvs(proposals: readonly KvProposal[]): void {
    applyKv(this.kvs, proposals);
  }

  /**
   * `"connection"` → model this project last settled on for that wire. Session
   * model selection writes through; a project-scope kv/set can pin it. Session
   * mint prefers this over the kernel record.
   */
  @state.record accessor lastUsedConnectionModel: Record<string, string> = {};

  @state.action
  stampLastUsedConnectionModel(connection: string, model: string): void {
    const conn = connection.trim();
    const mid = model.trim();
    if (conn === "" || mid === "") return;
    this.lastUsedConnectionModel[conn] = mid;
  }

  @state.action
  replaceAuthoredBots(specs: readonly BotSpec[]): void {
    writeAuthoredBots(this, specs);
  }

  @state accessor path: string = "";
  /**
   * Last-choice permission mode for a new session in this project.
   * Empty inherits kernel `defaultPermissionMode` at mint. A set id wins, including
   * `manual`. Not a kv key. Attach does not re-seed.
   */
  @state accessor defaultPermissionMode: PermissionMode | "" = "";
  /**
   * The user's own authorization overlay for this project (`policy/class-mode` scope `project`).
   * Kernel state, never the repo file: merged over the user layer, so it may loosen it. Empty: none.
   */
  @state accessor authorizationJson: string = "";
  @state accessor trusted: boolean = false;
  @state accessor contentHash: string = "";
  /** Project-authored bots (`<repo>/.inhuman/bots`). Overrides home / stdlib. */
  @state.childRecord accessor bots: Record<string, BotSpec> = {};
  @state.childRecord accessor commands: Record<string, CommandSpec> = {};
  @state.childRecord accessor actions: Record<string, ActionSpec> = {};
  /** Project-scope roster: recipe name → bot `sessionId`. */
  @state.record accessor botsRoster: Record<string, string> = {};
  /** Conversations. Key = `sessionId`. Value is membership (`""`). Not the bot roster. */
  @state.record accessor sessions: Record<string, ""> = {};

  constructor(
    opts?:
      | symbol
      | {
          path?: string;
          defaultPermissionMode?: PermissionMode | "";
          authorizationJson?: string;
          trusted?: boolean;
          contentHash?: string;
          kvs?: Record<string, string>;
          lastUsedConnectionModel?: Record<string, string>;
          bots?: Record<string, BotSpec>;
          commands?: Record<string, CommandSpec>;
          actions?: Record<string, ActionSpec>;
          botsRoster?: Record<string, string>;
          sessions?: Record<string, "">;
        },
  ) {
    super(opts);
  }
}
